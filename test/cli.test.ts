// Unit tests for the pure seams — flag parsing, root resolution, run naming,
// scorecard reduction — plus an end-to-end exercise of `skillcheck lint`
// against the fixture trees. Run: npm test (node --test; no framework).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs, parseMaxTurns, reduceResults, resolveRoot, stateDirs, toolVersion } from "../src/cli.ts";
import { runNameFor } from "../src/scenario.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const fixtures = path.join(here, "fixtures");

test("parseArgs: positionals, value flags, booleans", () => {
  const { positional, flags } = parseArgs(["dir", "--agent", "m1", "--judge", "m2", "--harness", "codex", "--all"]);
  assert.deepEqual(positional, ["dir"]);
  assert.equal(flags.get("--agent"), "m1");
  assert.equal(flags.get("--judge"), "m2");
  assert.equal(flags.get("--harness"), "codex");
  assert.equal(flags.get("--all"), true);
});

test("parseArgs: a flag cannot consume a following flag as its value", () => {
  assert.throws(() => parseArgs(["--agent", "--all"]), /--agent needs a value/);
  assert.throws(() => parseArgs(["--judge"]), /--judge needs a value/);
  assert.throws(() => parseArgs(["--root"]), /--root needs a value/);
});

test("parseArgs: unknown flags are rejected", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown flag: --nope/);
});

test("resolveRoot: defaults to cwd, --root overrides and is absolutized", () => {
  assert.equal(resolveRoot(new Map()), process.cwd());
  assert.equal(resolveRoot(new Map([["--root", "/tmp/some-repo"]])), "/tmp/some-repo");
  assert.equal(resolveRoot(new Map([["--root", "."]])), process.cwd());
  assert.equal(resolveRoot(parseArgs(["--root", "/tmp/x"]).flags), "/tmp/x");
});

test("stateDirs: run state hangs off the root, never off the install", () => {
  const d = stateDirs("/tmp/repo");
  assert.equal(d.results, "/tmp/repo/.skillcheck/results");
  assert.equal(d.scratch, "/tmp/repo/.skillcheck/scratch");
  assert.equal(d.scorecards, "/tmp/repo/.skillcheck/scorecards");
});

test("toolVersion: reads the installed package version", () => {
  assert.match(toolVersion(), /^\d+\.\d+\.\d+/);
});

test("runNameFor: harness-aware result names", () => {
  const dir = "/repo/skills/slopspec/evals/single-item-minimality";
  assert.equal(runNameFor(dir, "claude"), "slopspec--single-item-minimality");
  assert.equal(runNameFor(dir, "codex"), "slopspec--single-item-minimality--codex");
  assert.throws(() => runNameFor("/repo/not-a-scenario", "claude"), /not a scenario dir/);
});

function writeResult(dir: string, name: string, score: number, success: boolean, sha?: string): void {
  const result = {
    results: { results: [{ score, success, latencyMs: 1200, tokenUsage: { total: 100, assertions: { total: 40 } } }] },
    config: {
      providers: [{ config: { model: "agent-model" } }],
      defaultTest: { options: { provider: "anthropic:messages:judge-model" } },
    },
  };
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(result));
  if (sha !== undefined) {
    fs.writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify({ skills_tree_sha: sha }));
  }
}

test("reduceResults: valid, malformed, and unattested results", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-test-"));
  writeResult(dir, "skillx--scen-a", 0.9, true, "sha1");
  writeResult(dir, "skillx--scen-b--codex", 0.4, false); // no sidecar → unattested... but mixed with sha1
  fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
  fs.writeFileSync(path.join(dir, "not-a-result.json"), JSON.stringify({ foo: 1 }));

  // sha1 + unattested = mixed → throws without allowMixed
  assert.throws(() => reduceResults(dir, false), /multiple skills-tree revisions/);

  const mixed = reduceResults(dir, true);
  assert.equal(mixed.treeSha, "mixed");
  assert.deepEqual(mixed.skipped.sort(), ["broken.json", "not-a-result.json"]);
  assert.equal(mixed.entries.length, 2);

  const a = mixed.entries.find((e) => e.scenario === "scen-a");
  assert.deepEqual(a, {
    skill: "skillx",
    scenario: "scen-a",
    harness: "claude",
    skills_tree_sha: "sha1",
    score: 0.9,
    pass: true,
    agent_model: "agent-model",
    judge_model: "judge-model",
    latency_ms: 1200,
    tokens: 140,
  });
  const b = mixed.entries.find((e) => e.scenario === "scen-b");
  assert.equal(b?.harness, "codex");
  assert.equal(b?.skills_tree_sha, "unattested");

  // Uniform shas reduce cleanly without allowMixed
  fs.writeFileSync(path.join(dir, "skillx--scen-b--codex.meta.json"), JSON.stringify({ skills_tree_sha: "sha1" }));
  const uniform = reduceResults(dir, false);
  assert.equal(uniform.treeSha, "sha1");
  assert.equal(uniform.entries.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("reduceResults: empty directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-test-"));
  const r = reduceResults(dir, false);
  assert.equal(r.treeSha, "none");
  assert.deepEqual(r.entries, []);
  assert.deepEqual(r.skipped, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseMaxTurns validates values", () => {
  assert.equal(parseMaxTurns("80"), 80);
  assert.throws(() => parseMaxTurns("abc"));
  assert.throws(() => parseMaxTurns("-3"));
  assert.throws(() => parseMaxTurns("Infinity"));
  assert.throws(() => parseMaxTurns("2.5"));
});

function runCli(args: string[], cwd?: string): { rc: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  return { rc: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

test("lint: clean fixture tree passes, dot-dirs are not packages", () => {
  const r = runCli(["lint", path.join(fixtures, "clean")]);
  assert.equal(r.rc, 0, r.stderr);
  assert.match(r.stdout, /skill lint: 2 package\(s\) clean/);
});

test("lint: broken fixture tree fails with each finding named", () => {
  const r = runCli(["lint", path.join(fixtures, "broken")]);
  assert.equal(r.rc, 1);
  assert.match(r.stderr, /unknown frontmatter key: category/);
  assert.match(r.stderr, /frontmatter name "mismatched" != directory wrongname/);
  assert.match(r.stderr, /disable-model-invocation must be the literal boolean true/);
  assert.match(r.stderr, /link target does not exist: does-not-exist\.md/);
  assert.match(r.stderr, /skill lint: 4 error\(s\) across 1 package\(s\)/);
  // Every finding is named relative to the linted root, not by absolute path.
  const findings = r.stderr.trim().split("\n").slice(0, -1);
  assert.equal(findings.length, 4);
  for (const line of findings) assert.match(line, /^skills\/wrongname\/SKILL\.md: \S/);
});

test("lint: --root is equivalent to the positional root", () => {
  const positional = runCli(["lint", path.join(fixtures, "clean")]);
  const flagged = runCli(["lint", "--root", path.join(fixtures, "clean")]);
  assert.equal(flagged.rc, 0, flagged.stderr);
  assert.equal(flagged.stdout, positional.stdout);
});

test("lint: with no root, the current directory is the root", () => {
  const r = runCli(["lint"], path.join(fixtures, "clean"));
  assert.equal(r.rc, 0, r.stderr);
  assert.match(r.stdout, /skill lint: 2 package\(s\) clean/);
});

test("lint: a root with no skills tree lints nothing and passes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-empty-"));
  const r = runCli(["lint", dir]);
  assert.equal(r.rc, 0, r.stderr);
  assert.match(r.stdout, /skill lint: 0 package\(s\) clean/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression: npm installs the bin as a symlink into node_modules/.bin, which
// used to defeat the entrypoint check and turn the whole CLI into a silent
// exit-0 no-op. Both the source and the built copy must survive that.
for (const entry of ["src/cli.ts", "dist/cli.js"]) {
  test(`cli: invoked through a symlink, ${entry} still runs`, () => {
    const target = path.join(here, "..", entry);
    if (!fs.existsSync(target)) return; // dist is built by `npm run build`
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-bin-"));
    const link = path.join(dir, "skillcheck");
    fs.symlinkSync(target, link);
    const r = spawnSync(process.execPath, [link, "lint", path.join(fixtures, "clean")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /skill lint: 2 package\(s\) clean/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("cli: unknown subcommands and stray lint arguments exit 1", () => {
  assert.equal(runCli(["nope"]).rc, 1);
  assert.match(runCli(["nope"]).stderr, /usage: skillcheck <lint\|run\|sweep\|summarize>/);
  assert.equal(runCli(["lint", "a", "b"]).rc, 1);
  assert.equal(runCli(["lint", "--bogus"]).rc, 1);
});
