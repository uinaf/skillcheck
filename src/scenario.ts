import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { SKIPPED_DIRS } from "./transform.ts";

export const FILE_BLOCK = /^=+ FILE: (.+?) =+\n([\s\S]*?)\n=+ END FILE =+$/gm;

export type Harness = "claude" | "codex" | "grok";

export interface ChecklistItem {
  name: string;
  description: string;
  max_score: number;
}

export interface Criteria {
  type: string;
  context?: string;
  skill_use?: "required" | "optional" | "forbidden";
  install?: Array<string> | "all";
  checklist: Array<ChecklistItem>;
}

export interface Scenario {
  skill: string;
  scenario: string;
  name: string;
  skillDir: string;
  alternatives: Array<string>;
  prompt: string;
  task: string;
  files: Array<{ name: string; content: string }>;
  criteria: Criteria;
}

export const DEFAULT_CLAUDE_AGENT = "claude-opus-5";

export interface RunOptions {
  harness: Harness;
  agentModel?: string;
  agentEffort?: string;
  judgeModel: string;
  judgeEffort?: string;
  maxTurns?: number;
  control?: boolean;
  trials?: number;
}

export interface TrialDir {
  workdir: string;
  manifestPath: string;
}

export interface RunPaths {
  scratchDir: string;
  transformPath: string;
  grokProviderPath: string;
  skillEvidencePath: string;
}

export function loadScenario(scenarioDir: string): Scenario {
  const match = scenarioDir.match(/skills\/([^/]+)\/evals\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `not a scenario dir (want .../skills/<skill>/evals/<scenario>): ${scenarioDir}`,
    );
  }

  const [, skill, scenario] = match;

  const taskMd = fs.readFileSync(path.join(scenarioDir, "task.md"), "utf8");
  const skillDir = path.resolve(scenarioDir, "../..");
  const hidden = isHiddenSkill(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"));
  let parsed: { criteria: Criteria; alternatives: Array<string> };

  try {
    parsed = parseCriteria(scenarioDir, hidden);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path.join(scenarioDir, "criteria.json")}: ${message}`, { cause: error });
  }

  const { criteria, alternatives } = parsed;

  const files: Scenario["files"] = [];

  const task = taskMd.replaceAll(FILE_BLOCK, (_, name: string, content: string) => {
    files.push({ name: name.trim(), content: content + "\n" });

    return `(Input file \`${name.trim()}\` is available in your working directory.)`;
  });

  const prompt = hidden ? `Use the ${skill} skill for this task.\n\n${task}` : task;

  return {
    skill,
    scenario,
    name: `${skill}--${scenario}`,
    skillDir,
    alternatives,
    prompt,
    task,
    files,
    criteria,
  };
}

export function parseCriteria(
  scenarioDir: string,
  hidden: boolean,
): { criteria: Criteria; alternatives: Array<string> } {
  const text = fs.readFileSync(path.join(scenarioDir, "criteria.json"), "utf8");
  let criteria: Criteria;

  try {
    criteria = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
    throw new Error("must be a JSON object");
  }

  if (criteria.type !== "weighted_checklist") {
    throw new Error(`type must be "weighted_checklist", got ${JSON.stringify(criteria.type)}`);
  }

  if (!Array.isArray(criteria.checklist) || criteria.checklist.length === 0) {
    throw new Error("checklist must be a non-empty array");
  }

  if (
    criteria.skill_use !== undefined &&
    !["required", "optional", "forbidden"].includes(criteria.skill_use)
  ) {
    throw new Error(`skill_use must be "required", "optional", or "forbidden"`);
  }

  for (const [i, item] of criteria.checklist.entries()) {
    for (const key of ["name", "description"] as const) {
      const value: unknown = item?.[key];

      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`checklist[${i}].${key} must be a non-empty string`);
      }
    }

    if (!Number.isFinite(item.max_score) || item.max_score <= 0) {
      throw new Error(`checklist[${i}].max_score must be a positive number`);
    }
  }

  if (hidden && (criteria.skill_use === "forbidden" || criteria.install !== undefined)) {
    throw new Error("a hidden skill is always invoked, so it has no routing to test");
  }

  const alternatives = resolveInstall(path.resolve(scenarioDir, "../.."), criteria.install);

  return { criteria, alternatives };
}

function resolveInstall(skillDir: string, install: Criteria["install"]): Array<string> {
  if (install === undefined) {
    return [];
  }

  const skillsRoot = path.dirname(skillDir);
  const self = path.basename(skillDir);

  const invocable = (name: string): boolean => {
    const dir = path.join(skillsRoot, name);
    const md = path.join(dir, "SKILL.md");

    return (
      name !== self &&
      !name.startsWith(".") &&
      fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true &&
      fs.lstatSync(md, { throwIfNoEntry: false })?.isFile() === true &&
      !isHiddenSkill(fs.readFileSync(md, "utf8"))
    );
  };

  if (install === "all") {
    const all = fs.readdirSync(skillsRoot).filter(invocable).sort();

    if (all.length === 0) {
      throw new Error(`install "all" finds no other model-invocable skill`);
    }

    return all;
  }

  if (!Array.isArray(install) || install.length === 0) {
    throw new Error(`install must be "all" or a non-empty list of skills`);
  }

  for (const name of install) {
    if (typeof name !== "string" || name.includes("/") || !invocable(name)) {
      throw new Error(
        `install names ${JSON.stringify(name)}, not another model-invocable skill under the root`,
      );
    }
  }

  return [...new Set(install)].sort();
}

export function encodeRunNamePart(part: string): string {
  if (
    !part.includes("--") &&
    !part.startsWith("-") &&
    !part.endsWith("-") &&
    !part.startsWith("~v2~")
  ) {
    return part;
  }

  return `~v2~${encodeURIComponent(part).replaceAll("-", "%2D").replaceAll("~", "%7E")}`;
}

export function runNameFor(scenarioDir: string, harness: Harness, control = false): string {
  const m = path.resolve(scenarioDir).match(/skills\/([^/]+)\/evals\/([^/]+)$/);

  if (!m) {
    throw new Error(
      `not a scenario dir (want .../skills/<skill>/evals/<scenario>): ${scenarioDir}`,
    );
  }

  const name = `${encodeRunNamePart(m[1])}--${encodeRunNamePart(m[2])}`;
  const full = `${harness === "claude" ? name : `${name}--${harness}`}${control ? "--control" : ""}`;

  if (Buffer.byteLength(`${full}.json.attempt`) <= 255) {
    return full;
  }

  return `~v3~${createHash("sha256")
    .update(JSON.stringify(control ? [m[1], m[2], harness, "control"] : [m[1], m[2], harness]))
    .digest("hex")}`;
}

function frontmatterRange(text: string): [number, number] | null {
  const lines = text.split("\n");

  if (lines[0] !== "---") {
    return null;
  }

  const close = lines.indexOf("---", 1);

  return close === -1 ? null : [1, close];
}

export function isHiddenSkill(skillMd: string): boolean {
  const range = frontmatterRange(skillMd);

  if (!range) {
    return false;
  }

  return skillMd
    .split("\n")
    .slice(range[0], range[1])
    .some((l) => l.startsWith("disable-model-invocation:"));
}

export function stripHiddenFlag(skillMd: string): string {
  const range = frontmatterRange(skillMd);

  if (!range) {
    return skillMd;
  }

  const lines = skillMd.split("\n");

  const kept = lines.filter(
    (l, i) => !(i >= range[0] && i < range[1] && l.startsWith("disable-model-invocation:")),
  );

  return kept.join("\n");
}

export function isIsolated(): boolean {
  return (
    process.env.SKILLCHECK_ISOLATED === "1" &&
    (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) &&
    process.getuid?.() === 0 &&
    Number.isInteger(Number(process.env.SKILLCHECK_AGENT_UID)) &&
    fs.existsSync(AGENT_WRAPPER)
  );
}

const AGENT_WRAPPER = "/usr/local/libexec/skillcheck/agent-wrapper.sh";

const MARKDOWN_LINK = /\]\(\s*<([^>]+)>|\]\(\s*([^)\s]+)|^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)/gm;

export function linkedSiblings(skillDir: string): Array<string> {
  const skillsRoot = path.dirname(skillDir);
  const realRoot = fs.realpathSync(skillsRoot);
  const realSelf = fs.realpathSync(skillDir);
  const self = path.basename(skillDir);
  const found = new Set([self]);
  const pending = [skillDir];

  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const file of skillMarkdown(dir)) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(MARKDOWN_LINK)) {
        const href = m[1] ?? m[2] ?? m[3];

        if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
          continue;
        }

        const target = path.resolve(path.dirname(file), href.split("#")[0]);
        const rel = path.relative(skillsRoot, target);
        const name = rel.split(path.sep)[0];

        if (name === "" || name === ".." || path.isAbsolute(rel) || found.has(name)) {
          continue;
        }

        if (!fs.existsSync(path.join(skillsRoot, name, "SKILL.md"))) {
          continue;
        }

        const real = fs.realpathSync(path.join(skillsRoot, name));

        if (path.dirname(real) !== realRoot || real === realSelf) {
          continue;
        }

        found.add(name);
        pending.push(path.join(skillsRoot, name));
      }
    }
  }

  found.delete(self);

  return [...found].sort();
}

function skillMarkdown(dir: string): Array<string> {
  const out: Array<string> = [];

  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);

      if (e.isDirectory()) {
        if (!(d === dir && e.name === "evals")) {
          walk(p);
        }
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(p);
      }
    }
  };

  walk(dir);

  return out;
}

const RESERVED = new Set([".claude", ".agents", ".grok", "node_modules"]);

export function materialize(
  s: Scenario,
  runDir: string,
  harness: Harness,
  control = false,
): { workdir: string; manifestPath: string } {
  const workdir = path.join(runDir, "workdir");
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(workdir, { recursive: true });

  const seen = new Set<string>();

  const planned = s.files.map((f) => {
    const dest = path.resolve(workdir, f.name);
    const rel = path.relative(workdir, dest);

    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`embedded file escapes workdir: ${f.name}`);
    }

    if (RESERVED.has(rel.split(path.sep)[0])) {
      throw new Error(`embedded file targets reserved dir: ${f.name}`);
    }

    if (seen.has(dest)) {
      throw new Error(`duplicate embedded file: ${f.name}`);
    }

    seen.add(dest);

    return { dest, content: f.content };
  });

  for (const { dest, content } of planned) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  const roots = control
    ? []
    : harness === "codex"
      ? [".claude", ".agents"]
      : harness === "grok"
        ? [".grok"]
        : [".claude"];

  const skillsRoot = path.dirname(s.skillDir);

  const installed = control
    ? []
    : [
        ...new Set([
          s.skill,
          ...linkedSiblings(s.skillDir),
          ...s.alternatives.flatMap((a) => [a, ...linkedSiblings(path.join(skillsRoot, a))]),
        ]),
      ];

  for (const root of roots) {
    for (const name of installed) {
      const from = fs.realpathSync(path.join(skillsRoot, name));
      fs.cpSync(from, path.join(workdir, root, "skills", name), {
        recursive: true,
        filter: (src) => {
          if (src === path.join(from, "evals")) {
            return false;
          }

          if (fs.lstatSync(src).isSymbolicLink()) {
            throw new Error(`skill contains a symbolic link: ${src}`);
          }

          return true;
        },
      });
    }
  }

  for (const root of roots) {
    const skillMd = path.join(workdir, root, "skills", s.skill, "SKILL.md");
    const text = fs.readFileSync(skillMd, "utf8");
    const stripped = stripHiddenFlag(text);

    if (stripped !== text) {
      fs.writeFileSync(skillMd, stripped);
    }
  }

  const manifest: Record<string, string> = {};

  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);

      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) {
          walk(p);
        }
      } else {
        manifest[path.relative(workdir, p)] = createHash("sha256")
          .update(fs.readFileSync(p))
          .digest("hex");
      }
    }
  };

  walk(workdir);
  const manifestPath = path.join(runDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

  return { workdir, manifestPath };
}

function agentProvider(
  opts: RunOptions,
  workdir: string,
  skills: Array<string>,
  paths: RunPaths,
): object {
  const [skill] = skills;

  if (opts.harness === "grok") {
    return {
      id: `file://${paths.grokProviderPath}`,
      config: {
        working_dir: workdir,
        skill,
        ...(opts.agentModel ? { model: opts.agentModel } : {}),
      },
    };
  }

  if (opts.harness === "codex") {
    return {
      id: "openai:codex-sdk",
      config: {
        ...(opts.agentModel ? { model: opts.agentModel } : {}),
        working_dir: workdir,
        skip_git_repo_check: true,
        enable_streaming: true,
        sandbox_mode: isIsolated() ? "danger-full-access" : "workspace-write",
        network_access_enabled: true,
        web_search_enabled: true,
        cli_config: { features: { plugins: false } },
        cli_env: {
          CODEX_HOME: path.join(workdir, "..", "..", "codex-home"),
          HOME: path.join(workdir, "..", "..", "home"),
        },
      },
    };
  }

  return {
    id: "anthropic:claude-agent-sdk",
    config: {
      model: opts.agentModel ?? DEFAULT_CLAUDE_AGENT,
      ...(opts.agentEffort ? { effort: opts.agentEffort } : {}),
      apiKeyRequired: false,
      working_dir: workdir,
      setting_sources: ["project"],
      ...(opts.control ? {} : { skills }),
      permission_mode: "acceptEdits",
      append_allowed_tools: [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash",
        "WebFetch",
        "WebSearch",
      ],
      max_turns: opts.maxTurns ?? 50,
    },
  };
}

export function trialLabel(index: number): string {
  return `trial-${index + 1}`;
}

export function buildConfig(
  s: Scenario,
  trials: Array<TrialDir>,
  opts: RunOptions,
  paths: RunPaths,
): object {
  return {
    description: `${s.skill}/${s.scenario}`,
    prompts: ["{{task}}"],
    providers: trials.map((t, i) => ({
      ...agentProvider(opts, t.workdir, [s.skill, ...s.alternatives], paths),
      label: trialLabel(i),
    })),
    defaultTest: {
      options: {
        provider: opts.judgeModel.includes(":")
          ? opts.judgeEffort === undefined
            ? opts.judgeModel
            : { id: opts.judgeModel, config: { reasoning_effort: opts.judgeEffort } }
          : process.env.ANTHROPIC_API_KEY
            ? opts.judgeEffort === undefined
              ? `anthropic:messages:${opts.judgeModel}`
              : {
                  id: `anthropic:messages:${opts.judgeModel}`,
                  config: { effort: opts.judgeEffort },
                }
            : {
                id: "anthropic:claude-agent-sdk",
                config: {
                  model: opts.judgeModel,
                  ...(opts.judgeEffort ? { effort: opts.judgeEffort } : {}),
                  apiKeyRequired: false,
                  max_turns: 3,
                  env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
                  title: "skillcheck judge",
                  output_format: {
                    type: "json_schema",
                    schema: {
                      type: "object",
                      additionalProperties: false,
                      required: ["reason", "pass", "score"],
                      properties: {
                        reason: { type: "string" },
                        pass: { type: "boolean" },
                        score: { type: "number", minimum: 0, maximum: 1 },
                      },
                    },
                  },
                },
              },
        transform: `file://${paths.transformPath}`,
      },
    },
    tests: trials.map((t, i) => ({
      description: s.criteria.context,
      providers: [trialLabel(i)],
      vars: {
        task: opts.control ? s.task : s.prompt,
        workdir: t.workdir,
        manifest: t.manifestPath,
      },
      assert: [
        {
          type: "assert-set",
          threshold: 0.7,
          assert: s.criteria.checklist.map((item) => ({
            type: "llm-rubric",
            value: `${item.name}: ${item.description}`,
            weight: item.max_score,
          })),
        },
        {
          type: "javascript",
          value: `file://${paths.skillEvidencePath}`,
          metric: "skill-used",
          config: {
            skill: s.skill,
            required: !opts.control && (s.criteria.skill_use ?? "required") === "required",
            ...(!opts.control && s.criteria.skill_use === "forbidden" ? { forbidden: true } : {}),
          },
        },
      ],
    })),
  };
}

const SDK_PACKAGES = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];

export function sdkNodeModulesDir(): string | undefined {
  for (const pkg of SDK_PACKAGES) {
    const dir = holdingNodeModules(pkg);

    if (dir !== undefined) {
      return dir;
    }
  }

  return undefined;
}

function holdingNodeModules(pkg: string): string | undefined {
  const require = createRequire(import.meta.url);

  for (const dir of require.resolve.paths(pkg) ?? []) {
    if (fs.existsSync(path.join(dir, pkg, "package.json"))) {
      return dir;
    }
  }

  return undefined;
}

export function resolvePackageDir(pkg: string): string | undefined {
  const dir = holdingNodeModules(pkg);

  return dir === undefined ? undefined : path.join(dir, pkg);
}

export function requiredEvalPackages(opts: RunOptions, hasAnthropicKey: boolean): Array<string> {
  const pkgs = ["promptfoo"];
  const sdkJudge = !opts.judgeModel.includes(":") && !hasAnthropicKey;

  if (opts.harness === "claude" || sdkJudge) {
    pkgs.push("@anthropic-ai/claude-agent-sdk");
  }

  if (opts.harness === "codex") {
    pkgs.push("@openai/codex-sdk");
  }

  return pkgs;
}

export function privateCodexHome(dir: string): void {
  const source = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const file of ["config.toml", "auth.json"]) {
    const from = path.join(source, file);

    if (fs.existsSync(from)) {
      fs.symlinkSync(from, path.join(dir, file));
    }
  }
}

const HIDDEN_HOME_ENTRIES = new Set([".agents", ".claude", ".codex"]);

export function privateHome(dir: string): void {
  const source = os.homedir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const name of fs.readdirSync(source)) {
    if (HIDDEN_HOME_ENTRIES.has(name)) {
      continue;
    }

    fs.symlinkSync(path.join(source, name), path.join(dir, name));
  }
}

export function handOverToAgent(runDir: string, trials: Array<TrialDir>): void {
  const uid = Number(process.env.SKILLCHECK_AGENT_UID);
  const gid = Number(process.env.SKILLCHECK_AGENT_GID ?? process.env.SKILLCHECK_AGENT_UID);

  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error("isolated run without SKILLCHECK_AGENT_UID: refusing to run the agent as root");
  }

  const own = (p: string): void => {
    fs.lchownSync(p, uid, gid);

    if (fs.lstatSync(p).isDirectory()) {
      for (const e of fs.readdirSync(p)) {
        own(path.join(p, e));
      }
    }
  };

  for (const dir of [path.dirname(runDir), runDir]) {
    fs.chmodSync(dir, 0o711);
  }

  for (const t of trials) {
    fs.chmodSync(path.dirname(t.workdir), 0o711);
    own(t.workdir);
  }

  for (const home of ["codex-home", "home"]) {
    const p = path.join(runDir, home);

    if (fs.existsSync(p)) {
      own(p);
    }
  }
}

export function generateRun(
  scenarioDir: string,
  opts: RunOptions,
  paths: RunPaths,
): { name: string; configPath: string; skill: string; scenario: string } {
  const s = loadScenario(scenarioDir);

  if (opts.harness === "grok" && s.criteria.skill_use === "forbidden") {
    throw new Error(
      `grok cannot evidence a skill load reliably enough for skill_use "forbidden": ${scenarioDir}`,
    );
  }

  const name = runNameFor(scenarioDir, opts.harness, opts.control);
  const runDir = path.join(paths.scratchDir, name);
  fs.rmSync(runDir, { recursive: true, force: true });

  const trials = Array.from({ length: opts.trials ?? 1 }, (_, i) =>
    materialize(s, path.join(runDir, trialLabel(i)), opts.harness, opts.control),
  );

  if (opts.harness === "codex") {
    privateCodexHome(path.join(runDir, "codex-home"));
    privateHome(path.join(runDir, "home"));
  }

  const sdkDir = sdkNodeModulesDir();

  if (sdkDir !== undefined) {
    const link = path.join(runDir, "node_modules");
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(sdkDir, link, "dir");
  }

  const config = buildConfig(s, trials, opts, paths);
  const configPath = path.join(runDir, "promptfooconfig.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  if (isIsolated()) {
    handOverToAgent(runDir, trials);
  }

  return { name, configPath, skill: s.skill, scenario: s.scenario };
}
