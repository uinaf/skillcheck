#!/usr/bin/env node
// skillcheck — lint and eval harness for agent skills. See README.md for
// usage; scenario.ts does the fixture work and lint.ts owns the lint pass.
//
//   skillcheck lint [<root>]
//   skillcheck run <scenario-dir> [--agent MODEL] [--judge MODEL] [--harness claude|codex]
//   skillcheck sweep [--all]
//   skillcheck summarize [--allow-mixed]
//
// Every subcommand resolves a root: --root <dir>, else the current directory.
// The layout contract under that root is frozen: <root>/skills/<skill>/evals/<scenario>.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintSkills } from "./lint.ts";
import { generateRun, runNameFor, type Harness, type RunOptions } from "./scenario.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
// node refuses to strip types under node_modules, so an installed copy runs the
// compiled dist. Follow this module's own extension to find its sibling.
const selfExt = path.extname(fileURLToPath(import.meta.url));

// Recorded in every result sidecar: a scorecard has to say which harness build
// produced it, not just which skills tree it graded.
export function toolVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version;
}

export function parseMaxTurns(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--max-turns must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// Throws on bad input; the CLI entrypoint catches and exits 1.
export function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const takesValue = new Set(["--root", "--agent", "--judge", "--harness", "--max-turns"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
    } else if (takesValue.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      flags.set(a, v);
    } else if (a === "--all" || a === "--allow-mixed") {
      flags.set(a, true);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return { positional, flags };
}

// The consumer repo being linted or evaluated. No configurability beyond this
// one flag: the tree layout below the root is a frozen contract.
export function resolveRoot(flags: Map<string, string | true>): string {
  return path.resolve((flags.get("--root") as string | undefined) ?? process.cwd());
}

// Run state is disposable except scorecards, and all of it belongs to the
// consumer repo, never to the installed package.
export function stateDirs(root: string): { results: string; scratch: string; scorecards: string } {
  const base = path.join(root, ".skillcheck");
  return {
    results: path.join(base, "results"),
    scratch: path.join(base, "scratch"),
    scorecards: path.join(base, "scorecards"),
  };
}

function runOptions(flags: Map<string, string | true>): RunOptions {
  const harness = (flags.get("--harness") ?? "claude") as string;
  if (harness !== "claude" && harness !== "codex") fail(`--harness must be claude or codex, got ${harness}`);
  const agent = flags.get("--agent") as string | undefined;
  return {
    harness: harness as Harness,
    // claude defaults in scenario.ts; codex undefined = current Codex CLI default
    agentModel: agent,
    judgeModel: (flags.get("--judge") as string | undefined) ?? "claude-opus-5",
    maxTurns: flags.has("--max-turns") ? parseMaxTurns(flags.get("--max-turns") as string) : undefined,
  };
}

interface RunOutcome {
  name: string;
  rc: number;
  resultPath: string;
  score?: number;
  pass?: boolean;
  error?: string;
}

export interface Verdict {
  score?: number;
  pass?: boolean;
  error?: string;
}

// A promptfoo test that errored was never graded — it carries an `error` and
// lands in stats.errors with nothing scored. Reporting that as score=0 FAIL
// would let a transport or resolution failure masquerade as a judge's verdict,
// so an errored result stays an ERROR and exits 2 per the documented contract.
export function classifyResult(raw: unknown): Verdict {
  const root = raw as
    | { results?: { results?: unknown[]; stats?: { successes?: number; failures?: number; errors?: number } } }
    | undefined;
  const res = root?.results?.results?.[0] as { error?: unknown; score?: unknown; success?: unknown } | undefined;
  if (res === undefined) return { error: "promptfoo output carried no result" };

  const message = typeof res.error === "string" ? res.error.trim() : "";
  if (message !== "") return { error: message };

  const stats = root?.results?.stats;
  if (stats !== undefined && (stats.errors ?? 0) > 0 && (stats.successes ?? 0) === 0 && (stats.failures ?? 0) === 0) {
    return { error: "promptfoo reported an errored test with nothing graded" };
  }
  if (typeof res.score !== "number" || typeof res.success !== "boolean") {
    return { error: "promptfoo result carried no usable score" };
  }
  return { score: res.score, pass: res.success };
}

function gitHead(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function metaPath(resultPath: string): string {
  return resultPath.replace(/\.json$/, ".meta.json");
}

function runScenario(scenarioDir: string, opts: RunOptions, root: string): RunOutcome {
  const dirs = stateDirs(root);
  const { name, configPath } = generateRun(path.resolve(scenarioDir), opts, {
    scratchDir: dirs.scratch,
    transformPath: path.join(here, `transform${selfExt}`),
  });
  fs.mkdirSync(dirs.results, { recursive: true });
  const resultPath = path.join(dirs.results, `${name}.json`);
  // Never let a stale result masquerade as this run's outcome.
  fs.rmSync(resultPath, { force: true });
  fs.rmSync(metaPath(resultPath), { force: true });
  const sha = gitHead(root);
  const r = spawnSync(
    "npx",
    ["promptfoo", "eval", "--no-cache", "--no-progress-bar", "-j", process.env.EVALS_CONCURRENCY ?? "4", "-c", configPath, "-o", resultPath],
    // Failing assertions exit 0 (graded FAIL is read from the result file);
    // any nonzero rc is therefore a real error. cwd is the installed package so
    // `npx promptfoo` resolves this package's own dependency.
    { cwd: packageDir, stdio: "inherit", env: { ...process.env, PROMPTFOO_FAILED_TEST_EXIT_CODE: "0" } },
  );
  const rc = r.status ?? 1; // null status (signal) counts as failure
  const outcome: RunOutcome = { name, rc, resultPath };
  if (rc !== 0) return outcome; // ERROR regardless of what's on disk

  let verdict: Verdict;
  try {
    verdict = classifyResult(JSON.parse(fs.readFileSync(resultPath, "utf8")));
  } catch {
    verdict = { error: "promptfoo produced no parseable result file" };
  }
  outcome.score = verdict.score;
  outcome.pass = verdict.pass;
  outcome.error = verdict.error;

  // Provenance is only written for a graded result: an errored run has nothing
  // to attest, and a sidecar without a score would poison the scorecard.
  if (verdict.score !== undefined) {
    fs.writeFileSync(
      metaPath(resultPath),
      JSON.stringify({ skills_tree_sha: sha, harness: opts.harness, ran_at: new Date().toISOString(), tool_version: toolVersion() }, null, 2) + "\n",
    );
  }
  return outcome;
}

function discoverScenarios(root: string): string[] {
  const roots = [path.join(root, "skills")];
  const cliDir = path.join(root, "cli");
  if (fs.existsSync(cliDir)) {
    for (const e of fs.readdirSync(cliDir, { withFileTypes: true })) {
      if (e.isDirectory()) roots.push(path.join(cliDir, e.name, "skills"));
    }
  }
  const found: string[] = [];
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const skill of fs.readdirSync(dir, { withFileTypes: true })) {
      const evalsDir = path.join(dir, skill.name, "evals");
      if (!skill.isDirectory() || !fs.existsSync(evalsDir)) continue;
      for (const sc of fs.readdirSync(evalsDir, { withFileTypes: true })) {
        const scenarioDir = path.join(evalsDir, sc.name);
        if (sc.isDirectory() && fs.existsSync(path.join(scenarioDir, "task.md")) && fs.existsSync(path.join(scenarioDir, "criteria.json"))) {
          found.push(scenarioDir);
        }
      }
    }
  }
  return found.sort();
}

function cmdRun(argv: string[]): void {
  const { positional, flags } = parseArgs(argv);
  if (positional.length !== 1) fail("usage: skillcheck run <scenario-dir> [--root DIR] [--agent MODEL] [--judge MODEL] [--harness claude|codex]");
  const o = runScenario(positional[0], runOptions(flags), resolveRoot(flags));
  if (o.score === undefined) {
    console.error(`ERROR ${o.name}: ${o.error ?? "no usable result"} (promptfoo rc=${o.rc})`);
    process.exit(2);
  }
  console.log(`${o.pass ? "PASS" : "FAIL"} ${o.name} score=${o.score.toFixed(4)} (results: ${o.resultPath})`);
  process.exit(o.pass ? 0 : 1);
}

function cmdSweep(argv: string[]): void {
  const { positional, flags } = parseArgs(argv);
  if (positional.length > 0) fail("usage: skillcheck sweep [--root DIR] [--all]");
  const root = resolveRoot(flags);
  const opts = runOptions(flags);
  const all = flags.get("--all") === true;
  const resultsDir = stateDirs(root).results;
  let passed = 0, failed = 0, errored = 0, skipped = 0;
  for (const dir of discoverScenarios(root)) {
    const name = runNameFor(dir, opts.harness);
    const resultPath = path.join(resultsDir, `${name}.json`);
    if (!all && fs.existsSync(resultPath)) {
      skipped++;
      console.log(`SKIP  ${name} (results exist; use --all to rerun)`);
      continue;
    }
    const o = runScenario(dir, opts, root);
    if (o.score === undefined) {
      errored++;
      console.log(`ERROR ${o.name} ${o.error ?? "no usable result"} (promptfoo rc=${o.rc})`);
    } else if (o.pass) {
      passed++;
      console.log(`PASS  ${o.name} score=${o.score.toFixed(4)}`);
    } else {
      failed++;
      console.log(`FAIL  ${o.name} score=${o.score.toFixed(4)}`);
    }
  }
  console.log(`\nsweep: ${passed} passed, ${failed} failed, ${errored} errored, ${skipped} skipped`);
  process.exit(errored > 0 ? 2 : failed > 0 ? 1 : 0);
}

export interface ScorecardEntry {
  skill: string;
  scenario: string;
  harness: Harness;
  skills_tree_sha: string;
  score: number;
  pass: boolean;
  agent_model: string;
  judge_model: string;
  latency_ms: number;
  tokens: number;
}

// Pure reducer over a results directory. Skips files that are not promptfoo
// results (warns to stderr, reported in `skipped`); throws on mixed
// skills-tree revisions unless allowMixed.
export function reduceResults(dir: string, allowMixed: boolean): { treeSha: string; entries: ScorecardEntry[]; skipped: string[] } {
  const entries: ScorecardEntry[] = [];
  const skipped: string[] = [];
  const shas = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json")).sort()) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      raw = undefined;
    }
    const res = raw?.results?.results?.[0];
    if (typeof res?.score !== "number" || typeof res?.success !== "boolean") {
      console.error(`skipping ${f}: not a promptfoo result`);
      skipped.push(f);
      continue;
    }
    const provider = raw.config?.providers?.[0];
    const judge = raw.config?.defaultTest?.options?.provider;
    const base = f.replace(/\.json$/, "");
    const harness: Harness = base.endsWith("--codex") ? "codex" : "claude";
    const [skill, ...rest] = base.replace(/--codex$/, "").split("--");
    // Per-result provenance from the run-time sidecar; results predating the
    // sidecar mechanism are "unattested".
    let sha = "unattested";
    try {
      sha = JSON.parse(fs.readFileSync(path.join(dir, `${base}.meta.json`), "utf8")).skills_tree_sha ?? "unattested";
    } catch {
      // no sidecar
    }
    shas.add(sha);
    entries.push({
      skill,
      scenario: rest.join("--"),
      harness,
      skills_tree_sha: sha,
      score: res.score,
      pass: res.success,
      agent_model: provider?.config?.model ?? "codex-default",
      judge_model: typeof judge === "string" ? judge.replace(/^anthropic:messages:/, "") : (judge?.config?.model ?? "unknown"),
      latency_ms: res.latencyMs,
      tokens: (res.tokenUsage?.total ?? 0) + (res.tokenUsage?.assertions?.total ?? 0),
    });
  }
  if (shas.size > 1 && !allowMixed) {
    throw new Error(`results span multiple skills-tree revisions (${[...shas].join(", ")}); rerun stale ones or pass --allow-mixed`);
  }
  const treeSha = shas.size === 1 ? [...shas][0] : shas.size === 0 ? "none" : "mixed";
  return { treeSha, entries, skipped };
}

// One scenario's identity in a scorecard. Rerunning a subset must update those
// rows and leave every other row alone.
function entryKey(e: ScorecardEntry): string {
  return [e.skill, e.scenario, e.harness].join(" ");
}

// A consumer whose results/ holds only today's rerun would otherwise overwrite
// a committed same-date scorecard with a fraction of its entries. Merge instead:
// fresh entries win, untouched ones survive.
export function mergeScorecard(existing: ScorecardEntry[], fresh: ScorecardEntry[]): { entries: ScorecardEntry[]; carried: number } {
  const byKey = new Map<string, ScorecardEntry>();
  for (const e of existing) byKey.set(entryKey(e), e);
  let carried = byKey.size;
  for (const e of fresh) {
    if (byKey.has(entryKey(e))) carried--;
    byKey.set(entryKey(e), e);
  }
  const entries = [...byKey.values()].sort((a, b) => (entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0));
  return { entries, carried };
}

export function treeShaOf(entries: ScorecardEntry[]): string {
  const shas = new Set(entries.map((e) => e.skills_tree_sha));
  return shas.size === 1 ? [...shas][0] : shas.size === 0 ? "none" : "mixed";
}

// Reads a scorecard that is about to be merged into. A same-date file that
// cannot be understood is a stop, not a licence to overwrite it.
function readExistingScorecard(out: string): ScorecardEntry[] {
  if (!fs.existsSync(out)) return [];
  let prev: unknown;
  try {
    prev = JSON.parse(fs.readFileSync(out, "utf8"));
  } catch {
    throw new Error(`existing scorecard ${out} is not valid JSON; refusing to overwrite it`);
  }
  const scenarios = (prev as { scenarios?: unknown } | undefined)?.scenarios;
  if (!Array.isArray(scenarios)) throw new Error(`existing scorecard ${out} has no scenarios array; refusing to overwrite it`);
  return scenarios as ScorecardEntry[];
}

function cmdSummarize(argv: string[]): void {
  const { positional, flags } = parseArgs(argv);
  if (positional.length > 0) fail("usage: skillcheck summarize [--root DIR] [--allow-mixed]");
  const dirs = stateDirs(resolveRoot(flags));
  if (!fs.existsSync(dirs.results)) fail(`no results directory at ${dirs.results} — run some evals first`);
  const { entries, skipped } = reduceResults(dirs.results, flags.get("--allow-mixed") === true);
  fs.mkdirSync(dirs.scorecards, { recursive: true });
  const out = path.join(dirs.scorecards, `${new Date().toISOString().slice(0, 10)}.json`);
  const existing = readExistingScorecard(out);
  const merged = mergeScorecard(existing, entries);
  const scorecard = { ran_at: new Date().toISOString(), skills_tree_sha: treeShaOf(merged.entries), scenarios: merged.entries };
  fs.writeFileSync(out, JSON.stringify(scorecard, null, 2) + "\n");
  console.log(
    `${out}: ${merged.entries.length} scenario(s), ${merged.entries.filter((e) => e.pass).length} passing, ${skipped.length} skipped file(s)`,
  );
  if (existing.length > 0) {
    console.log(`merged into today's scorecard: ${entries.length} from this run, ${merged.carried} carried over`);
  }
}

// lint takes the root as an optional positional too: `skillcheck lint <dir>` is
// the shape consumer CI reaches for first.
function cmdLint(argv: string[]): void {
  const { positional, flags } = parseArgs(argv);
  if (positional.length > 1) fail("usage: skillcheck lint [<root>] [--root DIR]");
  const root = positional.length === 1 ? path.resolve(positional[0]) : resolveRoot(flags);
  const { errors, count } = lintSkills(root);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(`skill lint: ${errors.length} error(s) across ${count} package(s)`);
    process.exit(1);
  }
  console.log(`skill lint: ${count} package(s) clean`);
}

// npm links bins as symlinks — node_modules/.bin/skillcheck points at
// ../skillcheck/dist/cli.js — so argv[1] and import.meta.url disagree on path
// for every installed copy. Comparing them raw made the installed CLI a silent
// no-op that still exited 0. Resolve both through realpath before deciding.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "run") cmdRun(rest);
    else if (cmd === "sweep") cmdSweep(rest);
    else if (cmd === "summarize") cmdSummarize(rest);
    else if (cmd === "lint") cmdLint(rest);
    else fail("usage: skillcheck <lint|run|sweep|summarize> ...");
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
