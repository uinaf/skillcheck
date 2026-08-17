// Library: turn one skill-eval scenario (task.md + criteria.json) into a
// promptfoo run directory. Composed by cli.ts; no CLI surface of its own.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
export function loadScenario(scenarioDir) {
    const match = scenarioDir.match(/skills\/([^/]+)\/evals\/([^/]+)$/);
    if (!match)
        throw new Error(`not a scenario dir (want .../skills/<skill>/evals/<scenario>): ${scenarioDir}`);
    const [, skill, scenario] = match;
    const taskMd = fs.readFileSync(path.join(scenarioDir, "task.md"), "utf8");
    const criteria = JSON.parse(fs.readFileSync(path.join(scenarioDir, "criteria.json"), "utf8"));
    if (criteria.type !== "weighted_checklist" || !Array.isArray(criteria.checklist) || criteria.checklist.length === 0) {
        throw new Error(`unsupported or empty criteria in ${scenarioDir}`);
    }
    for (const item of criteria.checklist) {
        const ok = typeof item?.name === "string" && item.name.trim() !== "" &&
            typeof item?.description === "string" && item.description.trim() !== "" &&
            Number.isFinite(item?.max_score) && item.max_score > 0;
        if (!ok)
            throw new Error(`invalid checklist item in ${scenarioDir}: ${JSON.stringify(item)}`);
    }
    // Extract embedded input files; replace each block with a pointer to the file on disk.
    const files = [];
    const fileBlock = /^=+ FILE: (.+?) =+\n([\s\S]*?)\n=+ END FILE =+$/gm;
    let prompt = taskMd.replace(fileBlock, (_, name, content) => {
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
export function runNameFor(scenarioDir, harness) {
    const m = path.resolve(scenarioDir).match(/skills\/([^/]+)\/evals\/([^/]+)$/);
    if (!m)
        throw new Error(`not a scenario dir (want .../skills/<skill>/evals/<scenario>): ${scenarioDir}`);
    return harness === "codex" ? `${m[1]}--${m[2]}--codex` : `${m[1]}--${m[2]}`;
}
// Frontmatter helpers: the disable-model-invocation contract lives only in the
// YAML block; body text mentioning the key (docs, examples) must not count.
function frontmatterRange(text) {
    const lines = text.split("\n");
    if (lines[0] !== "---")
        return null;
    const close = lines.indexOf("---", 1);
    return close === -1 ? null : [1, close];
}
export function isHiddenSkill(skillMd) {
    const range = frontmatterRange(skillMd);
    if (!range)
        return false;
    return skillMd.split("\n").slice(range[0], range[1]).some((l) => /^disable-model-invocation:/.test(l));
}
export function stripHiddenFlag(skillMd) {
    const range = frontmatterRange(skillMd);
    if (!range)
        return skillMd;
    const lines = skillMd.split("\n");
    const kept = lines.filter((l, i) => !(i >= range[0] && i < range[1] && /^disable-model-invocation:/.test(l)));
    return kept.join("\n");
}
// Reserved top-level workdir entries: fixtures may not write agent config roots.
const RESERVED = new Set([".claude", ".agents"]);
export function materialize(s, runDir, harness) {
    const workdir = path.join(runDir, "workdir");
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(workdir, { recursive: true });
    // Validate every embedded filename before writing anything: destinations must
    // stay strictly below workdir, must not land under .claude/ or .agents/ (a
    // fixture could inject settings the harness would load), and must not collide.
    const seen = new Set();
    const planned = s.files.map((f) => {
        const dest = path.resolve(workdir, f.name);
        const rel = path.relative(workdir, dest);
        if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
            throw new Error(`embedded file escapes workdir: ${f.name}`);
        if (RESERVED.has(rel.split(path.sep)[0]))
            throw new Error(`embedded file targets reserved dir: ${f.name}`);
        if (seen.has(dest))
            throw new Error(`duplicate embedded file: ${f.name}`);
        seen.add(dest);
        return { dest, content: f.content };
    });
    for (const { dest, content } of planned) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
    }
    // Install the skill under test, excluding its evals (criteria must not leak
    // into the agent's context). Claude discovers .claude/skills/; codex
    // discovers .agents/skills/ — install both for codex.
    const roots = harness === "codex" ? [".claude", ".agents"] : [".claude"];
    for (const root of roots) {
        fs.cpSync(s.skillDir, path.join(workdir, root, "skills", s.skill), {
            recursive: true,
            filter: (src) => path.basename(src) !== "evals",
        });
    }
    // Hidden skills (disable-model-invocation) are explicit-invoke-only in
    // production, which the SDK cannot simulate — so the eval copy drops the
    // flag and the caller prepends an explicit invocation to the task. The
    // shipped skill is untouched; the eval measures behavior-when-invoked.
    for (const root of roots) {
        const skillMd = path.join(workdir, root, "skills", s.skill, "SKILL.md");
        const text = fs.readFileSync(skillMd, "utf8");
        const stripped = stripHiddenFlag(text);
        if (stripped !== text)
            fs.writeFileSync(skillMd, stripped);
    }
    // Manifest of pre-existing files so transform.ts can find what the agent
    // wrote. Only .claude/ is excluded (matching transform.ts's walk): .agents/
    // files are hashed so the transform sees them as unchanged inputs.
    const manifest = {};
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name !== ".claude")
                    walk(p);
            }
            else {
                manifest[path.relative(workdir, p)] = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
            }
        }
    };
    walk(workdir);
    const manifestPath = path.join(runDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { workdir, manifestPath };
}
function agentProvider(opts, workdir, skill) {
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
export function buildConfig(s, workdir, manifestPath, opts, transformPath) {
    return {
        description: `${s.skill}/${s.scenario}`,
        prompts: ["{{task}}"],
        providers: [agentProvider(opts, workdir, s.skill)],
        defaultTest: {
            options: {
                // With ANTHROPIC_API_KEY set, grade over the plain messages API;
                // otherwise grade through the agent SDK provider with local Claude
                // Code session auth. The SDK judge needs a forced verdict schema —
                // the messages judge relies on promptfoo's own rubric JSON prompt.
                provider: process.env.ANTHROPIC_API_KEY
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
                transform: `file://${transformPath}`,
            },
        },
        tests: [
            {
                description: s.criteria.context,
                vars: { task: s.prompt, workdir, manifest: manifestPath },
                // No test-level threshold: the test passes only if every top-level
                // assertion passes — the checklist assert-set (weighted score >= its
                // own threshold) AND the mandatory skill-used routing check, which
                // stays outside the weighted aggregate.
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
// The provider SDKs promptfoo has to load for the agent and judge legs.
const SDK_PACKAGES = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];
// promptfoo resolves a provider's SDK by walking up from the config file, and
// the scratch dir now lives in the consumer repo, which need not have any
// node_modules above it. Locate the directory that actually holds skillcheck's
// own dependencies — wherever the install landed, hoisted or nested — rather
// than assuming a layout.
// Walks the resolution chain rather than resolving an entry point: @openai/
// codex-sdk publishes no main "exports", so require.resolve(pkg) throws for it
// even when the package is installed and importable by subpath. Looking for the
// package directory in the candidate node_modules dirs is immune to whatever
// export map a provider ships.
export function sdkNodeModulesDir() {
    const require = createRequire(import.meta.url);
    for (const pkg of SDK_PACKAGES) {
        for (const dir of require.resolve.paths(pkg) ?? []) {
            if (fs.existsSync(path.join(dir, pkg, "package.json")))
                return dir;
        }
    }
    return undefined;
}
// Full pipeline: load + materialize + write promptfooconfig.json under the
// caller's scratch dir.
export function generateRun(scenarioDir, opts, paths) {
    const s = loadScenario(scenarioDir);
    const name = runNameFor(scenarioDir, opts.harness);
    const runDir = path.join(paths.scratchDir, name);
    const { workdir, manifestPath } = materialize(s, runDir, opts.harness);
    // Make the provider SDKs resolvable from the config's own directory, or the
    // run dies in seconds with "The @anthropic-ai/claude-agent-sdk package could
    // not be resolved". The link sits beside the config and never inside workdir,
    // so the agent never sees it and the manifest never hashes it.
    const sdkDir = sdkNodeModulesDir();
    if (sdkDir !== undefined) {
        const link = path.join(runDir, "node_modules");
        fs.rmSync(link, { recursive: true, force: true });
        fs.symlinkSync(sdkDir, link, "dir");
    }
    const config = buildConfig(s, workdir, manifestPath, opts, paths.transformPath);
    const configPath = path.join(runDir, "promptfooconfig.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { name, configPath };
}
