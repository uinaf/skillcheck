import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

test("packed CLI installs without eval peers and lints", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-consumer-"));

  try {
    const packed = run("npm", ["pack", "--ignore-scripts", "--pack-destination", temp], root);
    assert.equal(packed.status, 0, packed.stderr);

    const tarballs = fs.readdirSync(temp).filter((file) => file.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const tarball = path.join(temp, tarballs[0]);
    const consumer = path.join(temp, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true}');

    const installed = run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      consumer,
    );
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(fs.existsSync(path.join(consumer, "node_modules", "promptfoo")), false);

    const linted = run(
      path.join(consumer, "node_modules", ".bin", "skillcheck"),
      ["lint", path.join(root, "test", "fixtures", "clean")],
      consumer,
    );
    assert.equal(linted.status, 0, linted.stderr);
    assert.match(linted.stdout, /skill lint: 2 package\(s\) clean/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 20_000);
