import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  classifyResult,
  mergeScorecard,
  parseArgs,
  parseMaxTurns,
  reduceResults,
  resolveRoot,
  stateDirs,
  toolVersion,
  treeShaOf,
  type ScorecardEntry,
} from "../src/cli.ts";
import {
  generateRun,
  requiredEvalPackages,
  resolvePackageDir,
  runNameFor,
  sdkNodeModulesDir,
} from "../src/scenario.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const fixtures = path.join(here, "fixtures");

test("parseArgs: positionals, value flags, booleans", () => {
  const { positional, flags } = parseArgs([
    "dir",
    "--agent",
    "m1",
    "--judge",
    "m2",
    "--harness",
    "codex",
    "--all",
  ]);
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
  const installed = JSON.parse(
    fs.readFileSync(path.join(here, "..", "package.json"), "utf8"),
  ).version;
  assert.equal(toolVersion(), installed);
});

test("runNameFor: harness-aware result names", () => {
  const dir = "/repo/skills/slopspec/evals/single-item-minimality";
  assert.equal(runNameFor(dir, "claude"), "slopspec--single-item-minimality");
  assert.equal(runNameFor(dir, "codex"), "slopspec--single-item-minimality--codex");
  assert.equal(runNameFor(dir, "cursor"), "slopspec--single-item-minimality--cursor");
  assert.throws(() => runNameFor("/repo/not-a-scenario", "claude"), /not a scenario dir/);
});

function writeResult(
  dir: string,
  name: string,
  score: number,
  success: boolean,
  sha?: string,
  judge: unknown = "anthropic:messages:judge-model",
): void {
  const result = {
    results: {
      results: [
        { score, success, latencyMs: 1200, tokenUsage: { total: 100, assertions: { total: 40 } } },
      ],
    },
    config: {
      providers: [{ config: { model: "agent-model" } }],
      defaultTest: { options: { provider: judge } },
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
  writeResult(dir, "skillx--scen-c--cursor", 0.8, true, "sha1");
  writeResult(dir, "skillx--scen-d", 0.9, true, "sha1", "openai:chat:gpt-5.6-sol");
  writeResult(dir, "skillx--scen-e", 0.9, true, "sha1", {
    id: "openai:chat:gpt-5.6-sol",
    config: { reasoning_effort: "high" },
  });
  fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
  fs.writeFileSync(path.join(dir, "not-a-result.json"), JSON.stringify({ foo: 1 }));

  assert.throws(() => reduceResults(dir, false), /multiple skills-tree revisions/);

  const mixed = reduceResults(dir, true);
  assert.equal(mixed.treeSha, "mixed");
  assert.deepEqual(mixed.skipped.sort(), ["broken.json", "not-a-result.json"]);
  assert.equal(mixed.entries.length, 5);

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
  const c = mixed.entries.find((e) => e.scenario === "scen-c");
  assert.equal(c?.harness, "cursor");
  assert.equal(c?.skill, "skillx");
  const d = mixed.entries.find((x) => x.scenario === "scen-d");
  assert.equal(d?.judge_model, "openai:chat:gpt-5.6-sol", "provider-qualified judge is verbatim");
  const e = mixed.entries.find((x) => x.scenario === "scen-e");
  assert.equal(e?.judge_model, "openai:chat:gpt-5.6-sol", "wrapped judge falls back to its id");

  fs.writeFileSync(
    path.join(dir, "skillx--scen-b--codex.meta.json"),
    JSON.stringify({ skills_tree_sha: "sha1" }),
  );
  const uniform = reduceResults(dir, false);
  assert.equal(uniform.treeSha, "sha1");
  assert.equal(uniform.entries.length, 5);

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

test("classifyResult: an errored test is never a scored FAIL", () => {
  // Shape promptfoo writes when the provider blows up: 0 pass / 0 fail / 1 error.
  const errored = {
    results: {
      results: [
        {
          score: 0,
          success: false,
          error: "Error calling Claude Agent SDK: package could not be resolved",
        },
      ],
      stats: { successes: 0, failures: 0, errors: 1 },
    },
  };
  const v = classifyResult(errored);
  assert.equal(v.score, undefined);
  assert.equal(v.pass, undefined);
  assert.match(v.error ?? "", /could not be resolved/);
});

test("classifyResult: stats-only errors, missing results, and unusable scores", () => {
  const statsOnly = {
    results: {
      results: [{ score: 0, success: false }],
      stats: { successes: 0, failures: 0, errors: 1 },
    },
  };
  assert.match(classifyResult(statsOnly).error ?? "", /nothing graded/);

  assert.match(classifyResult({ results: { results: [] } }).error ?? "", /no result/);
  assert.match(classifyResult(undefined).error ?? "", /no result/);
  assert.match(
    classifyResult({ results: { results: [{ score: "nope", success: false }] } }).error ?? "",
    /no usable score/,
  );
});

test("classifyResult: a graded fail carrying the threshold reason is FAIL, not ERROR", () => {
  // promptfoo puts a failed assert-set's reason in the error field even when
  // its stats record a graded failure.
  const gradedFail = {
    results: {
      results: [{ score: 0.62, success: false, error: "Aggregate score 0.62 < 0.7 threshold" }],
      stats: { successes: 0, failures: 1, errors: 0 },
    },
  };
  assert.deepEqual(classifyResult(gradedFail), { score: 0.62, pass: false });

  // Without stats to attest the grading, error text still wins.
  const noStats = {
    results: { results: [{ score: 0, success: false, error: "provider blew up" }] },
  };
  assert.match(classifyResult(noStats).error ?? "", /provider blew up/);
});

test("classifyResult: graded verdicts still pass through untouched", () => {
  const graded = (score: number, success: boolean) => ({
    results: {
      results: [{ score, success }],
      stats: { successes: success ? 1 : 0, failures: success ? 0 : 1, errors: 0 },
    },
  });
  assert.deepEqual(classifyResult(graded(0.91, true)), { score: 0.91, pass: true });
  assert.deepEqual(classifyResult(graded(0, false)), { score: 0, pass: false });
});

function entry(skill: string, scenario: string, score: number, sha = "sha1"): ScorecardEntry {
  return {
    skill,
    scenario,
    harness: "claude",
    skills_tree_sha: sha,
    score,
    pass: score >= 0.7,
    agent_model: "agent-model",
    judge_model: "judge-model",
    latency_ms: 1000,
    tokens: 100,
  };
}

test("mergeScorecard: a partial rerun updates its rows and carries the rest", () => {
  const existing = [entry("a", "one", 0.5), entry("b", "two", 0.9), entry("c", "three", 0.8)];
  const fresh = [entry("a", "one", 0.95)];
  const merged = mergeScorecard(existing, fresh);

  assert.equal(merged.entries.length, 3, "no committed entry may be dropped");
  assert.equal(merged.carried, 2);
  assert.equal(merged.entries.find((e) => e.skill === "a")?.score, 0.95, "the rerun wins");
  assert.equal(
    merged.entries.find((e) => e.skill === "b")?.score,
    0.9,
    "the untouched entry survives",
  );
  assert.deepEqual(
    merged.entries.map((e) => e.skill),
    ["a", "b", "c"],
    "deterministic order",
  );
});

test("mergeScorecard: harness is part of the identity, empty cases are stable", () => {
  const claude = entry("a", "one", 0.5);
  const codex: ScorecardEntry = { ...claude, harness: "codex", score: 0.6 };
  const merged = mergeScorecard([claude], [codex]);
  assert.equal(merged.entries.length, 2, "the same scenario on two harnesses are two rows");
  assert.equal(merged.carried, 1);

  assert.deepEqual(mergeScorecard([], []).entries, []);
  assert.equal(mergeScorecard([], [claude]).carried, 0);
});

test("treeShaOf: uniform, mixed, and empty", () => {
  assert.equal(treeShaOf([entry("a", "one", 0.5), entry("b", "two", 0.5)]), "sha1");
  assert.equal(treeShaOf([entry("a", "one", 0.5), entry("b", "two", 0.5, "sha2")]), "mixed");
  assert.equal(treeShaOf([]), "none");
});

test("generateRun: the scratch dir can resolve the agent SDK", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-scratch-"));
  const { name, configPath } = generateRun(
    path.join(fixtures, "clean", "skills", "demo", "evals", "basic"),
    { harness: "claude", judgeModel: "claude-opus-5" },
    {
      scratchDir: path.join(dir, "scratch"),
      transformPath: path.join(here, "..", "src", "transform.ts"),
      cursorProviderPath: path.join(here, "..", "src", "cursor-provider.ts"),
    },
  );
  assert.equal(name, "demo--basic");

  const runDir = path.dirname(configPath);
  // promptfoo resolves the provider SDK from the config's directory, which is
  // in the consumer repo and has no node_modules of its own.
  const require = createRequire(path.join(runDir, "resolver.js"));
  assert.ok(
    require.resolve("@anthropic-ai/claude-agent-sdk"),
    "agent SDK must resolve from the scratch dir",
  );
  assert.ok(fs.lstatSync(path.join(runDir, "node_modules")).isSymbolicLink());
  // codex-sdk exports no main entry, so its presence is checked by path.
  assert.ok(
    fs.existsSync(path.join(runDir, "node_modules", "@openai", "codex-sdk", "package.json")),
  );

  // The link must not leak into the graded workdir or the manifest.
  assert.equal(fs.existsSync(path.join(runDir, "workdir", "node_modules")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest).filter((k) => k.includes("node_modules")),
    [],
  );
  assert.ok(
    Object.keys(manifest).includes("note.md"),
    "embedded input files are still materialized",
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("generateRun: the cursor harness installs .cursor/skills and a file provider", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-scratch-"));
  const cursorProviderPath = path.join(here, "..", "src", "cursor-provider.ts");
  const { name, configPath } = generateRun(
    path.join(fixtures, "clean", "skills", "demo", "evals", "basic"),
    { harness: "cursor", agentModel: "composer-2.5", judgeModel: "claude-opus-5" },
    {
      scratchDir: path.join(dir, "scratch"),
      transformPath: path.join(here, "..", "src", "transform.ts"),
      cursorProviderPath,
    },
  );
  assert.equal(name, "demo--basic--cursor");

  const workdir = path.join(path.dirname(configPath), "workdir");
  // Cursor discovers .cursor/skills; the claude root must not be created.
  assert.ok(fs.existsSync(path.join(workdir, ".cursor", "skills", "demo", "SKILL.md")));
  assert.equal(fs.existsSync(path.join(workdir, ".claude")), false);
  assert.equal(
    fs.existsSync(path.join(workdir, ".cursor", "skills", "demo", "evals")),
    false,
    "criteria must not leak into the agent's context",
  );

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(config.providers, [
    {
      id: `file://${cursorProviderPath}`,
      config: { model: "composer-2.5", working_dir: workdir },
    },
  ]);

  // The installed skill copy is hashed into the manifest, so the transform
  // reports it as an unchanged input rather than agent output.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(path.dirname(configPath), "manifest.json"), "utf8"),
  );
  assert.ok(Object.keys(manifest).some((k) => k.startsWith(".cursor/skills/demo/")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("generateRun: a provider-qualified judge passes through, wrapped only for effort", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-scratch-"));
  const paths = {
    scratchDir: path.join(dir, "scratch"),
    transformPath: path.join(here, "..", "src", "transform.ts"),
    cursorProviderPath: path.join(here, "..", "src", "cursor-provider.ts"),
  };
  const scenario = path.join(fixtures, "clean", "skills", "demo", "evals", "basic");

  const plain = generateRun(
    scenario,
    { harness: "claude", judgeModel: "openai:chat:gpt-5.6-sol" },
    paths,
  );
  const plainConfig = JSON.parse(fs.readFileSync(plain.configPath, "utf8"));
  assert.equal(plainConfig.defaultTest.options.provider, "openai:chat:gpt-5.6-sol");

  const withEffort = generateRun(
    scenario,
    { harness: "claude", judgeModel: "openai:chat:gpt-5.6-sol", judgeEffort: "high" },
    paths,
  );
  const effortConfig = JSON.parse(fs.readFileSync(withEffort.configPath, "utf8"));
  assert.deepEqual(effortConfig.defaultTest.options.provider, {
    id: "openai:chat:gpt-5.6-sol",
    config: { reasoning_effort: "high" },
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test("cli: --judge-effort is validated and needs a provider-qualified judge", () => {
  const bareJudge = runCli(["run", "some-dir", "--judge-effort", "high"]);
  assert.equal(bareJudge.rc, 1);
  assert.match(bareJudge.stderr, /--judge-effort needs a provider-qualified --judge/);

  const badEffort = runCli([
    "run",
    "some-dir",
    "--judge",
    "openai:chat:gpt-5.6-sol",
    "--judge-effort",
    "extreme",
  ]);
  assert.equal(badEffort.rc, 1);
  assert.match(badEffort.stderr, /--judge-effort must be minimal, low, medium, or high/);
});

test("sdkNodeModulesDir: points at a directory that really holds both SDKs", () => {
  const dir = sdkNodeModulesDir();
  assert.ok(dir !== undefined);
  assert.equal(path.basename(dir), "node_modules");
  // Both providers must be reachable through one link. codex-sdk has no
  // resolvable main entry.
  assert.ok(fs.existsSync(path.join(dir, "@anthropic-ai", "claude-agent-sdk", "package.json")));
  assert.ok(fs.existsSync(path.join(dir, "@openai", "codex-sdk", "package.json")));
});

test("requiredEvalPackages: per-harness peers, judge leg included", () => {
  const opts = (harness: "claude" | "codex" | "cursor", judgeModel = "claude-opus-5") => ({
    harness,
    judgeModel,
  });
  // The claude agent leg always needs the agent SDK.
  assert.deepEqual(requiredEvalPackages(opts("claude"), true), [
    "promptfoo",
    "@anthropic-ai/claude-agent-sdk",
  ]);
  // A bare judge without ANTHROPIC_API_KEY grades through the agent SDK.
  assert.deepEqual(requiredEvalPackages(opts("codex"), false), [
    "promptfoo",
    "@anthropic-ai/claude-agent-sdk",
    "@openai/codex-sdk",
  ]);
  assert.deepEqual(requiredEvalPackages(opts("codex"), true), ["promptfoo", "@openai/codex-sdk"]);
  assert.deepEqual(requiredEvalPackages(opts("cursor"), false), [
    "promptfoo",
    "@anthropic-ai/claude-agent-sdk",
  ]);
  assert.deepEqual(requiredEvalPackages(opts("cursor", "openai:chat:gpt-5.6-sol"), false), [
    "promptfoo",
  ]);
});

test("resolvePackageDir: installed peers resolve, absent packages are undefined", () => {
  const dir = resolvePackageDir("promptfoo");
  assert.ok(dir !== undefined);
  assert.ok(fs.existsSync(path.join(dir, "package.json")));
  assert.equal(resolvePackageDir("@uinaf/no-such-package-ever"), undefined);
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

// npm invokes installed bins through node_modules/.bin symlinks.
for (const entry of ["src/cli.ts", "dist/cli.js"]) {
  test(`cli: invoked through a symlink, ${entry} still runs`, () => {
    const target = path.join(here, "..", entry);
    assert.equal(fs.existsSync(target), true, `${entry} must exist before the symlink smoke`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-bin-"));
    const link = path.join(dir, "skillcheck");
    fs.symlinkSync(target, link);
    const r = spawnSync(process.execPath, [link, "lint", path.join(fixtures, "clean")], {
      encoding: "utf8",
    });
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
