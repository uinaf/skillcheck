// promptfoo loads this Cursor Agent provider by file URL. One call is one
// stream-json run; result and SKILL.md read events are its output contract.

import { fork } from "node:child_process";
import path from "node:path";

interface CursorProviderConfig {
  working_dir: string;
  model?: string; // omitted = the Cursor CLI default ("auto")
  command?: string; // binary override, used by tests
  timeout_ms?: number;
}

interface SkillCall {
  name: string;
  source: string;
  path: string;
}

interface TokenUsage {
  total: number;
  prompt: number;
  completion: number;
  cached: number;
}

export interface StreamState {
  result?: string;
  isError: boolean;
  skillCalls: SkillCall[];
  tokenUsage?: TokenUsage;
}

export function newStreamState(): StreamState {
  return { isError: false, skillCalls: [] };
}

const SKILL_MD = /(?:^|\/)\.cursor\/skills\/([^/]+)\/SKILL\.md$/;

// Fold one stream-json line into the run state. Anything unparseable or
// unknown (thinking deltas, init, UI noise) is deliberately ignored: the
// verdict only needs the final result and the skill-read evidence.
export function foldLine(state: StreamState, line: string): void {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof event !== "object" || event === null) return;
  const e = event as {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    tool_call?: { readToolCall?: { args?: { path?: string } } };
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
    };
  };

  if (e.type === "tool_call" && e.subtype === "started") {
    const p = e.tool_call?.readToolCall?.args?.path;
    const m = typeof p === "string" ? SKILL_MD.exec(p) : null;
    if (m) state.skillCalls.push({ name: m[1], source: "project", path: p as string });
    return;
  }

  if (e.type === "result") {
    state.isError = e.is_error === true || e.subtype !== "success";
    state.result = typeof e.result === "string" ? e.result : "";
    if (e.usage) {
      const prompt = e.usage.inputTokens ?? 0;
      const completion = e.usage.outputTokens ?? 0;
      state.tokenUsage = {
        prompt,
        completion,
        cached: e.usage.cacheReadTokens ?? 0,
        total: prompt + completion,
      };
    }
  }
}

interface ProviderResponse {
  output?: string;
  error?: string;
  tokenUsage?: TokenUsage;
  metadata?: { skillCalls: SkillCall[] };
}

export default class CursorAgentProvider {
  private readonly providerId: string;
  private readonly config: CursorProviderConfig;

  constructor(options: { id?: string; config?: CursorProviderConfig }) {
    this.providerId = options.id ?? "cursor-agent";
    if (options.config?.working_dir === undefined)
      throw new Error("cursor-agent provider requires config.working_dir");
    this.config = options.config;
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    const command = this.config.command ?? "cursor-agent";
    // Print mode refuses fresh scratch directories unless they are trusted.
    const args = ["-p", "--trust", "--output-format", "stream-json"];
    if (this.config.model !== undefined) args.push("--model", this.config.model);

    const state = newStreamState();
    const stderr: string[] = [];
    let stdoutBuf = "";

    return new Promise((resolve) => {
      const timeoutMs = this.config.timeout_ms ?? 900_000;
      const supervisor = fork(
        new URL(`./cursor-process${path.extname(import.meta.url)}`, import.meta.url),
        {
          execArgv: [],
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        },
      );
      let failure: string | undefined;
      let terminal: { code: number | null; signal: string | null } | undefined;
      let cleanupConfirmed = false;
      let settled = false;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (closed: boolean, signal: string | null = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(cleanupTimer);
        supervisor.stdin?.destroy();
        supervisor.stdout?.destroy();
        supervisor.stderr?.destroy();
        if (!closed) {
          // Only this live ChildProcess handle may be killed from the parent.
          // A saved process-group ID can name unrelated processes after reaping.
          supervisor.kill("SIGKILL");
          supervisor.unref();
          if (supervisor.connected) supervisor.disconnect();
        }
        if (stdoutBuf !== "") foldLine(state, stdoutBuf);
        const metadata = { skillCalls: state.skillCalls };
        const fail = (error: string) => resolve({ error, tokenUsage: state.tokenUsage, metadata });
        if (failure !== undefined) {
          const tail = stderr.join("").trim().slice(-2000);
          const missingResult =
            terminal !== undefined && state.result === undefined ? " without a result event" : "";
          return fail(`${failure}${missingResult}${tail === "" ? "" : `: ${tail}`}`);
        }
        if (
          !closed ||
          !cleanupConfirmed ||
          terminal === undefined ||
          (process.platform !== "win32" && signal !== "SIGKILL")
        ) {
          return fail("cursor-agent supervisor ended without confirmed cleanup");
        }
        if (terminal.code !== 0 || terminal.signal !== null || state.result === undefined) {
          const tail = stderr.join("").trim().slice(-2000);
          return fail(
            `cursor-agent exited ${terminal.signal ?? terminal.code ?? "without status"}${state.result === undefined ? " without a result event" : ""}${tail === "" ? "" : `: ${tail}`}`,
          );
        }
        if (state.isError) return fail(state.result || "cursor-agent reported an error result");
        resolve({ output: state.result, tokenUsage: state.tokenUsage, metadata });
      };
      const boundCleanup = () => {
        cleanupTimer ??= setTimeout(() => {
          failure =
            failure === undefined
              ? "cursor-agent cleanup or pipe draining timed out"
              : `${failure}; cleanup or pipe draining timed out`;
          finish(false);
        }, 2_000);
      };
      const stop = (error: string) => {
        if (settled) return;
        failure ??= error;
        boundCleanup();
        if (supervisor.connected) supervisor.send("stop", () => {});
      };
      const timer = setTimeout(
        () => stop(`cursor-agent timed out after ${timeoutMs}ms`),
        timeoutMs,
      );
      supervisor.on("error", (err) => stop(`cursor-agent supervisor failed: ${err.message}`));
      supervisor.on("disconnect", () => {
        if (!cleanupConfirmed && !settled)
          stop("cursor-agent supervisor disconnected before cleanup");
      });
      supervisor.on("message", (message: unknown) => {
        if (settled) return;
        if (typeof message !== "object" || message === null) return;
        if (!("type" in message)) return;
        if (
          message.type === "terminal" &&
          "code" in message &&
          "signal" in message &&
          (message.code === null || typeof message.code === "number") &&
          (message.signal === null || typeof message.signal === "string")
        ) {
          terminal = { code: message.code, signal: message.signal };
          clearTimeout(timer);
          if (terminal.code !== 0 || terminal.signal !== null) {
            failure ??= `cursor-agent exited ${terminal.signal ?? terminal.code ?? "without status"}`;
          }
          boundCleanup();
          supervisor.send("cleanup", (err) => {
            if (err) stop(`cursor-agent cleanup request failed: ${err.message}`);
          });
        } else if (
          message.type === "failure" &&
          "error" in message &&
          typeof message.error === "string"
        ) {
          stop(message.error);
        } else if (message.type === "cleanup" && terminal !== undefined) {
          cleanupConfirmed = true;
        }
      });
      supervisor.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) foldLine(state, line);
      });
      supervisor.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
      supervisor.stdout?.on("error", (err) => stop(`cursor-agent stdout failed: ${err.message}`));
      supervisor.stderr?.on("error", (err) => stop(`cursor-agent stderr failed: ${err.message}`));
      supervisor.stdin?.on("error", (err) => stop(`cursor-agent stdin failed: ${err.message}`));
      supervisor.on("close", (_code, signal) => finish(true, signal));
      supervisor.send({ command, args, cwd: this.config.working_dir, timeoutMs }, (err) => {
        if (err) stop(`cursor-agent supervisor initialization failed: ${err.message}`);
      });
      supervisor.stdin?.end(prompt);
    });
  }
}
