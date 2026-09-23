import { spawn } from "node:child_process";
import path from "node:path";

interface GrokConfig {
  working_dir: string;
  skill: string;
  model?: string;
  command?: string;
  timeout_ms?: number;
}

interface SkillCall {
  name: string;
  source: "project";
  path: string;
}

interface GrokEvent {
  type?: string;
  data?: string;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  rawInput?: { target_file?: string };
  stopReason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

const STDERR_CAP = 4_000;
const OUTPUT_CAP = 1_000_000;

function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export default class GrokProvider {
  private readonly config: GrokConfig;

  constructor(options: { config?: GrokConfig }) {
    if (!options.config?.working_dir || !options.config.skill)
      throw new Error("grok provider requires working_dir and skill");
    this.config = options.config;
  }

  id(): string {
    return "grok:cli";
  }

  async callApi(
    prompt: string,
    _context?: unknown,
    callOptions?: { abortSignal?: AbortSignal },
  ): Promise<{
    output?: string;
    metadata?: { skillCalls: SkillCall[] };
    tokenUsage?: { prompt: number; completion: number; total: number; cached: number };
    cost?: number;
    error?: string;
  }> {
    const {
      working_dir: workdir,
      skill,
      model,
      command = "grok",
      timeout_ms = 600_000,
    } = this.config;
    const skillFile = path.join(workdir, ".grok", "skills", skill, "SKILL.md");
    const args = [
      "--trust",
      "--no-auto-update",
      "--cwd",
      workdir,
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "acceptEdits",
      "--disable-web-search",
      "--no-subagents",
      ...(model ? ["--model", model] : []),
      "-p",
      prompt,
    ];
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: workdir,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let output = "";
      let stopReason: string | undefined;
      let usage: GrokEvent["usage"];
      let cost: number | undefined;
      let error: string | undefined;
      const reads = new Map<string, string>();
      const skillCalls: SkillCall[] = [];

      const stop = (reason: string): void => {
        error ??= reason;
        if (child.pid !== undefined) {
          try {
            if (process.platform === "win32") child.kill();
            else process.kill(-child.pid, "SIGKILL");
          } catch {
            // The process may already have exited.
          }
        }
      };
      const consume = (line: string): void => {
        if (!line.trim()) return;
        let event: GrokEvent;
        try {
          event = JSON.parse(line) as GrokEvent;
        } catch {
          stop("grok emitted invalid streaming JSON");
          return;
        }
        if (event.type === "text" && typeof event.data === "string") {
          output += event.data;
          if (output.length > OUTPUT_CAP) stop("grok output exceeded limit");
        } else if (event.type === "tool_call" && event.toolName === "read_file") {
          const target = event.rawInput?.target_file;
          if (event.toolCallId && typeof target === "string") {
            const resolved = path.resolve(workdir, target);
            if (within(workdir, resolved)) reads.set(event.toolCallId, resolved);
          }
        } else if (event.type === "tool_call_update" && event.status === "completed") {
          const target = event.toolCallId && reads.get(event.toolCallId);
          if (target === skillFile && !skillCalls.some((call) => call.path === target)) {
            skillCalls.push({ name: skill, source: "project", path: target });
          }
        } else if (event.type === "end") {
          stopReason = event.stopReason;
          usage = event.usage;
          cost = event.total_cost_usd;
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > OUTPUT_CAP) {
          stop("grok event stream exceeded limit");
          return;
        }
        let newline = stdout.indexOf("\n");
        while (newline !== -1) {
          consume(stdout.slice(0, newline));
          stdout = stdout.slice(newline + 1);
          newline = stdout.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_CAP);
      });
      child.on("error", (cause) => {
        error ??= `grok could not start: ${cause.message}`;
      });
      const timer = setTimeout(() => stop(`grok timed out after ${timeout_ms}ms`), timeout_ms);
      const abort = () => stop("grok run aborted");
      callOptions?.abortSignal?.addEventListener("abort", abort, { once: true });
      if (callOptions?.abortSignal?.aborted) abort();
      child.on("exit", () => {
        // The CLI may exit while helpers remain in its detached process group.
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // The process group has already exited.
          }
        }
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        callOptions?.abortSignal?.removeEventListener("abort", abort);
        if (stdout) consume(stdout);
        if (error) resolve({ error });
        else if (code !== 0)
          resolve({ error: `grok exited ${signal ?? code}: ${stderr.trim() || "no diagnostics"}` });
        else if (stopReason !== "end_turn")
          resolve({ error: `grok stopped with ${stopReason ?? "no terminal event"}` });
        else
          resolve({
            output,
            metadata: { skillCalls },
            ...(usage
              ? {
                  tokenUsage: {
                    prompt: usage.input_tokens ?? 0,
                    completion: usage.output_tokens ?? 0,
                    total: usage.total_tokens ?? 0,
                    cached: usage.cache_read_input_tokens ?? 0,
                  },
                }
              : {}),
            ...(typeof cost === "number" ? { cost } : {}),
          });
      });
    });
  }
}
