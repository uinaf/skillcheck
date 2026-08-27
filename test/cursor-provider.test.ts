import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import CursorAgentProvider, { foldLine, newStreamState } from "../src/cursor-provider.ts";

const skillRead = (p: string): string =>
  JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "tool_1",
    tool_call: { readToolCall: { args: { path: p } } },
  });

const result = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "BANANA-7742",
  usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0 },
});

test("foldLine: skill reads, result, and noise", () => {
  const state = newStreamState();
  foldLine(state, "not json at all");
  foldLine(state, JSON.stringify({ type: "thinking", subtype: "delta", text: "hm" }));
  foldLine(state, skillRead("/run/workdir/.cursor/skills/demo/SKILL.md"));
  foldLine(state, skillRead("/run/workdir/src/index.ts")); // ordinary read, not a skill
  foldLine(state, skillRead("/run/workdir/.cursor/skills/demo/references/deep.md")); // not SKILL.md
  foldLine(state, result);

  assert.deepEqual(state.skillCalls, [
    { name: "demo", source: "project", path: "/run/workdir/.cursor/skills/demo/SKILL.md" },
  ]);
  assert.equal(state.result, "BANANA-7742");
  assert.equal(state.isError, false);
  assert.deepEqual(state.tokenUsage, { prompt: 100, completion: 40, cached: 60, total: 140 });
});

test("foldLine: completed tool_call events do not double-count a skill", () => {
  const state = newStreamState();
  foldLine(state, skillRead("/w/.cursor/skills/demo/SKILL.md"));
  foldLine(
    state,
    JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      tool_call: { readToolCall: { args: { path: "/w/.cursor/skills/demo/SKILL.md" } } },
    }),
  );
  assert.equal(state.skillCalls.length, 1);
});

test("foldLine: an error result is an error, not output", () => {
  const state = newStreamState();
  foldLine(state, JSON.stringify({ type: "result", subtype: "error", result: "boom" }));
  assert.equal(state.isError, true);
  assert.equal(state.result, "boom");
});

function stubBinary(dir: string, lines: string[], exitCode = 0): string {
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(transcript, lines.join("\n") + "\n");
  const bin = path.join(dir, "fake-cursor-agent");
  // `cat` consumes stdin so the prompt write never hits EPIPE.
  fs.writeFileSync(
    bin,
    `#!/bin/sh\ncat > "${dir}/prompt.txt"\ncat "${transcript}"\nexit ${exitCode}\n`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("callApi: replayed transcript yields output, usage, and skillCalls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-cursor-"));
  const provider = new CursorAgentProvider({
    id: "cursor-agent-test",
    config: {
      working_dir: dir,
      command: stubBinary(dir, [skillRead("/w/.cursor/skills/demo/SKILL.md"), result]),
    },
  });
  assert.equal(provider.id(), "cursor-agent-test");
  const r = await provider.callApi("squawk-test");
  assert.equal(r.output, "BANANA-7742");
  assert.equal(r.error, undefined);
  assert.deepEqual(
    r.metadata?.skillCalls.map((s) => s.name),
    ["demo"],
  );
  assert.deepEqual(r.tokenUsage, { prompt: 100, completion: 40, cached: 60, total: 140 });
  assert.equal(fs.readFileSync(path.join(dir, "prompt.txt"), "utf8"), "squawk-test");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("callApi: a run with no result event is an error, never a graded output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-cursor-"));
  const provider = new CursorAgentProvider({
    config: {
      working_dir: dir,
      command: stubBinary(dir, ['{"type":"system","subtype":"init"}'], 7),
    },
  });
  const r = await provider.callApi("hello");
  assert.equal(r.output, undefined);
  assert.match(r.error ?? "", /exited 7 without a result event/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("callApi: a missing binary reports a spawn error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-cursor-"));
  const provider = new CursorAgentProvider({
    config: { working_dir: dir, command: path.join(dir, "does-not-exist") },
  });
  const r = await provider.callApi("hello");
  assert.match(r.error ?? "", /failed to spawn/);
  fs.rmSync(dir, { recursive: true, force: true });
});
