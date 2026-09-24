#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintSkills } from "./lint.ts";
import {
  DEFAULT_CLAUDE_AGENT,
  encodeRunNamePart,
  generateRun,
  requiredEvalPackages,
  resolvePackageDir,
  runNameFor,
  type Harness,
  type RunOptions,
} from "./scenario.ts";

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

export function parsePositiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// Throws on bad input; the CLI entrypoint catches and exits 1.
export function parseArgs(argv: string[]): {
  positional: string[];
  flags: Map<string, string | true>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const takesValue = new Set([
    "--root",
    "--agent",
    "--judge",
    "--judge-effort",
    "--agent-effort",
    "--harness",
    "--max-turns",
    "--trials",
  ]);
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

export function runOptions(flags: Map<string, string | true>): RunOptions {
  const harness = (flags.get("--harness") ?? "claude") as string;
  if (harness !== "claude" && harness !== "codex" && harness !== "grok")
    throw new Error(`--harness must be claude, codex, or grok, got ${harness}`);
  if (flags.has("--max-turns") && harness !== "claude")
    throw new Error("--max-turns is only supported with --harness claude");
  const agentEffort = flags.get("--agent-effort") as string | undefined;
  if (agentEffort !== undefined) {
    if (harness !== "claude")
      throw new Error(
        `--agent-effort is only supported with --harness claude; ${harness} has no effort setting wired`,
      );
    if (!AGENT_EFFORTS.includes(agentEffort))
      throw new Error(`--agent-effort must be ${AGENT_EFFORTS.join(", ")}, got ${agentEffort}`);
  }
  const agent = flags.get("--agent") as string | undefined;
  const judgeModel = (flags.get("--judge") as string | undefined) ?? "claude-opus-5";
  const judgeEffort = flags.get("--judge-effort") as string | undefined;
  if (judgeEffort !== undefined) {
    // A bare Claude judge takes Claude's effort levels; a provider-qualified
    // judge takes that provider's reasoning_effort.
    const levels = judgeModel.includes(":") ? ["minimal", "low", "medium", "high"] : AGENT_EFFORTS;
    if (!levels.includes(judgeEffort))
      throw new Error(
        `--judge-effort for ${judgeModel} must be ${levels.join(", ")}, got ${judgeEffort}`,
      );
  }
  return {
    harness: harness as Harness,
    // claude defaults in scenario.ts; codex/grok undefined = that CLI's default
    agentModel: agent,
    agentEffort,
    judgeModel,
    judgeEffort,
    maxTurns: flags.has("--max-turns")
      ? parsePositiveInt("--max-turns", flags.get("--max-turns") as string)
      : undefined,
    trials: flags.has("--trials")
      ? parsePositiveInt("--trials", flags.get("--trials") as string)
      : 1,
  };
}

// What a result was measured with. Scores from different configurations are
// not comparable, so sweep reruns on a change and summarize refuses to merge.
export interface RunConfig {
  agent_model: string;
  agent_effort: string | null;
  judge_model: string;
  judge_effort: string | null;
  trials: number;
}

export function runConfigOf(opts: RunOptions): RunConfig {
  return {
    agent_model:
      opts.agentModel ??
      (opts.harness === "claude" ? DEFAULT_CLAUDE_AGENT : `${opts.harness}-default`),
    agent_effort: opts.agentEffort ?? null,
    judge_model: opts.judgeModel,
    judge_effort: opts.judgeEffort ?? null,
    trials: opts.trials ?? 1,
  };
}

// Entries and sidecars written before run configs were recorded lack the
// effort and trial fields; they ran at the defaults.
function configKey(c: Partial<RunConfig>): string {
  return JSON.stringify([
    c.agent_model,
    c.agent_effort ?? null,
    c.judge_model,
    c.judge_effort ?? null,
    c.trials ?? 1,
  ]);
}

function describeConfig(c: Partial<RunConfig>): string {
  const effort = (e: string | null | undefined) => (e ? `@${e}` : "");
  return `agent ${c.agent_model}${effort(c.agent_effort)}, judge ${c.judge_model}${effort(c.judge_effort)}, trials ${c.trials ?? 1}`;
}

// Throws when rows of one harness were measured with different configurations.
// Harnesses legitimately differ from each other, so they are compared apart.
export function assertUniformConfig(
  entries: (Partial<RunConfig> & { harness: string })[],
  allowMixed: boolean,
): void {
  if (allowMixed) return;
  const byHarness = new Map<string, Map<string, Partial<RunConfig>>>();
  for (const e of entries) {
    const configs = byHarness.get(e.harness) ?? new Map<string, Partial<RunConfig>>();
    configs.set(configKey(e), e);
    byHarness.set(e.harness, configs);
  }
  for (const [harness, configs] of byHarness) {
    if (configs.size > 1)
      throw new Error(
        `${harness} results span multiple run configurations (${[...configs.values()].map(describeConfig).join("; ")}); rerun them to match or pass --allow-mixed`,
      );
  }
}

// The eval engine and provider SDKs are optional peers so a lint-only install
// stays small; run/sweep must therefore degrade with the exact install
// command, not crash into a resolution error. Exit 2: a missing engine is an
// environment error, never a graded verdict.
function ensureEvalPackages(opts: RunOptions): void {
  const missing = requiredEvalPackages(opts, process.env.ANTHROPIC_API_KEY !== undefined).filter(
    (pkg) => resolvePackageDir(pkg) === undefined,
  );
  if (missing.length === 0) return;
  const peers: Record<string, string> =
    JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).peerDependencies ??
    {};
  const specs = missing.map((pkg) => `"${pkg}@${peers[pkg] ?? "latest"}"`).join(" ");
  console.error(
    [
      `missing eval package(s): ${missing.join(", ")}`,
      "",
      "The eval engine is an optional peer so `skillcheck lint` installs stay",
      "small. Evals are operator-run; install the peers next to @uinaf/skillcheck:",
      "",
      `  pnpm add -D ${specs}`,
    ].join("\n"),
  );
  process.exit(2);
}

// promptfoo's CLI entry inside the resolved peer, run with this same Node.
// Never `npx promptfoo`: with the engine now an optional peer, npx would fall
// back to fetching an unpinned promptfoo from the registry when it is absent.
function promptfooEntry(): string {
  const dir = resolvePackageDir("promptfoo");
  if (dir === undefined) throw new Error("promptfoo is not installed"); // ensureEvalPackages ran first
  const bin: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).bin;
  const rel = typeof bin === "string" ? bin : (bin as Record<string, string> | null)?.promptfoo;
  if (typeof rel !== "string") throw new Error(`promptfoo at ${dir} declares no bin`);
  return path.join(dir, rel);
}

interface RunOutcome {
  name: string;
  rc: number;
  resultPath: string;
  stats?: TrialStats;
  error?: string;
}

export interface Trial {
  score: number; // the weighted checklist score
  pass: boolean; // the checklist met its threshold and the skill was used
  skillUsed: boolean;
}

export type Verdict = { trials: Trial[] } | { error: string };

interface Stats {
  successes?: number;
  failures?: number;
  errors?: number;
}

interface Component {
  score?: unknown;
  pass?: unknown;
  assertion?: { type?: unknown } | null;
  metadata?: { assertionSet?: { type?: unknown } } | null;
}

// promptfoo's ResultFailureReason: NONE, ASSERT, ERROR.
const GRADED_REASONS = new Set([0, 1]);
const ERRORED_REASON = 2;

// A promptfoo test that errored was never graded. It carries an `error` and
// lands in stats.errors with nothing scored. Reporting that as score=0 FAIL
// would let a transport or resolution failure masquerade as a judge's verdict,
// so an errored trial stays an ERROR and exits 2 per the documented contract.
// One errored trial errors the scenario: pass^k over fewer than k trials is
// not the number that was asked for.
export function classifyResult(raw: unknown, expectedTrials?: number): Verdict {
  const root = raw as { results?: { results?: unknown; stats?: Stats | null } } | undefined;
  const rows = root?.results?.results;
  if (!Array.isArray(rows) || rows.length === 0)
    return { error: "promptfoo output carried no result" };
  if (expectedTrials !== undefined && rows.length !== expectedTrials)
    return { error: `promptfoo returned ${rows.length} of ${expectedTrials} trials` };
  // Stats total every row, so they can only attest a single-row result.
  const stats = rows.length === 1 ? (root?.results?.stats ?? undefined) : undefined;
  const trials: Trial[] = [];
  for (const [i, row] of rows.entries()) {
    const verdict = classifyRow(row, stats);
    if ("error" in verdict)
      return { error: rows.length === 1 ? verdict.error : `trial ${i + 1}: ${verdict.error}` };
    trials.push(verdict);
  }
  return { trials };
}

function classifyRow(raw: unknown, stats: Stats | undefined): Trial | { error: string } {
  const res = raw as
    | {
        error?: unknown;
        score?: unknown;
        success?: unknown;
        failureReason?: unknown;
        gradingResult?: { componentResults?: unknown } | null;
      }
    | null
    | undefined;
  if (res === undefined || res === null) return { error: "promptfoo output carried no result" };

  const message = typeof res.error === "string" ? res.error.trim() : "";
  if (res.failureReason === ERRORED_REASON)
    return { error: message || "promptfoo reported an errored test" };
  // promptfoo also copies a failed assert-set's threshold reason into the
  // result's error field while the test counts as a graded failure. That is a
  // judge's verdict, not a transport error, so the grading evidence wins over
  // the error text. Results without a failure reason fall back to the stats.
  const graded =
    GRADED_REASONS.has(res.failureReason as number) ||
    (stats !== undefined &&
      (stats.errors ?? 0) === 0 &&
      ((stats.failures ?? 0) > 0 || (stats.successes ?? 0) > 0));
  if (message !== "" && !graded) return { error: message };

  if (
    !graded &&
    stats !== undefined &&
    (stats.errors ?? 0) > 0 &&
    (stats.successes ?? 0) === 0 &&
    (stats.failures ?? 0) === 0
  ) {
    return { error: "promptfoo reported an errored test with nothing graded" };
  }
  if (typeof res.score !== "number" || typeof res.success !== "boolean") {
    return { error: "promptfoo result carried no usable score" };
  }
  // promptfoo's row score averages the checklist with the skill-used
  // assertion, so both are read from their own components. A row without
  // them was not graded against this harness's assertions.
  const components = Array.isArray(res.gradingResult?.componentResults)
    ? (res.gradingResult.componentResults as (Component | null)[])
    : [];
  const checklist = components.find((c) => c?.metadata?.assertionSet?.type === "assert-set");
  const skillUsed = components.find((c) => c?.assertion?.type === "skill-used");
  if (typeof checklist?.score !== "number" || typeof skillUsed?.pass !== "boolean") {
    return { error: "promptfoo result carried no checklist or skill-used verdict" };
  }
  return { score: checklist.score, pass: res.success, skillUsed: skillUsed.pass };
}

// Spread at or above this, or a mix of passes and fails, marks a scenario
// whose single-trial verdict could have gone either way.
export const NOISY_SPREAD = 0.2;

export interface TrialStats {
  trials: number;
  pass: boolean; // pass^k: every trial passed
  passes: number;
  pass_rate: number;
  score: number; // mean weighted checklist score
  score_min: number;
  score_spread: number; // max - min
  skill_used: number; // trials whose skill-used assertion passed
  skill_used_rate: number;
  noisy: boolean;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export function aggregateTrials(trials: Trial[]): TrialStats {
  if (trials.length === 0) throw new Error("cannot aggregate zero trials");
  const scores = trials.map((t) => t.score);
  const passes = trials.filter((t) => t.pass).length;
  const min = Math.min(...scores);
  const spread = Math.max(...scores) - min;
  const skillUsed = trials.filter((t) => t.skillUsed).length;
  return {
    trials: trials.length,
    pass: passes === trials.length,
    passes,
    pass_rate: round4(passes / trials.length),
    score: round4(scores.reduce((a, b) => a + b, 0) / trials.length),
    score_min: round4(min),
    score_spread: round4(spread),
    skill_used: skillUsed,
    skill_used_rate: round4(skillUsed / trials.length),
    // Tolerance only absorbs float error: 0.7 - 0.5 is 0.19999999999999996.
    noisy: (passes > 0 && passes < trials.length) || spread >= NOISY_SPREAD - 1e-9,
  };
}

export function formatStats(s: TrialStats): string {
  const line = `score=${s.score.toFixed(4)}`;
  if (s.trials === 1) return line;
  return [
    line,
    `min=${s.score_min.toFixed(4)}`,
    `spread=${s.score_spread.toFixed(4)}`,
    `pass^${s.trials}=${s.pass ? "yes" : "no"}`,
    `passes=${s.passes}/${s.trials}`,
    `skill-used=${s.skill_used}/${s.trials}`,
    ...(s.noisy ? ["NOISY"] : []),
  ].join(" ");
}

function gitHead(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function metaPath(resultPath: string): string {
  return resultPath.replace(/\.json$/, ".meta.json");
}

function attemptPath(resultPath: string): string {
  return `${resultPath}.attempt`;
}

function runScenario(scenarioDir: string, opts: RunOptions, root: string): RunOutcome {
  const dirs = stateDirs(root);
  const { name, configPath, skill, scenario } = generateRun(path.resolve(scenarioDir), opts, {
    scratchDir: dirs.scratch,
    transformPath: path.join(here, `transform${selfExt}`),
    grokProviderPath: path.join(here, `grok-provider${selfExt}`),
  });
  fs.mkdirSync(dirs.results, { recursive: true });
  const resultPath = path.join(dirs.results, `${name}.json`);
  // Keep attempted identity even when the child produces no output. This is
  // separate from the result so a no-output failure remains eligible for sweep.
  const identity = { skill, scenario, harness: opts.harness };
  fs.writeFileSync(attemptPath(resultPath), JSON.stringify(identity) + "\n");
  // Never let a stale result masquerade as this run's outcome.
  fs.rmSync(resultPath, { force: true });
  fs.rmSync(metaPath(resultPath), { force: true });
  const sha = gitHead(root);
  const r = spawnSync(
    process.execPath,
    [
      promptfooEntry(),
      "eval",
      "--no-cache",
      "--no-progress-bar",
      "-j",
      process.env.EVALS_CONCURRENCY ?? "4",
      "-c",
      configPath,
      "-o",
      resultPath,
    ],
    // Failing assertions exit 0 because graded FAIL comes from the result
    // file. promptfoo resolves other paths relative to the installed package.
    {
      cwd: packageDir,
      stdio: "inherit",
      env: { ...process.env, PROMPTFOO_FAILED_TEST_EXIT_CODE: "0" },
    },
  );
  const rc = r.status ?? 1; // null status (signal) counts as failure
  const outcome: RunOutcome = { name, rc, resultPath };
  if (rc !== 0) return outcome; // ERROR regardless of what's on disk

  let verdict: Verdict;
  try {
    verdict = classifyResult(JSON.parse(fs.readFileSync(resultPath, "utf8")), opts.trials ?? 1);
  } catch {
    verdict = { error: "promptfoo produced no parseable result file" };
  }
  if ("error" in verdict) return { ...outcome, error: verdict.error };
  outcome.stats = aggregateTrials(verdict.trials);

  // Provenance is only written for a graded result: an errored run has nothing
  // to attest, and a sidecar without a score would poison the scorecard.
  fs.writeFileSync(
    metaPath(resultPath),
    JSON.stringify(
      {
        skills_tree_sha: sha,
        ...identity,
        ...runConfigOf(opts),
        aggregate: outcome.stats,
        ran_at: new Date().toISOString(),
        tool_version: toolVersion(),
      },
      null,
      2,
    ) + "\n",
  );
  fs.rmSync(attemptPath(resultPath), { force: true });
  return outcome;
}

function judgeName(judge: unknown): string {
  // Provider-qualified judge IDs are recorded verbatim. Bare Anthropic IDs
  // lose their provider prefix; SDK judge objects carry the model in config,
  // while wrapped providers carry it in id.
  if (typeof judge === "string") return judge.replace(/^anthropic:messages:/, "");
  const j = judge as { id?: unknown; config?: { model?: unknown } } | null | undefined;
  const name = j?.config?.model ?? j?.id;
  return typeof name === "string" ? name.replace(/^anthropic:messages:/, "") : "unknown";
}

// The configuration a graded result ran with. Sidecars written before run
// configs were recorded fall back to the promptfoo config inside the result.
export function resultRunConfig(raw: unknown, meta: unknown, harness: string): RunConfig {
  const m = meta as Partial<RunConfig> | null | undefined;
  if (typeof m?.agent_model === "string" && typeof m.judge_model === "string") {
    return {
      agent_model: m.agent_model,
      agent_effort: m.agent_effort ?? null,
      judge_model: m.judge_model,
      judge_effort: m.judge_effort ?? null,
      trials: m.trials ?? 1,
    };
  }
  const r = raw as {
    config?: {
      providers?: { config?: { model?: unknown; effort?: unknown } }[];
      defaultTest?: { options?: { provider?: unknown } };
    };
    results?: { results?: unknown[] };
  };
  const agent = r?.config?.providers?.[0]?.config;
  const judge = r?.config?.defaultTest?.options?.provider;
  const judgeConfig = (judge as { config?: { reasoning_effort?: unknown; effort?: unknown } })
    ?.config;
  const judgeEffort = judgeConfig?.reasoning_effort ?? judgeConfig?.effort;
  return {
    agent_model: typeof agent?.model === "string" ? agent.model : `${harness}-default`,
    agent_effort: typeof agent?.effort === "string" ? agent.effort : null,
    judge_model: judgeName(judge),
    judge_effort: typeof judgeEffort === "string" ? judgeEffort : null,
    trials: r?.results?.results?.length ?? 1,
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
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
        if (
          sc.isDirectory() &&
          fs.existsSync(path.join(scenarioDir, "task.md")) &&
          fs.existsSync(path.join(scenarioDir, "criteria.json"))
        ) {
          found.push(scenarioDir);
        }
      }
    }
  }
  return found.sort();
}

const RUN_FLAGS =
  "[--root DIR] [--harness claude|codex|grok] [--agent MODEL] [--agent-effort EFFORT] [--judge MODEL] [--judge-effort EFFORT] [--trials K] [--max-turns N]";

function cmdRun(argv: string[]): void {
  const { positional, flags } = parseArgs(argv);
  if (positional.length !== 1) fail(`usage: skillcheck run <scenario-dir> ${RUN_FLAGS}`);
  const opts = runOptions(flags);
  ensureEvalPackages(opts);
  const o = runScenario(positional[0], opts, resolveRoot(flags));
  if (o.stats === undefined) {
    console.error(`ERROR ${o.name}: ${o.error ?? "no usable result"} (promptfoo rc=${o.rc})`);
    process.exit(2);
  }
  console.log(
    `${o.stats.pass ? "PASS" : "FAIL"} ${o.name} ${formatStats(o.stats)} (results: ${o.resultPath})`,
  );
  process.exit(o.stats.pass ? 0 : 1);
}

function cmdSweep(argv: string[]): void {
  const { positional, flags } = parseArgs(argv);
  if (positional.length > 0) fail(`usage: skillcheck sweep ${RUN_FLAGS} [--all]`);
  const root = resolveRoot(flags);
  const opts = runOptions(flags);
  ensureEvalPackages(opts);
  const all = flags.get("--all") === true;
  const resultsDir = stateDirs(root).results;
  const wanted = configKey(runConfigOf(opts));
  let passed = 0,
    failed = 0,
    errored = 0,
    skipped = 0;
  for (const dir of discoverScenarios(root)) {
    const name = runNameFor(dir, opts.harness);
    const resultPath = path.join(resultsDir, `${name}.json`);
    if (!all && fs.existsSync(resultPath) && !fs.existsSync(attemptPath(resultPath))) {
      // A malformed legacy result is incomplete and must be rerun, and so is
      // one measured with a different configuration.
      const raw = readJson(resultPath);
      const config = resultRunConfig(raw, readJson(metaPath(resultPath)), opts.harness);
      const graded = !("error" in classifyResult(raw, config.trials));
      if (graded && configKey(config) === wanted) {
        skipped++;
        console.log(`SKIP  ${name} (results exist; use --all to rerun)`);
        continue;
      }
      if (graded) console.log(`RERUN ${name} (results used ${describeConfig(config)})`);
    }
    const o = runScenario(dir, opts, root);
    if (o.stats === undefined) {
      errored++;
      console.log(`ERROR ${o.name} ${o.error ?? "no usable result"} (promptfoo rc=${o.rc})`);
    } else if (o.stats.pass) {
      passed++;
      console.log(`PASS  ${o.name} ${formatStats(o.stats)}`);
    } else {
      failed++;
      console.log(`FAIL  ${o.name} ${formatStats(o.stats)}`);
    }
  }
  console.log(
    `\nsweep: ${passed} passed, ${failed} failed, ${errored} errored, ${skipped} skipped`,
  );
  process.exit(errored > 0 ? 2 : failed > 0 ? 1 : 0);
}

export interface ScorecardEntry extends TrialStats, RunConfig {
  skill: string;
  scenario: string;
  harness: Harness | "cursor";
  skills_tree_sha: string;
  latency_ms: number; // mean per trial
  tokens: number; // agent and judge, summed over trials
}

function resultIdentity(
  file: string,
  dir: string,
): Pick<ScorecardEntry, "skill" | "scenario" | "harness"> {
  const base = file.replace(/\.json$/, "");
  for (const sidecar of [`${base}.meta.json`, `${file}.attempt`]) {
    try {
      const identity: unknown = JSON.parse(fs.readFileSync(path.join(dir, sidecar), "utf8"));
      if (
        identity !== null &&
        typeof identity === "object" &&
        "skill" in identity &&
        typeof identity.skill === "string" &&
        "scenario" in identity &&
        typeof identity.scenario === "string" &&
        "harness" in identity &&
        (identity.harness === "claude" ||
          identity.harness === "codex" ||
          identity.harness === "grok")
      ) {
        return { skill: identity.skill, scenario: identity.scenario, harness: identity.harness };
      }
    } catch {
      // Old results and attempts have no identity metadata.
    }
  }
  if (/^~v3~[0-9a-f]{64}$/.test(base)) throw new Error(`missing identity metadata for ${file}`);
  const decode = (part: string): string => {
    if (!part.startsWith("~v2~")) return part;
    try {
      const decoded = decodeURIComponent(part.slice(4));
      return encodeRunNamePart(decoded) === part ? decoded : part;
    } catch {
      return part;
    }
  };
  const suffix = base.match(/--(codex|grok|cursor)$/);
  const harness: ScorecardEntry["harness"] =
    suffix === null ? "claude" : (suffix[1] as ScorecardEntry["harness"]);
  const [skill, ...rest] = base.replace(/--(codex|grok|cursor)$/, "").split("--");
  return { skill: decode(skill), scenario: decode(rest.join("--")), harness };
}

interface Usage {
  total?: number;
  assertions?: { total?: number };
}

// Pure reducer over a results directory. Skips files that are not promptfoo
// results (warns to stderr, reported in `skipped`); throws on mixed
// skills-tree revisions unless allowMixed.
export function reduceResults(
  dir: string,
  allowMixed: boolean,
): {
  treeSha: string;
  entries: ScorecardEntry[];
  skipped: string[];
  gradedAt: Map<string, number>;
} {
  const entries: ScorecardEntry[] = [];
  const skipped: string[] = [];
  const gradedAt = new Map<string, number>();
  const shas = new Set<string>();
  const files = fs.readdirSync(dir);
  const incomplete = new Set(
    files.filter((f) => f.endsWith(".json.attempt")).map((f) => f.replace(/\.attempt$/, "")),
  );
  const results = files.filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"));
  for (const f of [...new Set([...results, ...incomplete])].sort()) {
    if (f.endsWith("--cursor.json")) {
      console.error(`skipping ${f}: Cursor harness is retired`);
      skipped.push(f);
      continue;
    }
    if (incomplete.has(f)) {
      console.error(`skipping ${f}: attempt did not complete with a graded result`);
      skipped.push(f);
      continue;
    }
    const raw = readJson(path.join(dir, f));
    const base = f.replace(/\.json$/, "");
    const meta = readJson(path.join(dir, `${base}.meta.json`)) as
      | { skills_tree_sha?: unknown }
      | undefined;
    const { skill, scenario, harness } = resultIdentity(f, dir);
    const config = resultRunConfig(raw, meta, harness);
    const verdict = classifyResult(raw, config.trials);
    if ("error" in verdict) {
      console.error(`skipping ${f}: ${verdict.error}`);
      skipped.push(f);
      continue;
    }
    const rows = (raw as { results: { results: { latencyMs?: number; tokenUsage?: Usage }[] } })
      .results.results;
    const key = entryKey({ skill, scenario, harness });
    gradedAt.set(key, Math.max(gradedAt.get(key) ?? 0, fs.statSync(path.join(dir, f)).mtimeMs));
    // Missing or malformed sidecars are unattested.
    const sha = typeof meta?.skills_tree_sha === "string" ? meta.skills_tree_sha : "unattested";
    shas.add(sha);
    const stats = aggregateTrials(verdict.trials);
    entries.push({
      skill,
      scenario,
      harness,
      skills_tree_sha: sha,
      ...stats,
      ...config,
      latency_ms: Math.round(rows.reduce((a, r) => a + (r.latencyMs ?? 0), 0) / rows.length),
      tokens: rows.reduce(
        (a, r) => a + (r.tokenUsage?.total ?? 0) + (r.tokenUsage?.assertions?.total ?? 0),
        0,
      ),
    });
  }
  if (shas.size > 1 && !allowMixed) {
    throw new Error(
      `results span multiple skills-tree revisions (${[...shas].join(", ")}); rerun stale ones or pass --allow-mixed`,
    );
  }
  const treeSha = shas.size === 1 ? [...shas][0] : shas.size === 0 ? "none" : "mixed";
  return { treeSha, entries, skipped, gradedAt };
}

// One scenario's identity in a scorecard. Rerunning a subset must update those
// rows and leave every other row alone.
function entryKey(e: Pick<ScorecardEntry, "skill" | "scenario" | "harness">): string {
  return [e.skill, e.scenario, e.harness].join("\0");
}

// A consumer whose results/ holds only today's rerun would otherwise overwrite
// a committed same-date scorecard with a fraction of its entries. Merge instead:
// fresh entries win, untouched ones survive.
export function mergeScorecard(
  existing: ScorecardEntry[],
  fresh: ScorecardEntry[],
): { entries: ScorecardEntry[]; carried: number } {
  const byKey = new Map<string, ScorecardEntry>();
  for (const e of existing) byKey.set(entryKey(e), e);
  let carried = byKey.size;
  for (const e of fresh) {
    if (byKey.has(entryKey(e))) carried--;
    byKey.set(entryKey(e), e);
  }
  const entries = [...byKey.values()].sort((a, b) =>
    entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0,
  );
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
  if (!Array.isArray(scenarios))
    throw new Error(`existing scorecard ${out} has no scenarios array; refusing to overwrite it`);
  return scenarios as ScorecardEntry[];
}

function cmdSummarize(argv: string[]): void {
  const { positional, flags } = parseArgs(argv);
  if (positional.length > 0) fail("usage: skillcheck summarize [--root DIR] [--allow-mixed]");
  const dirs = stateDirs(resolveRoot(flags));
  if (!fs.existsSync(dirs.results))
    fail(`no results directory at ${dirs.results}; run some evals first`);
  const { entries, skipped, gradedAt } = reduceResults(
    dirs.results,
    flags.get("--allow-mixed") === true,
  );
  fs.mkdirSync(dirs.scorecards, { recursive: true });
  const out = path.join(dirs.scorecards, `${new Date().toISOString().slice(0, 10)}.json`);
  const existing = readExistingScorecard(out);
  const skippedKeys = new Set(
    skipped
      .map((file) => ({
        key: entryKey(resultIdentity(file, dirs.results)),
        modifiedAt: fs.statSync(
          fs.existsSync(path.join(dirs.results, `${file}.attempt`))
            ? path.join(dirs.results, `${file}.attempt`)
            : path.join(dirs.results, file),
        ).mtimeMs,
      }))
      .filter(({ key, modifiedAt }) => (gradedAt.get(key) ?? 0) <= modifiedAt)
      .map(({ key }) => key),
  );
  if (existing.some((entry) => skippedKeys.has(entryKey(entry)))) {
    throw new Error(
      "skipped rerun matches an existing score; refusing to carry it or overwrite the scorecard",
    );
  }
  const merged = mergeScorecard(existing, entries);
  const treeSha = treeShaOf(merged.entries);
  const allowMixed = flags.get("--allow-mixed") === true;
  if (treeSha === "mixed" && !allowMixed) {
    throw new Error(
      "scorecard spans multiple skills-tree revisions; rerun stale ones or pass --allow-mixed",
    );
  }
  assertUniformConfig(merged.entries, allowMixed);
  const scorecard = {
    ran_at: new Date().toISOString(),
    skills_tree_sha: treeSha,
    scenarios: merged.entries,
  };
  fs.writeFileSync(out, JSON.stringify(scorecard, null, 2) + "\n");
  console.log(
    `${out}: ${merged.entries.length} scenario(s), ${merged.entries.filter((e) => e.pass).length} passing, ${skipped.length} skipped file(s)`,
  );
  if (existing.length > 0) {
    console.log(
      `merged into today's scorecard: ${entries.length} from this run, ${merged.carried} carried over`,
    );
  }
  console.log(`\n${formatSkillTable(summarizeSkills(merged.entries))}`);
  for (const e of merged.entries.filter((x) => x.noisy)) {
    console.log(`NOISY ${e.skill}/${e.scenario} (${e.harness}) ${formatStats(e)}`);
  }
}

export interface SkillSummary {
  skill: string;
  harness: string;
  scenarios: number;
  pass_all: number; // scenarios whose every trial passed
  pass_rate: number; // mean over scenarios
  score: number; // mean over scenarios
  noisy: string[];
}

// Scenarios weigh equally; rows from an older scorecard without trial fields
// count as one trial.
export function summarizeSkills(entries: ScorecardEntry[]): SkillSummary[] {
  const groups = new Map<string, ScorecardEntry[]>();
  for (const e of entries) {
    const key = `${e.skill}\0${e.harness}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const mean = (xs: number[]) => round4(xs.reduce((a, b) => a + b, 0) / xs.length);
  return [...groups.values()].map((rows) => ({
    skill: rows[0].skill,
    harness: rows[0].harness,
    scenarios: rows.length,
    pass_all: rows.filter((r) => r.pass).length,
    pass_rate: mean(rows.map((r) => r.pass_rate ?? (r.pass ? 1 : 0))),
    score: mean(rows.map((r) => r.score)),
    noisy: rows.filter((r) => r.noisy).map((r) => r.scenario),
  }));
}

function formatSkillTable(rows: SkillSummary[]): string {
  const table = [
    ["skill", "harness", "scenarios", "pass^k", "pass rate", "score", "noisy"],
    ...rows.map((r) => [
      r.skill,
      r.harness,
      String(r.scenarios),
      `${r.pass_all}/${r.scenarios}`,
      r.pass_rate.toFixed(2),
      r.score.toFixed(2),
      String(r.noisy.length),
    ]),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  return table
    .map((row) =>
      row
        .map((c, i) => c.padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

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

// npm links bins through node_modules/.bin, so the entrypoint and module URLs
// must be compared by filesystem identity.
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
