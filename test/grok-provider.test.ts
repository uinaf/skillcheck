import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import GrokProvider from "../src/grok-provider.ts";

function fixture(events: object[] | ((skillFile: string) => object[])): {
  dir: string;
  command: string;
  skillFile: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-grok-provider-"));
  const skillFile = path.join(dir, ".grok", "skills", "signal", "SKILL.md");
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, "---\nname: signal\n---\n");
  const command = path.join(dir, "fake-grok");
  fs.writeFileSync(
    command,
    `#!${process.execPath}\nfor (const event of ${JSON.stringify(typeof events === "function" ? events(skillFile) : events)}) process.stdout.write(JSON.stringify(event) + '\\n');\n`,
  );
  fs.chmodSync(command, 0o755);
  return { dir, command, skillFile };
}

test("Grok provider reports a completed native skill read", async () => {
  const fixtureRun = fixture((skillFile) => [
    {
      type: "tool_call",
      toolCallId: "read-1",
      toolName: "read_file",
      rawInput: { target_file: skillFile },
    },
    { type: "tool_call_update", toolCallId: "read-1", status: "completed" },
    { type: "text", data: "BLUE" },
    { type: "text", data: "-ORBIT" },
    {
      type: "end",
      stopReason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cache_read_input_tokens: 10,
      },
      total_cost_usd: 0.01,
    },
  ]);
  try {
    const result = await new GrokProvider({
      config: { working_dir: fixtureRun.dir, skill: "signal", command: fixtureRun.command },
    }).callApi("Use the signal skill");
    assert.deepEqual(result, {
      output: "BLUE-ORBIT",
      metadata: {
        skillCalls: [{ name: "signal", source: "project", path: fixtureRun.skillFile }],
      },
      tokenUsage: { prompt: 100, completion: 20, total: 120, cached: 10 },
      cost: 0.01,
    });
  } finally {
    fs.rmSync(fixtureRun.dir, { recursive: true, force: true });
  }
});

test("Grok provider does not count failed or out-of-workdir reads", async () => {
  const fixtureRun = fixture([
    {
      type: "tool_call",
      toolCallId: "failed",
      toolName: "read_file",
      rawInput: { target_file: "./.grok/skills/signal/SKILL.md" },
    },
    { type: "tool_call_update", toolCallId: "failed", status: "failed" },
    {
      type: "tool_call",
      toolCallId: "outside",
      toolName: "read_file",
      rawInput: { target_file: "/tmp/elsewhere/SKILL.md" },
    },
    { type: "tool_call_update", toolCallId: "outside", status: "completed" },
    { type: "text", data: "done" },
    { type: "end", stopReason: "end_turn" },
  ]);
  try {
    const result = await new GrokProvider({
      config: { working_dir: fixtureRun.dir, skill: "signal", command: fixtureRun.command },
    }).callApi("task");
    assert.deepEqual(result, { output: "done", metadata: { skillCalls: [] } });
  } finally {
    fs.rmSync(fixtureRun.dir, { recursive: true, force: true });
  }
});

test("Grok provider treats an incomplete turn as an error", async () => {
  const fixtureRun = fixture([{ type: "end", stopReason: "cancelled" }]);
  try {
    const result = await new GrokProvider({
      config: { working_dir: fixtureRun.dir, skill: "signal", command: fixtureRun.command },
    }).callApi("task");
    assert.match(result.error ?? "", /grok stopped with cancelled/);
  } finally {
    fs.rmSync(fixtureRun.dir, { recursive: true, force: true });
  }
});

for (const stdio of ["ignore", "inherit"] as const)
  test(`Grok provider stops helpers with ${stdio} stdio`, async () => {
    if (process.platform === "win32") return;
    const fixtureRun = fixture([]);
    const pidFile = path.join(fixtureRun.dir, "helper.pid");
    fs.writeFileSync(
      fixtureRun.command,
      `#!${process.execPath}\nconst { spawn } = require("node:child_process");\nconst fs = require("node:fs");\nconst helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ${JSON.stringify(stdio)} });\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));\nhelper.unref();\nprocess.stdout.write(JSON.stringify({ type: "end", stopReason: "end_turn" }) + "\\n");\n`,
    );
    let helperPid: number | undefined;
    try {
      const result = await new GrokProvider({
        config: {
          working_dir: fixtureRun.dir,
          skill: "signal",
          command: fixtureRun.command,
          timeout_ms: 1_000,
        },
      }).callApi("task");
      assert.equal(result.error, undefined);
      helperPid = Number(fs.readFileSync(pidFile, "utf8"));
      let alive = true;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          process.kill(helperPid, 0);
        } catch {
          alive = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(alive, false, "a successful run must not leave its helper alive");
    } finally {
      if (helperPid !== undefined) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {
          // The provider already stopped it.
        }
      }
      fs.rmSync(fixtureRun.dir, { recursive: true, force: true });
    }
  });
