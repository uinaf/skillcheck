import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export type Harness = "claude" | "codex" | "cursor";

export interface ChecklistItem {
  name: string;
  description: string;
  max_score: number;
}

export interface Criteria {
  type: string;
  context?: string;
  checklist: ChecklistItem[];
}

export interface Scenario {
  skill: string;
  scenario: string;
  name: string; // "<skill>--<scenario>"
  skillDir: string;
  prompt: string;
  files: { name: string; content: string }[];
  criteria: Criteria;
}

export interface RunOptions {
  harness: Harness;
  agentModel?: string; // undefined on codex/cursor = let that CLI pick its default
  judgeModel: string; // bare Claude model, or a provider-qualified promptfoo id ("openai:chat:gpt-5.6-sol")
  judgeEffort?: string; // reasoning_effort for a provider-qualified judge only
  maxTurns?: number; // claude agent leg only; default 50
}

// Where generateRun writes scratch state and where it finds the transform it
// hands to promptfoo. Scratch follows the consumer root; the transform is
// package code and stays with the install.
export interface RunPaths {
  scratchDir: string;
  transformPath: string;
  cursorProviderPath: string;
}

export function loadScenario(scenarioDir: string): Scenario {
  const match = scenarioDir.match(/skills\/([^/]+)\/evals\/([^/]+)$/);
  if (!match)
    throw new Error(
      `not a scenario dir (want .../skills/<skill>/evals/<scenario>): ${scenarioDir}`,
    );
  const [, skill, scenario] = match;

  const taskMd = fs.readFileSync(path.join(scenarioDir, "task.md"), "utf8");
  const criteria: Criteria = JSON.parse(
    fs.readFileSync(path.join(scenarioDir, "criteria.json"), "utf8"),
  );
  if (
    criteria.type !== "weighted_checklist" ||
    !Array.isArray(criteria.checklist) ||
    criteria.checklist.length === 0
  ) {
    throw new Error(`unsupported or empty criteria in ${scenarioDir}`);
  }
  for (const item of criteria.checklist) {
    const ok =
      typeof item?.name === "string" &&
      item.name.trim() !== "" &&
      typeof item?.description === "string" &&
      item.description.trim() !== "" &&
      Number.isFinite(item?.max_score) &&
      item.max_score > 0;
    if (!ok) throw new Error(`invalid checklist item in ${scenarioDir}: ${JSON.stringify(item)}`);
  }

  const files: Scenario["files"] = [];
  const fileBlock = /^=+ FILE: (.+?) =+\n([\s\S]*?)\n=+ END FILE =+$/gm;
  let prompt = taskMd.replace(fileBlock, (_, name: string, content: string) => {
    files.push({ name: name.trim(), content: content + "\n" });
    return `(Input file \`${name.trim()}\` is available in your working directory.)`;
  });

  // Hidden skills only ever run from an explicit user invocation, so the eval
  // task carries one; materialize() strips the flag from the installed copy.
  const skillDir = path.resolve(scenarioDir, "../..");
  if (isHiddenSkill(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"))) {
    prompt = `Use the ${skill} skill for this task.\n\n${prompt}`;
  }

  return { skill, scenario, name: `${skill}--${scenario}`, skillDir, prompt, files, criteria };
}

// Canonical run/result name for a scenario + harness. Single source of truth:
// generateRun names its scratch dir and cli.ts names result files with this.
export function runNameFor(scenarioDir: string, harness: Harness): string {
  const m = path.resolve(scenarioDir).match(/skills\/([^/]+)\/evals\/([^/]+)$/);
  if (!m)
    throw new Error(
      `not a scenario dir (want .../skills/<skill>/evals/<scenario>): ${scenarioDir}`,
    );
  return harness === "claude" ? `${m[1]}--${m[2]}` : `${m[1]}--${m[2]}--${harness}`;
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

// Reserved top-level workdir entries: fixtures may not write agent config roots.
const RESERVED = new Set([".claude", ".agents", ".cursor"]);

export function materialize(
  s: Scenario,
  runDir: string,
  harness: Harness,
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
  // discovers .agents/skills/ (install both for codex); cursor discovers
  // .cursor/skills/.
  const roots =
    harness === "codex" ? [".claude", ".agents"] : harness === "cursor" ? [".cursor"] : [".claude"];
  for (const root of roots) {
    fs.cpSync(s.skillDir, path.join(workdir, root, "skills", s.skill), {
      recursive: true,
      filter: (src) => path.basename(src) !== "evals",
    });
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
  // wrote. Only .claude/ is excluded (matching transform.ts's walk): .agents/
  // and .cursor/ files are hashed so the transform sees them as unchanged
  // inputs.
  const manifest: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".claude") walk(p);
      } else {
        manifest[path.relative(workdir, p)] = createHash("sha256")
          .update(fs.readFileSync(p))
          .digest("hex");
      }
    }
  };
  walk(workdir);
  const manifestPath = path.join(runDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { workdir, manifestPath };
}

function agentProvider(opts: RunOptions, workdir: string, skill: string, paths: RunPaths): object {
  if (opts.harness === "cursor") {
    // No promptfoo cursor provider exists; the config points at this package's
    // own provider module by file URL, exactly like the transform.
    return {
      id: `file://${paths.cursorProviderPath}`,
      config: {
        ...(opts.agentModel ? { model: opts.agentModel } : {}), // omitted = current Cursor CLI default
        working_dir: workdir,
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
        sandbox_mode: "workspace-write",
        cli_env: { CODEX_HOME: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex") },
      },
    };
  }
  return {
    id: "anthropic:claude-agent-sdk",
    config: {
      model: opts.agentModel ?? "claude-opus-5",
      // Without ANTHROPIC_API_KEY, fall back to the local Claude Code session
      // (documented promptfoo path for subscription auth).
      apiKeyRequired: false,
      working_dir: workdir,
      setting_sources: ["project"],
      skills: [skill],
      permission_mode: "acceptEdits",
      append_allowed_tools: ["Read", "Write", "Edit", "Glob", "Grep"],
      max_turns: opts.maxTurns ?? 50,
    },
  };
}

export function buildConfig(
  s: Scenario,
  workdir: string,
  manifestPath: string,
  opts: RunOptions,
  paths: RunPaths,
): object {
  return {
    description: `${s.skill}/${s.scenario}`,
    prompts: ["{{task}}"],
    providers: [agentProvider(opts, workdir, s.skill, paths)],
    defaultTest: {
      options: {
        // A provider-qualified judge ("openai:chat:gpt-5.6-sol") is handed to
        // promptfoo verbatim, optionally wrapped to carry reasoning_effort;
        // its auth is that provider's own env (OPENAI_API_KEY plus a base-URL
        // override for a gateway). Otherwise the judge is the Anthropic
        // selection: with ANTHROPIC_API_KEY, the plain messages API;
        // without it, the agent SDK provider with local Claude Code session
        // auth. The SDK judge needs a forced verdict schema. String judges
        // rely on promptfoo's own rubric JSON prompt.
        provider: opts.judgeModel.includes(":")
          ? opts.judgeEffort === undefined
            ? opts.judgeModel
            : { id: opts.judgeModel, config: { reasoning_effort: opts.judgeEffort } }
          : process.env.ANTHROPIC_API_KEY
            ? `anthropic:messages:${opts.judgeModel}`
            : {
                id: "anthropic:claude-agent-sdk",
                config: {
                  model: opts.judgeModel,
                  apiKeyRequired: false,
                  max_turns: 3,
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
    tests: [
      {
        description: s.criteria.context,
        vars: { task: s.prompt, workdir, manifest: manifestPath },
        // Both the weighted checklist and the separate skill-used assertion
        // must pass.
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
          { type: "skill-used", value: s.skill },
        ],
      },
    ],
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
// SDK for the codex agent leg. The cursor harness drives its own CLI and
// needs no agent-side SDK.
export function requiredEvalPackages(opts: RunOptions, hasAnthropicKey: boolean): string[] {
  const pkgs = ["promptfoo"];
  const sdkJudge = !opts.judgeModel.includes(":") && !hasAnthropicKey;
  if (opts.harness === "claude" || sdkJudge) pkgs.push("@anthropic-ai/claude-agent-sdk");
  if (opts.harness === "codex") pkgs.push("@openai/codex-sdk");
  return pkgs;
}

export function generateRun(
  scenarioDir: string,
  opts: RunOptions,
  paths: RunPaths,
): { name: string; configPath: string } {
  const s = loadScenario(scenarioDir);
  const name = runNameFor(scenarioDir, opts.harness);
  const runDir = path.join(paths.scratchDir, name);
  const { workdir, manifestPath } = materialize(s, runDir, opts.harness);

  // promptfoo resolves provider SDKs from the generated config directory. The
  // link stays outside workdir, hidden from the agent and its manifest.
  const sdkDir = sdkNodeModulesDir();
  if (sdkDir !== undefined) {
    const link = path.join(runDir, "node_modules");
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(sdkDir, link, "dir");
  }

  const config = buildConfig(s, workdir, manifestPath, opts, paths);
  const configPath = path.join(runDir, "promptfooconfig.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { name, configPath };
}
