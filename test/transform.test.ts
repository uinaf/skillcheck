import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import transform from "../src/transform.ts";

test("graded output excludes installed dependencies but includes deliverables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-transform-"));
  try {
    const workdir = path.join(dir, "workdir");
    fs.mkdirSync(path.join(workdir, "node_modules", "package"), { recursive: true });
    fs.writeFileSync(path.join(workdir, "node_modules", "package", "index.js"), "dependency");
    fs.writeFileSync(path.join(workdir, "answer.txt"), "BLUE-ORBIT");
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(manifest, "{}");

    const output = transform("done", { vars: { workdir, manifest } });
    assert.match(output, /OUTPUT FILE: answer.txt/);
    assert.match(output, /BLUE-ORBIT/);
    assert.doesNotMatch(output, /node_modules|dependency/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("graded output skips tool caches the agent's commands create", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-transform-"));
  try {
    const workdir = path.join(dir, "workdir");
    for (const cache of [".cache/npm/_cacache", ".npm/_logs", ".pnpm-store/v10"]) {
      fs.mkdirSync(path.join(workdir, cache), { recursive: true });
      fs.writeFileSync(path.join(workdir, cache, "entry"), "CACHE-BLOB".repeat(10_000));
    }
    fs.writeFileSync(path.join(workdir, "eslint.config.js"), "export default [];");
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(manifest, "{}");

    const output = transform("done", { vars: { workdir, manifest } });
    assert.match(output, /OUTPUT FILE: eslint.config.js/);
    assert.doesNotMatch(output, /CACHE-BLOB|TRUNCATED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
