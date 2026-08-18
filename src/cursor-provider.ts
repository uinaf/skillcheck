// Promptfoo custom provider for the Cursor Agent CLI. Promptfoo ships no
// cursor provider, so the cursor harness hands the generated config a
// `file://` reference to this module; like transform.ts, the built copy must
// land in dist/ beside cli.js so that URL resolves from an installed package.
//
// One callApi = one `cursor-agent -p --output-format stream-json` run in the
// scenario workdir. The stream is the whole contract: the `result` event
// carries the final text and token usage, and `tool_call` events reading
// `.cursor/skills/<name>/SKILL.md` are the skill-used evidence promptfoo's
// assertion reads from `metadata.skillCalls`.

import { spawn } from "node:child_process";

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
    // --trust: every workdir is a fresh scratch directory the CLI has never
    // seen, and the print mode refuses untrusted directories.
    const args = ["-p", "--trust", "--output-format", "stream-json"];
    if (this.config.model !== undefined) args.push("--model", this.config.model);

    const state = newStreamState();
    const stderr: string[] = [];
    let stdoutBuf = "";

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: this.config.working_dir,
        env: process.env, // CURSOR_API_KEY / a logged-in CLI travel through env
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timeoutMs = this.config.timeout_ms ?? 900_000;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ error: `cursor-agent timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ error: `failed to spawn ${command}: ${err.message}` });
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) foldLine(state, line);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk.toString("utf8"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (stdoutBuf !== "") foldLine(state, stdoutBuf);
        if (state.result === undefined) {
          const tail = stderr.join("").trim().slice(-2000);
          resolve({
            error: `cursor-agent exited ${code ?? "by signal"} without a result event${tail === "" ? "" : `: ${tail}`}`,
          });
          return;
        }
        if (state.isError) {
          resolve({ error: state.result || "cursor-agent reported an error result" });
          return;
        }
        resolve({
          output: state.result,
          tokenUsage: state.tokenUsage,
          metadata: { skillCalls: state.skillCalls },
        });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
