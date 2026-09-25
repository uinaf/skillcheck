import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  aggregateTrials,
  classifyResult,
  formatStats,
  parseArgs,
  reduceResults,
  runOptions,
  stateDirs,
  summarizeSkills,
  type ScorecardEntry,
} from "../src/cli.ts";
import { generateRun, resolvePackageDir, type RunOptions } from "../src/scenario.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const scenario = path.join(here, "fixtures", "clean", "skills", "demo", "evals", "basic");

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `skillcheck-${prefix}-`));
}

function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function generate(dir: string, opts: Partial<RunOptions>) {
  return generateRun(
    scenario,
    { harness: "claude", judgeModel: "claude-opus-5", ...opts },
    {
      scratchDir: path.join(dir, "scratch"),
      transformPath: path.join(here, "..", "src", "transform.ts"),
      grokProviderPath: path.join(here, "..", "src", "grok-provider.ts"),
      skillEvidencePath: path.join(here, "..", "src", "skill-evidence.ts"),
    },
  );
}

// One promptfoo row the way promptfoo writes it for this harness's config: the
// assert-set's weighted checklist score and the skill-used verdict are
// components, and the row score averages them.
function row(checklist: number, skillUsed: boolean, extra: object = {}) {
  const pass = checklist >= 0.7 && skillUsed;
  return {
    score: (checklist + (skillUsed ? 1 : 0)) / 2,
    success: pass,
    failureReason: pass ? 0 : 1,
    latencyMs: 1000,
    tokenUsage: { total: 100, assertions: { total: 50 } },
    gradingResult: {
      componentResults: [
        {
          score: checklist,
          pass: checklist >= 0.7,
          metadata: { assertionSet: { type: "assert-set" } },
        },
        { score: 1, pass: true, assertion: { type: "llm-rubric", weight: 1 } },
        { score: skillUsed ? 1 : 0, pass: skillUsed, assertion: { type: "skill-used" } },
      ],
    },
    ...extra,
  };
}

test("aggregateTrials: pass^k, pass rate, mean, min, spread, skill-used rate", () => {
  const s = aggregateTrials([
    { score: 0.49, pass: false, skillUsed: true },
    { score: 0.99, pass: true, skillUsed: true },
    { score: 0.9, pass: false, skillUsed: false },
  ]);
  assert.deepEqual(s, {
    trials: 3,
    pass: false,
    passes: 1,
    pass_rate: 0.3333,
    score: 0.7933,
    score_min: 0.49,
    score_spread: 0.5,
    skill_used: 2,
    skill_used_rate: 0.6667,
    noisy: true,
  });
});

test("aggregateTrials: noise is a pass/fail mix or a spread of at least 0.2", () => {
  const trial = (score: number, pass: boolean) => ({ score, pass, skillUsed: true });
  assert.equal(aggregateTrials([trial(0.9, true), trial(0.95, true)]).noisy, false);
  assert.equal(aggregateTrials([trial(0.72, true), trial(0.68, false)]).noisy, true);
  assert.equal(aggregateTrials([trial(0.5, false), trial(0.7, false)]).noisy, true);
  assert.equal(aggregateTrials([trial(0.5, false), trial(0.69, false)]).noisy, false);
  // The threshold applies to the exact spread, not the stored rounding.
  assert.equal(aggregateTrials([trial(0.5, false), trial(0.69996, false)]).noisy, false);
  assert.equal(aggregateTrials([trial(0.1, false)]).noisy, false);
  const stable = aggregateTrials([trial(0.9, true), trial(0.9, true), trial(0.9, true)]);
  assert.equal(stable.pass, true);
  assert.equal(stable.score_spread, 0);
  assert.throws(() => aggregateTrials([]), /zero trials/);
});

test("formatStats: one trial keeps the single-score line, k trials show the spread", () => {
  assert.equal(
    formatStats(aggregateTrials([{ score: 0.8, pass: true, skillUsed: true }])),
    "score=0.8000",
  );
  const many = Array.from({ length: 20_000 }, (_, i) => ({
    score: 0.5,
    pass: i === 0,
    skillUsed: true,
  }));
  assert.match(formatStats(aggregateTrials(many)), /passes=1\/20000 skill-used=20000\/20000/);
  assert.equal(
    formatStats(
      aggregateTrials([
        { score: 0.49, pass: false, skillUsed: true },
        { score: 0.99, pass: true, skillUsed: true },
      ]),
    ),
    "score=0.7400 min=0.4900 spread=0.5000 pass^2=no passes=1/2 skill-used=2/2 NOISY",
  );
});

test("classifyResult: each row is a trial scored on its weighted checklist", () => {
  const verdict = classifyResult({
    results: {
      results: [row(0.85, true), row(0.9, false)],
      stats: { successes: 1, failures: 1, errors: 0 },
    },
  });
  assert.deepEqual(verdict, {
    trials: [
      { score: 0.85, pass: true, skillUsed: true },
      { score: 0.9, pass: false, skillUsed: false },
    ],
  });
});

test("classifyResult: one errored trial errors the scenario and names the trial", () => {
  const verdict = classifyResult({
    results: {
      results: [
        row(0.85, true),
        { score: 0, success: false, failureReason: 2, error: "rate limited (429)" },
      ],
      stats: { successes: 1, failures: 0, errors: 1 },
    },
  });
  assert.deepEqual(verdict, { error: "trial 2: rate limited (429)" });
});

test("classifyResult: missing trials or assertion components are errors, not grades", () => {
  const three = { results: { results: [row(0.9, true), row(0.9, true)] } };
  assert.deepEqual(classifyResult(three, 3), { error: "promptfoo returned 2 of 3 trials" });
  const bare = { results: { results: [{ score: 0.9, success: true, failureReason: 0 }] } };
  assert.match((classifyResult(bare) as { error: string }).error, /no checklist or skill-used/);
});

test("reduceResults: a k-trial result becomes one aggregated scorecard row", () => {
  const dir = tmp("reduce-trials");
  try {
    fs.writeFileSync(
      path.join(dir, "demo--basic.json"),
      JSON.stringify({ results: { results: [row(0.8, true), row(0.6, true), row(0.9, true)] } }),
    );
    fs.writeFileSync(
      path.join(dir, "demo--basic.meta.json"),
      JSON.stringify({
        skills_tree_sha: "sha1",
        skill: "demo",
        scenario: "basic",
        harness: "claude",
        agent_model: "claude-opus-5-5",
        agent_effort: "medium",
        judge_model: "claude-opus-5",
        judge_effort: null,
        trials: 3,
      }),
    );
    const [e] = reduceResults(dir, false).entries;
    assert.deepEqual(e, {
      skill: "demo",
      scenario: "basic",
      harness: "claude",
      variant: "skill",
      skills_tree_sha: "sha1",
      trials: 3,
      pass: false,
      passes: 2,
      pass_rate: 0.6667,
      score: 0.7667,
      score_min: 0.6,
      score_spread: 0.3,
      skill_used: 3,
      skill_used_rate: 1,
      noisy: true,
      agent_model: "claude-opus-5-5",
      agent_effort: "medium",
      judge_model: "claude-opus-5",
      judge_effort: null,
      agent_access: "offline",
      latency_ms: 1000,
      tokens: 450,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeSkills: per-skill pass^k, pass rate, mean score, noisy scenarios", () => {
  const base = aggregateTrials([{ score: 0.9, pass: true, skillUsed: true }]);
  const e = (skill: string, scenario: string, over: Partial<ScorecardEntry>): ScorecardEntry => ({
    skill,
    scenario,
    harness: "claude",
    skills_tree_sha: "sha1",
    ...base,
    agent_model: "m",
    agent_effort: null,
    judge_model: "j",
    judge_effort: null,
    agent_access: "online",
    latency_ms: 0,
    tokens: 0,
    ...over,
  });
  assert.deepEqual(
    summarizeSkills([
      e("a", "one", { pass: true, pass_rate: 1, score: 0.9 }),
      e("a", "two", { pass: false, pass_rate: 0.3333, score: 0.5, noisy: true }),
      e("b", "one", { pass: false, pass_rate: 0, score: 0.2 }),
    ]),
    [
      {
        skill: "a",
        harness: "claude",
        scenarios: 2,
        pass_all: 1,
        pass_rate: 0.6667,
        score: 0.7,
        noisy: ["two"],
        control_score: null,
        lift: null,
        no_lift: [],
      },
      {
        skill: "b",
        harness: "claude",
        scenarios: 1,
        pass_all: 0,
        pass_rate: 0,
        score: 0.2,
        noisy: [],
        control_score: null,
        lift: null,
        no_lift: [],
      },
    ],
  );
});

test("runOptions: --trials defaults to 1, --agent-effort is claude-only and validated", () => {
  const opts = (argv: string[]) => runOptions(parseArgs(argv).flags);
  assert.equal(opts([]).trials, 1);
  assert.equal(opts(["--trials", "3"]).trials, 3);
  assert.throws(() => opts(["--trials", "0"]), /--trials must be a positive integer/);
  assert.equal(opts(["--agent-effort", "medium"]).agentEffort, "medium");
  assert.equal(opts([]).agentEffort, undefined);
  assert.throws(() => opts(["--agent-effort", "extreme"]), /--agent-effort must be low, medium/);
  for (const harness of ["codex", "grok"])
    assert.throws(
      () => opts(["--harness", harness, "--agent-effort", "low"]),
      new RegExp(`--agent-effort is only supported with --harness claude; ${harness}`),
    );
});

test("cli: an unsupported --agent-effort fails before an eval starts", () => {
  const root = tmp("effort-harness");
  try {
    const r = runCli(["sweep", "--root", root, "--harness", "codex", "--agent-effort", "low"]);
    assert.equal(r.rc, 1);
    assert.match(r.stderr, /--agent-effort is only supported with --harness claude/);
    assert.equal(fs.existsSync(path.join(root, ".skillcheck")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generateRun: k trials get k isolated workdirs, each bound to one provider", () => {
  const dir = tmp("trials-config");
  try {
    const { configPath } = generate(dir, { trials: 3, agentEffort: "medium" });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const workdirs = config.providers.map(
      (p: { config: { working_dir: string } }) => p.config.working_dir,
    );
    assert.equal(new Set(workdirs).size, 3);
    for (const [i, t] of config.tests.entries()) {
      const label = `trial-${i + 1}`;
      assert.equal(config.providers[i].label, label);
      assert.equal(config.providers[i].config.effort, "medium");
      assert.deepEqual(t.providers, [label]);
      assert.equal(t.vars.workdir, workdirs[i]);
      assert.ok(fs.existsSync(path.join(workdirs[i], "note.md")));
      assert.ok(fs.existsSync(t.vars.manifest));
    }
    const plain = JSON.parse(fs.readFileSync(generate(dir, {}).configPath, "utf8"));
    assert.equal(plain.providers.length, 1);
    assert.equal("effort" in plain.providers[0].config, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Runs the generated config through the real promptfoo and Agent SDK, with a
// stub standing in for the Claude Code binary, and returns what each spawned
// process received. No model is called.
function spawnedAgents(dir: string, opts: Partial<RunOptions>) {
  const stub = path.join(dir, "claude-stub.mjs");
  const log = path.join(dir, "argv.jsonl");
  fs.writeFileSync(
    stub,
    `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.exit(1);
`,
  );
  const { configPath } = generate(dir, opts);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const p of config.providers) p.config.path_to_claude_code_executable = stub;
  fs.writeFileSync(configPath, JSON.stringify(config));
  const promptfoo = resolvePackageDir("promptfoo");
  assert.ok(promptfoo);
  const out = path.join(dir, "out.json");
  spawnSync(
    process.execPath,
    [
      path.join(promptfoo, "dist", "src", "entrypoint.js"),
      "eval",
      "--no-cache",
      "--no-progress-bar",
      "-c",
      configPath,
      "-o",
      out,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PROMPTFOO_CONFIG_DIR: path.join(dir, "promptfoo"),
        PROMPTFOO_DISABLE_TELEMETRY: "1",
        PROMPTFOO_DISABLE_UPDATE: "1",
      },
    },
  );
  const calls = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
  return { calls, config, result: JSON.parse(fs.readFileSync(out, "utf8")) };
}

// Two real promptfoo evals: seconds locally, longer on a cold CI runner.
test(
  "agent effort reaches the spawned Claude Code process of every trial",
  { timeout: 60_000 },
  () => {
    const dir = tmp("effort-spawn");
    try {
      const { calls, config, result } = spawnedAgents(dir, { trials: 2, agentEffort: "low" });
      assert.equal(calls.length, 2);
      for (const { argv } of calls) assert.equal(argv[argv.indexOf("--effort") + 1], "low");
      assert.deepEqual(
        calls.map((c) => fs.realpathSync(c.cwd)).sort(),
        config.providers.map((p: { config: { working_dir: string } }) =>
          fs.realpathSync(p.config.working_dir),
        ),
        "each trial's agent runs in its own workdir",
      );
      // A dead agent is an errored trial, never a graded FAIL.
      assert.match(
        (classifyResult(result) as { error: string }).error,
        /^trial \d: .*Claude Code process exited/,
      );

      const plain = spawnedAgents(tmp("effort-default"), {});
      assert.equal(plain.calls.length, 1);
      assert.equal(plain.calls[0].argv.includes("--effort"), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

function gitRoot(): string {
  const root = tmp("summary-config");
  fs.cpSync(path.join(here, "fixtures", "clean", "skills"), path.join(root, "skills"), {
    recursive: true,
  });
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

function writeGraded(
  results: string,
  name: string,
  config: { agent_effort: string | null; trials: number },
): void {
  const [skill, scenario] = name.split("--");
  fs.writeFileSync(
    path.join(results, `${name}.json`),
    JSON.stringify({
      results: { results: Array.from({ length: config.trials }, () => row(0.9, true)) },
    }),
  );
  fs.writeFileSync(
    path.join(results, `${name}.meta.json`),
    JSON.stringify({
      skills_tree_sha: "sha1",
      skill,
      scenario,
      harness: "claude",
      agent_model: "claude-opus-5",
      judge_model: "claude-opus-5",
      judge_effort: null,
      agent_access: "online",
      ...config,
    }),
  );
}

test("summarize: refuses to merge runs with different agent effort or trials", () => {
  const root = gitRoot();
  try {
    const evals = path.join(root, "skills", "demo", "evals");
    for (const name of ["one", "two", "three"])
      fs.cpSync(path.join(evals, "basic"), path.join(evals, name), { recursive: true });
    const { results, scorecards } = stateDirs(root);
    fs.mkdirSync(results, { recursive: true });
    writeGraded(results, "demo--one", { agent_effort: "medium", trials: 3 });
    writeGraded(results, "demo--two", { agent_effort: null, trials: 3 });
    const refused = runCli(["summarize", "--root", root]);
    assert.equal(refused.rc, 1);
    assert.match(refused.stderr, /multiple run configurations.*@medium.*--allow-mixed/);
    assert.equal(fs.existsSync(scorecards), true);
    assert.deepEqual(fs.readdirSync(scorecards), []);

    const allowed = runCli(["summarize", "--root", root, "--allow-mixed"]);
    assert.equal(allowed.rc, 0, allowed.stderr);
    assert.match(allowed.stdout, /demo\s+claude\s+2\s+2\/2\s+1\.00\s+0\.90\s+0/);

    // A same-date scorecard row from a one-trial run is a mismatch too.
    writeGraded(results, "demo--two", { agent_effort: "medium", trials: 3 });
    const [card] = fs.readdirSync(scorecards);
    const existing = JSON.parse(fs.readFileSync(path.join(scorecards, card), "utf8"));
    existing.scenarios.push({ ...existing.scenarios[0], scenario: "three", trials: 1 });
    fs.writeFileSync(path.join(scorecards, card), JSON.stringify(existing));
    const legacy = runCli(["summarize", "--root", root]);
    assert.equal(legacy.rc, 1);
    assert.match(legacy.stderr, /trials 1.*trials 3|trials 3.*trials 1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sweep: skips a result from the same configuration and reruns a changed one", () => {
  const root = gitRoot();
  try {
    const { results } = stateDirs(root);
    fs.mkdirSync(results, { recursive: true });
    writeGraded(results, "demo--basic", { agent_effort: null, trials: 1 });
    const fake = path.join(root, "fake-promptfoo.mjs");
    fs.writeFileSync(
      fake,
      `import fs from "node:fs";
const out = process.argv[process.argv.indexOf("-o") + 1];
fs.writeFileSync(out, JSON.stringify({ results: { results: [${JSON.stringify(row(0.95, true))}] } }));
`,
    );
    const preload = path.join(root, "preload.mjs");
    fs.writeFileSync(
      preload,
      `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawnSync;
cp.spawnSync = (command, args, options) => spawn(command, [${JSON.stringify(fake)}, ...args.slice(1)], options);
syncBuiltinESMExports();
`,
    );
    const sweep = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", preload, cli, "sweep", "--root", root, ...args], {
        encoding: "utf8",
      });
    const same = sweep();
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /SKIP  demo--basic/);

    const metaFile = path.join(results, "demo--basic.meta.json");
    const online = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    const { agent_access: _, ...offline } = online;
    fs.writeFileSync(metaFile, JSON.stringify(offline));
    const stale = sweep();
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /RERUN demo--basic \(results used .*, offline\)/);

    const changed = sweep("--agent-effort", "medium");
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(changed.stdout, /RERUN demo--basic \(results used agent claude-opus-5, judge/);
    assert.match(changed.stdout, /PASS  demo--basic score=0\.9500/);
    const meta = JSON.parse(fs.readFileSync(path.join(results, "demo--basic.meta.json"), "utf8"));
    assert.equal(meta.agent_effort, "medium");
    assert.equal(meta.aggregate.pass, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generateRun: a Claude judge carries its effort on both Anthropic paths", () => {
  const dir = tmp("judge-effort");
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    const judgeOf = (opts: Partial<RunOptions>) =>
      JSON.parse(fs.readFileSync(generate(dir, opts).configPath, "utf8")).defaultTest.options
        .provider;
    delete process.env.ANTHROPIC_API_KEY;
    const sdk = judgeOf({ judgeModel: "claude-opus-5-5", judgeEffort: "high" });
    assert.equal(sdk.id, "anthropic:claude-agent-sdk");
    assert.equal(sdk.config.model, "claude-opus-5-5");
    assert.equal(sdk.config.effort, "high");
    assert.equal("effort" in judgeOf({ judgeModel: "claude-opus-5-5" }).config, false);

    process.env.ANTHROPIC_API_KEY = "fixture";
    assert.deepEqual(judgeOf({ judgeModel: "claude-opus-5-5", judgeEffort: "high" }), {
      id: "anthropic:messages:claude-opus-5-5",
      config: { effort: "high" },
    });
    assert.equal(judgeOf({ judgeModel: "claude-opus-5-5" }), "anthropic:messages:claude-opus-5-5");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reduceResults: a Claude judge's effort is recovered from the result config", () => {
  const dir = tmp("judge-effort-reduce");
  try {
    fs.writeFileSync(
      path.join(dir, "demo--basic.json"),
      JSON.stringify({
        results: { results: [row(0.9, true)] },
        config: {
          providers: [{ config: { model: "claude-opus-5-5", effort: "medium" } }],
          defaultTest: {
            options: {
              provider: { id: "anthropic:messages:claude-opus-5-5", config: { effort: "high" } },
            },
          },
        },
      }),
    );
    const [e] = reduceResults(dir, false).entries;
    assert.deepEqual(
      [e.agent_model, e.agent_effort, e.judge_model, e.judge_effort],
      ["claude-opus-5-5", "medium", "claude-opus-5-5", "high"],
    );

    const qualified = {
      id: "anthropic:messages:claude-opus-5-5",
      config: { reasoning_effort: "high" },
    };
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "demo--basic.json"), "utf8"));
    raw.config.defaultTest.options.provider = qualified;
    fs.writeFileSync(path.join(dir, "demo--basic.json"), JSON.stringify(raw));
    const [q] = reduceResults(dir, false).entries;
    assert.deepEqual([q.judge_model, q.judge_effort], [qualified.id, "high"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skill evidence: a skill call or a read of the installed SKILL.md", async () => {
  const { default: assertSkillUsed } = await import("../src/skill-evidence.ts");
  const dir = tmp("evidence");
  try {
    const workdir = path.join(dir, "workdir");
    fs.mkdirSync(path.join(workdir, ".claude", "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(workdir, ".claude", "skills", "demo", "SKILL.md"), "x");
    fs.mkdirSync(path.join(dir, "source", "demo"), { recursive: true });
    fs.writeFileSync(path.join(dir, "source", "demo", "SKILL.md"), "x");
    const check = (metadata: object, required = true) =>
      assertSkillUsed("", { vars: { workdir }, config: { skill: "demo", required }, metadata });
    const read = (file_path: string, is_error: boolean | undefined = false, output = "---") => ({
      toolCalls: [{ name: "Read", input: { file_path }, is_error, output }],
    });

    assert.deepEqual(check({ skillCalls: [{ name: "demo" }] }), {
      pass: true,
      score: 1,
      reason: "skill used: skill call demo",
    });
    const installed = path.join(workdir, ".claude", "skills", "demo", "SKILL.md");
    assert.equal(check(read(installed)).pass, true);
    assert.equal(check(read(".claude/skills/demo/SKILL.md")).pass, true, "relative to workdir");
    assert.equal(check(read(installed, true)).pass, false, "a failed read is no evidence");
    assert.equal(
      check({ toolCalls: [{ name: "Read", input: { file_path: installed } }] }).pass,
      false,
      "an unfinished read is no evidence",
    );

    // An installed copy that links back to the source: reading the source
    // path is not reading what the agent was handed.
    const linked = path.join(dir, "linked");
    fs.mkdirSync(path.join(linked, ".claude", "skills", "demo"), { recursive: true });
    const source = path.join(dir, "source", "demo", "SKILL.md");
    fs.symlinkSync(source, path.join(linked, ".claude", "skills", "demo", "SKILL.md"));
    const viaLink = (file_path: string) =>
      assertSkillUsed("", {
        vars: { workdir: linked },
        config: { skill: "demo", required: true },
        metadata: read(file_path),
      }).pass;
    assert.equal(viaLink(source), false);
    assert.equal(viaLink(".claude/skills/demo/SKILL.md"), true);
    assert.equal(
      check(read(path.join(dir, "source", "demo", "SKILL.md"))).pass,
      false,
      "the skill's source outside the workdir is not the installed copy",
    );
    assert.equal(check({ skillCalls: [{ name: "other" }] }).pass, false);
    assert.equal(check({}).pass, false);

    assert.deepEqual(check({}, false), {
      pass: true,
      score: 0,
      reason: "skill demo not loaded (optional for this scenario)",
    });
    assert.deepEqual(check(read(installed), false).score, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyResult: optional skill use passes but still reports the skill as unused", () => {
  const optional = {
    score: 0.95,
    success: true,
    failureReason: 0,
    gradingResult: {
      componentResults: [
        { score: 0.9, pass: true, metadata: { assertionSet: { type: "assert-set" } } },
        { score: 0, pass: true, assertion: { type: "javascript", metric: "skill-used" } },
      ],
    },
  };
  assert.deepEqual(classifyResult({ results: { results: [optional] } }), {
    trials: [{ score: 0.9, pass: true, skillUsed: false }],
  });
});

test("generateRun: skill_use optional is carried to the assertion and validated", () => {
  const dir = tmp("skill-use");
  try {
    const skillDir = path.join(dir, "skills", "demo");
    fs.cpSync(path.join(here, "fixtures", "clean", "skills", "demo"), skillDir, {
      recursive: true,
    });
    const criteriaPath = path.join(skillDir, "evals", "basic", "criteria.json");
    const criteria = JSON.parse(fs.readFileSync(criteriaPath, "utf8"));
    const paths = {
      scratchDir: path.join(dir, "scratch"),
      transformPath: path.join(here, "..", "src", "transform.ts"),
      grokProviderPath: path.join(here, "..", "src", "grok-provider.ts"),
      skillEvidencePath: path.join(here, "..", "src", "skill-evidence.ts"),
    };
    const opts = { harness: "claude" as const, judgeModel: "claude-opus-5" };
    fs.writeFileSync(criteriaPath, JSON.stringify({ ...criteria, skill_use: "optional" }));
    const { configPath } = generateRun(path.join(skillDir, "evals", "basic"), opts, paths);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(config.tests[0].assert[1].config.required, false);

    fs.writeFileSync(criteriaPath, JSON.stringify({ ...criteria, skill_use: "sometimes" }));
    assert.throws(
      () => generateRun(path.join(skillDir, "evals", "basic"), opts, paths),
      /skill_use must be "required" or "optional"/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensurePrivateDir: owner-only, refuses a symlink, tightens an open directory", async () => {
  const { ensurePrivateDir } = await import("../src/cli.ts");
  const dir = tmp("private");
  try {
    const fresh = path.join(dir, "fresh");
    ensurePrivateDir(fresh);
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
    ensurePrivateDir(fresh);

    const target = path.join(dir, "elsewhere");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, path.join(dir, "link"));
    assert.throws(() => ensurePrivateDir(path.join(dir, "link")), /not a directory owned/);

    const open = path.join(dir, "open");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);
    ensurePrivateDir(open);
    assert.equal(fs.statSync(open).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skill evidence: metadata is also read from providerResponse", async () => {
  const { default: assertSkillUsed } = await import("../src/skill-evidence.ts");
  const result = assertSkillUsed("", {
    vars: { workdir: "/nonexistent" },
    config: { skill: "demo", required: true },
    providerResponse: { metadata: { skillCalls: [{ name: "demo" }] } },
  });
  assert.equal(result.pass, true);
});

test("control: installs no skill, drops the hidden invocation, never requires skill use", () => {
  const dir = tmp("control");
  try {
    const skillDir = path.join(dir, "skills", "demo");
    fs.cpSync(path.join(here, "fixtures", "clean", "skills", "demo"), skillDir, {
      recursive: true,
    });
    const md = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      md,
      fs.readFileSync(md, "utf8").replace(/^---\n/, "---\ndisable-model-invocation: true\n"),
    );
    const scenarioDir = path.join(skillDir, "evals", "basic");
    const paths = {
      scratchDir: path.join(dir, "scratch"),
      transformPath: path.join(here, "..", "src", "transform.ts"),
      grokProviderPath: path.join(here, "..", "src", "grok-provider.ts"),
      skillEvidencePath: path.join(here, "..", "src", "skill-evidence.ts"),
    };
    const base = { harness: "claude" as const, judgeModel: "claude-opus-5" };
    const withSkill = generateRun(scenarioDir, base, paths);
    const control = generateRun(scenarioDir, { ...base, control: true }, paths);
    assert.equal(withSkill.name, "demo--basic");
    assert.equal(control.name, "demo--basic--control");

    const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
    const skillConfig = read(withSkill.configPath);
    const controlConfig = read(control.configPath);
    const workdir = controlConfig.providers[0].config.working_dir;
    assert.equal(fs.existsSync(path.join(workdir, ".claude")), false);
    assert.ok(fs.existsSync(path.join(workdir, "note.md")));
    assert.match(skillConfig.tests[0].vars.task, /^Use the demo skill for this task\./);
    assert.doesNotMatch(controlConfig.tests[0].vars.task, /Use the demo skill/);
    assert.deepEqual(skillConfig.providers[0].config.skills, ["demo"]);
    assert.equal("skills" in controlConfig.providers[0].config, false);
    assert.equal(skillConfig.tests[0].assert[1].config.required, true);
    assert.equal(controlConfig.tests[0].assert[1].config.required, false);
    for (const tool of ["Bash", "WebFetch", "WebSearch"])
      assert.ok(controlConfig.providers[0].config.append_allowed_tools.includes(tool));

    for (const harness of ["codex", "grok"] as const) {
      const c = generateRun(scenarioDir, { ...base, harness, control: true }, paths);
      assert.equal(c.name, `demo--basic--${harness}--control`);
      const wd = read(c.configPath).providers[0].config.working_dir;
      for (const root of [".claude", ".agents", ".grok"])
        assert.equal(fs.existsSync(path.join(wd, root)), false, `${harness} ${root}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control: rows pair with their skill rows into lift and no-lift scenarios", () => {
  const dir = tmp("control-reduce");
  try {
    const write = (name: string, scenario: string, variant: string, score: number) => {
      fs.writeFileSync(
        path.join(dir, `${name}.json`),
        JSON.stringify({ results: { results: [{ ...row(score, true), success: score >= 0.7 }] } }),
      );
      fs.writeFileSync(
        path.join(dir, `${name}.meta.json`),
        JSON.stringify({
          skills_tree_sha: "sha1",
          skill: "demo",
          scenario,
          harness: "claude",
          variant,
        }),
      );
    };
    write("demo--a", "a", "skill", 0.9);
    write("demo--a--control", "a", "control", 0.4);
    write("demo--b", "b", "skill", 0.95);
    write("demo--b--control", "b", "control", 0.85);
    write("demo--c", "c", "skill", 0.8);
    const { entries } = reduceResults(dir, false);
    assert.deepEqual(
      entries.map((e) => [e.scenario, e.variant]),
      [
        ["a", "control"],
        ["a", "skill"],
        ["b", "control"],
        ["b", "skill"],
        ["c", "skill"],
      ],
    );
    const [s] = summarizeSkills(entries);
    assert.equal(s.scenarios, 3, "control rows are not scenarios");
    assert.equal(s.control_score, 0.625);
    assert.equal(s.lift, 0.3, "paired scenarios only: (0.9 + 0.95) / 2 - 0.625");
    assert.deepEqual(s.no_lift, ["b"], "b's control passes every trial");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control: an unattested control result keeps its variant and harness", () => {
  const dir = tmp("control-legacy");
  try {
    for (const name of ["demo--basic--codex--control", "demo--basic--control", "demo--control"])
      fs.writeFileSync(
        path.join(dir, `${name}.json`),
        JSON.stringify({ results: { results: [{ ...row(0.8, true), success: true }] } }),
      );
    const rows = reduceResults(dir, false).entries.map((e) => [
      e.skill,
      e.scenario,
      e.harness,
      e.variant,
    ]);
    assert.deepEqual(rows, [
      ["demo", "basic", "codex", "control"],
      ["demo", "basic", "claude", "control"],
      ["demo", "control", "claude", "skill"],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: each run gets a home with the login and none of the operator's skills", async () => {
  const { privateCodexHome } = await import("../src/scenario.ts");
  const dir = tmp("codex-home");
  const saved = process.env.CODEX_HOME;
  try {
    const source = path.join(dir, "operator");
    fs.mkdirSync(path.join(source, "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(source, "config.toml"), "model = 'x'\n");
    fs.writeFileSync(path.join(source, "AGENTS.md"), "operator guidance\n");
    process.env.CODEX_HOME = source;
    const home = path.join(dir, "run", "codex-home");
    privateCodexHome(home);
    assert.deepEqual(fs.readdirSync(home), ["config.toml"]);
    assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), "model = 'x'\n");
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summarize: drops carried and fresh rows for scenarios no longer in the tree", () => {
  const root = gitRoot();
  try {
    const { results, scorecards } = stateDirs(root);
    fs.mkdirSync(results, { recursive: true });
    fs.mkdirSync(scorecards, { recursive: true });
    writeGraded(results, "demo--basic", { agent_effort: null, trials: 1 });
    writeGraded(results, "demo--gone", { agent_effort: null, trials: 1 });
    const card = path.join(scorecards, `${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(card, JSON.stringify({ scenarios: [] }));
    const first = runCli(["summarize", "--root", root]);
    assert.equal(first.rc, 0, first.stderr);
    assert.match(first.stdout, /dropped 1 row\(s\) for scenarios no longer in the tree/);
    const rows = JSON.parse(fs.readFileSync(card, "utf8")).scenarios;
    assert.deepEqual(
      rows.map((r: ScorecardEntry) => r.scenario),
      ["basic"],
    );

    // A row carried from an earlier scorecard is dropped the same way.
    fs.rmSync(path.join(results, "demo--gone.json"));
    fs.rmSync(path.join(results, "demo--gone.meta.json"));
    fs.writeFileSync(
      card,
      JSON.stringify({ scenarios: [...rows, { ...rows[0], scenario: "retired" }] }),
    );
    const second = runCli(["summarize", "--root", root]);
    assert.equal(second.rc, 0, second.stderr);
    assert.match(second.stdout, /dropped 1 row/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(card, "utf8")).scenarios.map((r: ScorecardEntry) => r.scenario),
      ["basic"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("summarize: a retired scenario's stale revision or failed attempt does not block cleanup", () => {
  const root = gitRoot();
  try {
    const { results, scorecards } = stateDirs(root);
    fs.mkdirSync(results, { recursive: true });
    writeGraded(results, "demo--basic", { agent_effort: null, trials: 1 });
    writeGraded(results, "demo--gone", { agent_effort: null, trials: 1 });
    const meta = path.join(results, "demo--gone.meta.json");
    fs.writeFileSync(
      meta,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), skills_tree_sha: "old" }),
    );
    fs.writeFileSync(
      path.join(results, "demo--renamed.json.attempt"),
      JSON.stringify({ skill: "demo", scenario: "renamed", harness: "claude" }),
    );
    const card = path.join(scorecards, `${new Date().toISOString().slice(0, 10)}.json`);
    fs.mkdirSync(scorecards, { recursive: true });
    fs.writeFileSync(card, JSON.stringify({ scenarios: [] }));
    const r = runCli(["summarize", "--root", root]);
    assert.equal(r.rc, 0, r.stderr);
    assert.match(r.stdout, /1 scenario\(s\)/);
    assert.match(r.stdout, /dropped 2 row\(s\)/);
    assert.doesNotMatch(r.stdout, /carried over/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("summarize: deleting the last scenario drops its rows too", () => {
  const root = gitRoot();
  try {
    const { results } = stateDirs(root);
    fs.mkdirSync(results, { recursive: true });
    writeGraded(results, "demo--basic", { agent_effort: null, trials: 1 });
    fs.rmSync(path.join(root, "skills", "demo", "evals"), { recursive: true });
    const r = runCli(["summarize", "--root", root]);
    assert.equal(r.rc, 0, r.stderr);
    assert.match(r.stdout, /0 scenario\(s\)/);
    assert.match(r.stdout, /dropped 1 row/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("summarize: an unrelated cli/ directory does not make a results-only root live", () => {
  const root = tmp("results-only-cli");
  try {
    const { results } = stateDirs(root);
    fs.mkdirSync(results, { recursive: true });
    fs.mkdirSync(path.join(root, "cli", "tool", "src"), { recursive: true });
    writeGraded(results, "demo--basic", { agent_effort: null, trials: 1 });
    const r = runCli(["summarize", "--root", root]);
    assert.equal(r.rc, 0, r.stderr);
    assert.match(r.stdout, /1 scenario\(s\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
