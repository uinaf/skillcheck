import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
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

function nodeBinary(dir: string, source: string): string {
  const bin = path.join(dir, "fake-cursor-agent");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}\nsetTimeout(() => process.exit(0), 4000);\n${source}\n`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

async function fixture(
  source: string,
  run: (provider: CursorAgentProvider, dir: string) => Promise<void>,
  timeout = 2_000,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-cursor-"));
  const provider = new CursorAgentProvider({
    config: { working_dir: dir, command: nodeBinary(dir, source), timeout_ms: timeout },
  });
  try {
    await run(provider, dir);
  } finally {
    // Even a failed assertion leaves no long-lived fixture: all helper programs
    // expire themselves, so cleanup never signals a potentially reused PID.
    if (fs.existsSync(path.join(dir, "helper.pid"))) {
      const pid = Number(fs.readFileSync(path.join(dir, "helper.pid"), "utf8"));
      await waitFor(() => !running(pid), 5_000);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture did not finish before its deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function running(pid: number): boolean {
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return (
    status.status === 0 && status.stdout.trim() !== "" && !status.stdout.trim().startsWith("Z")
  );
}

const helper = (detached = false) => `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 4000)'], {
  detached: ${detached}, stdio: ['ignore', 'inherit', 'inherit']
});
fs.writeFileSync('helper.pid', String(helper.pid));
`;
const emitResult = `process.stdout.write(${JSON.stringify(result)});`;

for (const code of [0, 7]) {
  test(`callApi: final unterminated result requires observed exit zero (${code})`, async () => {
    await fixture(
      `process.stdin.resume(); process.stdin.on('end', () => { ${emitResult} process.exit(${code}); });`,
      async (provider) => {
        const response = await provider.callApi("synthetic prompt");
        if (code === 0) assert.equal(response.output, "BANANA-7742");
        else {
          assert.equal(response.output, undefined);
          assert.match(response.error ?? "", /exited 7/);
          assert.equal(response.tokenUsage?.total, 140);
        }
      },
    );
  });
}

test("callApi: protocol failure stays a failure after clean exit", async () => {
  await fixture(
    `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('${JSON.stringify({ type: "result", subtype: "error", result: "synthetic protocol failure" })}'); process.exit(0); });`,
    async (provider) => {
      const response = await provider.callApi("prompt");
      assert.equal(response.error, "synthetic protocol failure");
      assert.equal(response.output, undefined);
    },
  );
});

test("callApi: timeout stops the owned helper before settling", async () => {
  await fixture(
    `${helper()} process.stdin.resume();`,
    async (provider, dir) => {
      const response = await provider.callApi("prompt");
      assert.match(response.error ?? "", /timed out after 500ms/);
      const pid = Number(fs.readFileSync(path.join(dir, "helper.pid"), "utf8"));
      await waitFor(() => !running(pid));
    },
    500,
  );
});

test("callApi: harness exit still cleans its inherited helper group", async () => {
  await fixture(
    `${helper()} process.stdin.resume(); process.stdin.on('end', () => { ${emitResult} process.exit(0); });`,
    async (provider, dir) => {
      const response = await provider.callApi("prompt");
      assert.equal(response.output, "BANANA-7742");
      const pid = Number(fs.readFileSync(path.join(dir, "helper.pid"), "utf8"));
      await waitFor(() => !running(pid));
    },
  );
});

test("callApi: escaped helper retaining pipes fails bounded draining", async () => {
  await fixture(
    `${helper(true)} process.stdin.resume(); process.stdin.on('end', () => { ${emitResult} process.exit(0); });`,
    async (provider) => {
      const started = Date.now();
      const response = await provider.callApi("prompt");
      assert.equal(response.output, undefined);
      assert.match(response.error ?? "", /cleanup or pipe draining timed out/);
      assert.ok(Date.now() - started < 3_500);
    },
    800,
  );
}, 7_000);

test("callApi: a closed harness stdin reports failure without an unhandled error", async () => {
  await fixture(
    `require('node:fs').closeSync(0); ${emitResult} setTimeout(() => process.exit(0), 150);`,
    async (provider) => {
      const response = await provider.callApi("x".repeat(2_000_000));
      assert.equal(response.output, undefined);
      assert.match(response.error ?? "", /stdin failed/);
    },
  );
});

test("callApi: unexpected supervisor death cannot grade a result", async () => {
  await fixture(
    `process.stdin.resume(); process.stdin.on('end', () => { ${emitResult} process.kill(process.ppid, 'SIGKILL'); process.exit(0); });`,
    async (provider) => {
      const response = await provider.callApi("prompt");
      assert.equal(response.output, undefined);
      assert.match(response.error ?? "", /supervisor.*(disconnected|cleanup)/);
    },
  );
});

test("supervisor: parent death cleans the owned helper group", async () => {
  await fixture(`${helper()} process.stdin.resume();`, async (_provider, dir) => {
    const script = path.join(dir, "parent.mjs");
    const providerUrl = new URL("../src/cursor-provider.ts", import.meta.url).href;
    fs.writeFileSync(
      script,
      `import Provider from ${JSON.stringify(providerUrl)}; await new Provider({ config: { working_dir: ${JSON.stringify(dir)}, command: ${JSON.stringify(path.join(dir, "fake-cursor-agent"))}, timeout_ms: 3000 } }).callApi('prompt');`,
    );
    const parent = spawn(process.execPath, [script], { stdio: "ignore" });
    const exited = new Promise((resolve) => parent.on("close", resolve));
    try {
      await waitFor(() => fs.existsSync(path.join(dir, "helper.pid")));
      parent.kill("SIGKILL");
      await exited;
      const pid = Number(fs.readFileSync(path.join(dir, "helper.pid"), "utf8"));
      await waitFor(() => !running(pid));
    } finally {
      parent.kill("SIGKILL");
      await exited;
    }
  });
});

test("callApi: failed exit survives the separate pipe-drain deadline", async () => {
  await fixture(
    `${helper(true)} process.stdin.resume(); process.stdin.on('end', () => { ${emitResult} process.exit(7); });`,
    async (provider) => {
      const response = await provider.callApi("prompt");
      assert.equal(response.output, undefined);
      assert.match(response.error ?? "", /exited 7; cleanup or pipe draining timed out/);
      assert.doesNotMatch(response.error ?? "", /timed out after 800ms/);
    },
    800,
  );
}, 7_000);

test("callApi: a signal exit cannot grade a successful result", async () => {
  await fixture(
    `process.stdin.resume(); process.stdin.on('end', () => { ${emitResult} process.kill(process.pid, 'SIGTERM'); });`,
    async (provider) => {
      const response = await provider.callApi("prompt");
      assert.equal(response.output, undefined);
      assert.match(response.error ?? "", /exited SIGTERM/);
    },
  );
});

test("callApi: clean exit without a result is a protocol failure", async () => {
  await fixture(
    `process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`,
    async (provider) => {
      const response = await provider.callApi("prompt");
      assert.equal(response.output, undefined);
      assert.match(response.error ?? "", /exited 0 without a result event/);
    },
  );
});

test("supervisor: watchdog cleans helpers when the parent sends no timeout request", async () => {
  await fixture(`${helper()} process.stdin.resume();`, async (_provider, dir) => {
    const supervisor = fork(new URL("../src/cursor-process.ts", import.meta.url), {
      execArgv: [],
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const messages: unknown[] = [];
    supervisor.on("message", (message) => messages.push(message));
    const exited = new Promise((resolve) => supervisor.on("close", resolve));
    try {
      supervisor.send({
        command: path.join(dir, "fake-cursor-agent"),
        args: [],
        cwd: dir,
        timeoutMs: 100,
      });
      supervisor.stdin?.end("prompt");
      await exited;
      assert.deepEqual(messages, [
        { type: "failure", error: "cursor-agent supervisor watchdog timed out" },
      ]);
      const pid = Number(fs.readFileSync(path.join(dir, "helper.pid"), "utf8"));
      await waitFor(() => !running(pid));
    } finally {
      if (supervisor.connected) supervisor.disconnect();
      await exited;
    }
  });
});
