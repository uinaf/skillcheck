import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { SKIPPED_DIRS } from "./transform.ts";

// An inline input file in task.md, materialized into the workdir.
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
  // "optional" for out-of-lane scenarios where declining the skill is correct;
  // "forbidden" for near-miss prompts that must not load it.
  skill_use?: "required" | "optional" | "forbidden";
  // Other skills under the root installed beside it, so the agent has to
  // route between them; "all" installs every model-invocable skill.
  install?: string[] | "all";
  checklist: ChecklistItem[];
}

export interface Scenario {
  skill: string;
  scenario: string;
  name: string; // "<skill>--<scenario>"
  skillDir: string;
  alternatives: string[]; // criteria.install, resolved
  prompt: string;
  task: string; // the prompt without the hidden-skill invocation
  files: { name: string; content: string }[];
  criteria: Criteria;
}

export const DEFAULT_CLAUDE_AGENT = "claude-opus-5";

export interface RunOptions {
  harness: Harness;
  agentModel?: string; // undefined on codex/grok = let that CLI pick its default
  agentEffort?: string; // claude agent leg only; undefined = Claude Code's default
  judgeModel: string; // bare Claude model, or a provider-qualified promptfoo id ("openai:chat:gpt-5.6-sol")
  judgeEffort?: string; // Claude effort for a bare judge; reasoning_effort for a provider-qualified one
  maxTurns?: number; // claude agent leg only; default 50
  control?: boolean; // run without the skill installed, as a baseline
  trials?: number; // independent agent runs per scenario; default 1
}

// One agent run's isolated inputs. Trials never share a workdir: each one's
// deliverables are graded against its own manifest.
export interface TrialDir {
  workdir: string;
  manifestPath: string;
}

// Where generateRun writes scratch state and where it finds the transform it
// hands to promptfoo. Scratch follows the consumer root; the transform is
// package code and stays with the install.
export interface RunPaths {
  scratchDir: string;
  transformPath: string;
  grokProviderPath: string;
  skillEvidencePath: string;
}

export function loadScenario(scenarioDir: string): Scenario {
  const match = scenarioDir.match(/skills\/([^/]+)\/evals\/([^/]+)$/);
  if (!match)
    throw new Error(
      `not a scenario dir (want .../skills/<skill>/evals/<scenario>): ${scenarioDir}`,
    );
  const [, skill, scenario] = match;

  const taskMd = fs.readFileSync(path.join(scenarioDir, "task.md"), "utf8");
  const skillDir = path.resolve(scenarioDir, "../..");
  const hidden = isHiddenSkill(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"));
  let parsed: { criteria: Criteria; alternatives: string[] };
  try {
    parsed = parseCriteria(scenarioDir, hidden);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${path.join(scenarioDir, "criteria.json")}: ${message}`, { cause: err });
  }
  const { criteria, alternatives } = parsed;

  const files: Scenario["files"] = [];
  const task = taskMd.replace(FILE_BLOCK, (_, name: string, content: string) => {
    files.push({ name: name.trim(), content: content + "\n" });
    return `(Input file \`${name.trim()}\` is available in your working directory.)`;
  });
  // Hidden skills only ever run from an explicit user invocation, so the eval
  // task carries one; materialize() strips the flag from the installed copy.
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

// The criteria.json contract a run enforces before it starts. Lint calls this
// too, so a file that would stop a sweep midway fails in CI instead. Messages
// carry no location; each caller names the file its own way.
export function parseCriteria(
  scenarioDir: string,
  hidden: boolean,
): { criteria: Criteria; alternatives: string[] } {
  const text = fs.readFileSync(path.join(scenarioDir, "criteria.json"), "utf8");
  let criteria: Criteria;
  try {
    criteria = JSON.parse(text);
  } catch (err) {
    throw new Error(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria))
    throw new Error("must be a JSON object");
  if (criteria.type !== "weighted_checklist")
    throw new Error(`type must be "weighted_checklist", got ${JSON.stringify(criteria.type)}`);
  if (!Array.isArray(criteria.checklist) || criteria.checklist.length === 0)
    throw new Error("checklist must be a non-empty array");
  if (
    criteria.skill_use !== undefined &&
    !["required", "optional", "forbidden"].includes(criteria.skill_use)
  ) {
    throw new Error(`skill_use must be "required", "optional", or "forbidden"`);
  }
  for (const [i, item] of criteria.checklist.entries()) {
    for (const key of ["name", "description"] as const) {
      const value: unknown = item?.[key];
      if (typeof value !== "string" || value.trim() === "")
        throw new Error(`checklist[${i}].${key} must be a non-empty string`);
    }
    if (!Number.isFinite(item.max_score) || item.max_score <= 0)
      throw new Error(`checklist[${i}].max_score must be a positive number`);
  }
  if (hidden && (criteria.skill_use === "forbidden" || criteria.install !== undefined))
    throw new Error("a hidden skill is always invoked, so it has no routing to test");
  const alternatives = resolveInstall(path.resolve(scenarioDir, "../.."), criteria.install);
  return { criteria, alternatives };
}

// Alternatives are real directories with a real SKILL.md: a symlink could
// alias the skill under test, whose installed copy would then carry its evals,
// or pull a file from outside the root. A hidden skill only loads on an
// explicit invocation in production, so it is never an alternative.
function resolveInstall(skillDir: string, install: Criteria["install"]): string[] {
  if (install === undefined) return [];
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
    if (all.length === 0) throw new Error(`install "all" finds no other model-invocable skill`);
    return all;
  }
  if (!Array.isArray(install) || install.length === 0)
    throw new Error(`install must be "all" or a non-empty list of skills`);
  for (const name of install) {
    if (typeof name !== "string" || name.includes("/") || !invocable(name))
      throw new Error(
        `install names ${JSON.stringify(name)}, not another model-invocable skill under the root`,
      );
  }
  return [...new Set(install)].sort();
}

// Canonical run/result name for a scenario + harness. Single source of truth:
// generateRun names its scratch dir and cli.ts names result files with this.
export function encodeRunNamePart(part: string): string {
  if (
    !part.includes("--") &&
    !part.startsWith("-") &&
    !part.endsWith("-") &&
    !part.startsWith("~v2~")
  )
    return part;
  return `~v2~${encodeURIComponent(part).replaceAll("-", "%2D").replaceAll("~", "%7E")}`;
}

export function runNameFor(scenarioDir: string, harness: Harness, control = false): string {
  const m = path.resolve(scenarioDir).match(/skills\/([^/]+)\/evals\/([^/]+)$/);
  if (!m)
    throw new Error(
      `not a scenario dir (want .../skills/<skill>/evals/<scenario>): ${scenarioDir}`,
    );
  const name = `${encodeRunNamePart(m[1])}--${encodeRunNamePart(m[2])}`;
  // A control result is identified by its sidecars; the suffix only keeps the
  // filename apart from the same scenario's skill run. Escaped parts never
  // contain "--", so it cannot collide with a scenario name.
  const full = `${harness === "claude" ? name : `${name}--${harness}`}${control ? "--control" : ""}`;
  if (Buffer.byteLength(`${full}.json.attempt`) <= 255) return full;
  return `~v3~${createHash("sha256")
    .update(JSON.stringify(control ? [m[1], m[2], harness, "control"] : [m[1], m[2], harness]))
    .digest("hex")}`;
}

// disable-model-invocation is recognized only in YAML frontmatter. Body text
// may mention the key without changing invocation behavior.
function frontmatterRange(text: string): [number, number] | null {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  const close = lines.indexOf("---", 1);
  return close === -1 ? null : [1, close];
}

export function isHiddenSkill(skillMd: string): boolean {
  const range = frontmatterRange(skillMd);
  if (!range) return false;
  return skillMd
    .split("\n")
    .slice(range[0], range[1])
    .some((l) => l.startsWith("disable-model-invocation:"));
}

export function stripHiddenFlag(skillMd: string): string {
  const range = frontmatterRange(skillMd);
  if (!range) return skillMd;
  const lines = skillMd.split("\n");
  const kept = lines.filter(
    (l, i) => !(i >= range[0] && i < range[1] && l.startsWith("disable-model-invocation:")),
  );
  return kept.join("\n");
}

// Inline destinations, bare or in angle brackets, and reference definitions.
// Inside the isolated image: its env marker, a container runtime's marker
// file, skillcheck running as root, an agent user to drop to, and the agent
// wrapper installed. The variable alone, or a plain container, cannot claim
// isolation or turn off the Codex sandbox.
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

// Skills under the same root that the skill's Markdown links to, followed
// transitively, excluding the skill itself and anything under evals/.
export function linkedSiblings(skillDir: string): string[] {
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
        if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        const target = path.resolve(path.dirname(file), href.split("#")[0]);
        const rel = path.relative(skillsRoot, target);
        const name = rel.split(path.sep)[0];
        if (name === "" || name === ".." || path.isAbsolute(rel) || found.has(name)) continue;
        if (!fs.existsSync(path.join(skillsRoot, name, "SKILL.md"))) continue;
        // A symlinked sibling must not pull in a tree from outside the root,
        // or be an alias of the skill itself.
        const real = fs.realpathSync(path.join(skillsRoot, name));
        if (path.dirname(real) !== realRoot || real === realSelf) continue;
        found.add(name);
        pending.push(path.join(skillsRoot, name));
      }
    }
  }
  found.delete(self);
  return [...found].sort();
}

function skillMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!(d === dir && e.name === "evals")) walk(p);
      } else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// Reserved top-level workdir entries: fixtures may not write agent config roots.
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

  // Validate every embedded filename before writing anything: destinations must
  // stay strictly below workdir, must not land under .claude/ or .agents/ (a
  // fixture could inject settings the harness would load), and must not collide.
  const seen = new Set<string>();
  const planned = s.files.map((f) => {
    const dest = path.resolve(workdir, f.name);
    const rel = path.relative(workdir, dest);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
      throw new Error(`embedded file escapes workdir: ${f.name}`);
    if (RESERVED.has(rel.split(path.sep)[0]))
      throw new Error(`embedded file targets reserved dir: ${f.name}`);
    if (seen.has(dest)) throw new Error(`duplicate embedded file: ${f.name}`);
    seen.add(dest);
    return { dest, content: f.content };
  });
  for (const { dest, content } of planned) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  // Install the skill under test, excluding its evals (criteria must not leak
  // into the agent's context). Claude discovers .claude/skills/; codex
  // discovers .agents/skills/ (install both for codex); Grok uses .grok/skills/.
  // A control run installs nothing: it measures the agent without the skill.
  const roots = control
    ? []
    : harness === "codex"
      ? [".claude", ".agents"]
      : harness === "grok"
        ? [".grok"]
        : [".claude"];
  // Sibling skills it links to come along so those links resolve, as they do
  // when the plugin installs the set together; so do the scenario's
  // alternatives and their own links.
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
      // From the real directory, so a symlinked sibling is copied, evals
      // excluded, rather than linked back to its whole source tree.
      const from = fs.realpathSync(path.join(skillsRoot, name));
      fs.cpSync(from, path.join(workdir, root, "skills", name), {
        recursive: true,
        filter: (src) => src !== path.join(from, "evals"),
      });
    }
  }

  // Hidden skills (disable-model-invocation) are explicit-invoke-only in
  // production, which the SDK cannot simulate. The eval copy drops the
  // flag and the caller prepends an explicit invocation to the task. The
  // shipped skill is untouched; the eval measures behavior-when-invoked.
  for (const root of roots) {
    const skillMd = path.join(workdir, root, "skills", s.skill, "SKILL.md");
    const text = fs.readFileSync(skillMd, "utf8");
    const stripped = stripHiddenFlag(text);
    if (stripped !== text) fs.writeFileSync(skillMd, stripped);
  }

  // Manifest of pre-existing files so transform.ts can find what the agent
  // wrote. SKIPPED_DIRS are excluded (matching transform.ts's walk); Codex's
  // .agents/ files are hashed as inputs.
  const manifest: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) walk(p);
      } else {
        manifest[path.relative(workdir, p)] = createHash("sha256")
          .update(fs.readFileSync(p))
          .digest("hex");
      }
    }
  };
  walk(workdir);
  const manifestPath = path.join(runDir, "manifest.json");
  // Owner-only: in the isolated image the agent runs as another user.
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { workdir, manifestPath };
}

function agentProvider(
  opts: RunOptions,
  workdir: string,
  skills: string[],
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
        ...(opts.agentModel ? { model: opts.agentModel } : {}), // omitted = current Codex CLI default
        working_dir: workdir,
        skip_git_repo_check: true,
        enable_streaming: true, // required for skill-used evidence
        // Inside the isolated image the container is the sandbox, and Codex's own
        // namespace sandbox cannot start there, so every command would fail.
        sandbox_mode: isIsolated() ? "danger-full-access" : "workspace-write",
        network_access_enabled: true,
        web_search_enabled: true,
        // The copied config.toml may enable plugins, and Codex installs them
        // into CODEX_HOME at startup; one could ship the skill under test.
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
      // promptfoo hands this to the SDK, which spawns Claude Code with --effort.
      ...(opts.agentEffort ? { effort: opts.agentEffort } : {}),
      // Without ANTHROPIC_API_KEY, fall back to the local Claude Code session
      // (documented promptfoo path for subscription auth).
      apiKeyRequired: false,
      working_dir: workdir,
      setting_sources: ["project"],
      // A control run offers no skill, so the Skill tool and its catalog stay off.
      ...(opts.control ? {} : { skills }),
      permission_mode: "acceptEdits",
      // Online like a real session: shell and web, not just file tools.
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

// Trials are k labeled providers, each bound to its own workdir, and k tests
// filtered to one provider each. promptfoo's --repeat would reuse one vars set
// and one working_dir, so concurrent trials would write into the same tree and
// each would be graded on the union of their deliverables.
export function trialLabel(index: number): string {
  return `trial-${index + 1}`;
}

export function buildConfig(
  s: Scenario,
  trials: TrialDir[],
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
        // A provider-qualified judge ("openai:chat:gpt-5.6-sol") is handed to
        // promptfoo verbatim, optionally wrapped to carry reasoning_effort;
        // its auth is that provider's own env (OPENAI_API_KEY plus a base-URL
        // override for a gateway). Otherwise the judge is the Anthropic
        // selection: with ANTHROPIC_API_KEY, the plain messages API;
        // without it, the agent SDK provider with local Claude Code session
        // auth. The SDK judge needs a forced verdict schema. String judges
        // rely on promptfoo's own rubric JSON prompt. Both Claude paths take
        // `effort`; the SDK one starts Claude Code with --effort.
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
                  // promptfoo runs each judge call in a fresh temp dir, and auto
                  // memory writes that dir's path into the system prompt, so no
                  // two calls would share a cached prefix. The judge has no tools
                  // to use memory with.
                  env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
                  // A fixed title skips the second request, on the judge model,
                  // that names each session.
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
      // Both the weighted checklist and the separate skill-used assertion
      // must pass, unless the scenario makes skill use optional.
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

// The scratch directory belongs to the consumer and may have no node_modules
// ancestor. Find skillcheck's dependency directory without assuming whether
// the package manager hoisted it.
// Walks the resolution chain rather than resolving an entry point: @openai/
// codex-sdk publishes no main "exports", so require.resolve(pkg) throws for it
// even when the package is installed and importable by subpath. Looking for the
// package directory in the candidate node_modules dirs is immune to whatever
// export map a provider ships.
export function sdkNodeModulesDir(): string | undefined {
  for (const pkg of SDK_PACKAGES) {
    const dir = holdingNodeModules(pkg);
    if (dir !== undefined) return dir;
  }
  return undefined;
}

function holdingNodeModules(pkg: string): string | undefined {
  const require = createRequire(import.meta.url);
  for (const dir of require.resolve.paths(pkg) ?? []) {
    if (fs.existsSync(path.join(dir, pkg, "package.json"))) return dir;
  }
  return undefined;
}

// An optional peer's install directory, or undefined when the peer is absent.
// Lint-only consumers do not install the optional eval peers, so absence is a
// valid result.
export function resolvePackageDir(pkg: string): string | undefined {
  const dir = holdingNodeModules(pkg);
  return dir === undefined ? undefined : path.join(dir, pkg);
}

// Which optional peers a run needs: the engine always; the agent SDK for the
// claude agent leg and for the SDK judge (a bare judge model with no
// ANTHROPIC_API_KEY grades through the agent SDK, see buildConfig); the codex
// SDK for the codex agent leg.
export function requiredEvalPackages(opts: RunOptions, hasAnthropicKey: boolean): string[] {
  const pkgs = ["promptfoo"];
  const sdkJudge = !opts.judgeModel.includes(":") && !hasAnthropicKey;
  if (opts.harness === "claude" || sdkJudge) pkgs.push("@anthropic-ai/claude-agent-sdk");
  if (opts.harness === "codex") pkgs.push("@openai/codex-sdk");
  return pkgs;
}

// Codex reads skills and global instructions from CODEX_HOME, so the operator's
// own home would hand a control run the skill it withholds and add unrelated
// guidance to every run. Each run gets a home that carries only the login.
export function privateCodexHome(dir: string): void {
  const source = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of ["config.toml", "auth.json"]) {
    const from = path.join(source, file);
    if (fs.existsSync(from)) fs.symlinkSync(from, path.join(dir, file));
  }
}

// Codex also discovers skills in $HOME/.agents/skills, outside CODEX_HOME, and
// the workdir installs Codex skills under .claude too. The run's HOME links
// every entry of the operator's home except those agent roots, so auth helpers
// that read $HOME keep working and no user skill or guidance shows.
const HIDDEN_HOME_ENTRIES = new Set([".agents", ".claude", ".codex"]);
export function privateHome(dir: string): void {
  const source = os.homedir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    if (HIDDEN_HOME_ENTRIES.has(name)) continue;
    fs.symlinkSync(path.join(source, name), path.join(dir, name));
  }
}

// In the isolated image skillcheck runs as root and every agent as the
// unprivileged user named by SKILLCHECK_AGENT_UID (container/agent-wrapper.sh).
// The agent owns only its workdirs and the run's homes; directories on the way
// are traverse-only, and the config and manifests stay root-only.
export function handOverToAgent(runDir: string, trials: TrialDir[]): void {
  const uid = Number(process.env.SKILLCHECK_AGENT_UID);
  const gid = Number(process.env.SKILLCHECK_AGENT_GID ?? process.env.SKILLCHECK_AGENT_UID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid))
    throw new Error("isolated run without SKILLCHECK_AGENT_UID: refusing to run the agent as root");
  const own = (p: string): void => {
    fs.lchownSync(p, uid, gid);
    if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) own(path.join(p, e));
  };
  for (const dir of [path.dirname(runDir), runDir]) fs.chmodSync(dir, 0o711);
  for (const t of trials) {
    fs.chmodSync(path.dirname(t.workdir), 0o711);
    own(t.workdir);
  }
  for (const home of ["codex-home", "home"]) {
    const p = path.join(runDir, home);
    if (fs.existsSync(p)) own(p);
  }
}

export function generateRun(
  scenarioDir: string,
  opts: RunOptions,
  paths: RunPaths,
): { name: string; configPath: string; skill: string; scenario: string } {
  const s = loadScenario(scenarioDir);
  // Grok reports a load only for a file-tool read of the exact path, so a
  // missed load would pass a near miss.
  if (opts.harness === "grok" && s.criteria.skill_use === "forbidden")
    throw new Error(
      `grok cannot evidence a skill load reliably enough for skill_use "forbidden": ${scenarioDir}`,
    );
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

  // promptfoo resolves provider SDKs from the generated config directory. The
  // link stays outside workdir, hidden from the agent and its manifest.
  const sdkDir = sdkNodeModulesDir();
  if (sdkDir !== undefined) {
    const link = path.join(runDir, "node_modules");
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(sdkDir, link, "dir");
  }

  const config = buildConfig(s, trials, opts, paths);
  const configPath = path.join(runDir, "promptfooconfig.json");
  // The config carries the grading criteria; the agent must never read it.
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (isIsolated()) handOverToAgent(runDir, trials);
  return { name, configPath, skill: s.skill, scenario: s.scenario };
}
