// promptfoo javascript assertion: did the agent load the skill under test?
// Loaded by file URL, like the transform. Evidence is either a skill call the
// provider reported, or a completed read of the installed SKILL.md inside the
// scenario workdir: Claude Code often reads the file directly instead of going
// through its Skill tool, and both put the same instructions in context.
import fs from "node:fs";
import path from "node:path";

interface Call {
  name?: unknown;
  is_error?: unknown;
  output?: unknown;
  input?: { file_path?: unknown; command?: unknown } | null;
}

interface EvidenceContext {
  vars: { workdir?: unknown };
  config?: { skill?: unknown; required?: unknown; forbidden?: unknown };
  metadata?: Metadata | null;
  providerResponse?: { metadata?: Metadata | null } | null;
}

interface Metadata {
  skillCalls?: unknown;
  toolCalls?: unknown;
}

const SKILL_ROOTS = [".claude", ".agents", ".grok"];

function real(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

export function skillEvidence(context: EvidenceContext): string | undefined {
  const skill = context.config?.skill;
  const workdir = context.vars.workdir;
  if (typeof skill !== "string" || typeof workdir !== "string") return undefined;
  const calls = (value: unknown): Call[] =>
    Array.isArray(value) ? value.filter((c): c is Call => c !== null && typeof c === "object") : [];

  // context.metadata is promptfoo's shortcut for providerResponse.metadata.
  const metadata = context.metadata ?? context.providerResponse?.metadata;
  const skillCall = calls(metadata?.skillCalls).find(
    (c) => c.name === skill && c.is_error !== true,
  );
  if (skillCall) return `skill call ${skill}`;

  const installed = new Set(
    SKILL_ROOTS.map((root) => real(path.join(workdir, root, "skills", skill, "SKILL.md"))).filter(
      (p): p is string => p !== undefined,
    ),
  );
  // A completed read carries is_error: false and its output. The named path
  // must itself be inside the workdir: the installed copy may be a symlink
  // back to the skill's source, which is not what the agent was handed.
  const root = real(workdir) ?? workdir;
  const read = calls(metadata?.toolCalls).find((c) => {
    if (c.name !== "Read" || c.is_error !== false || typeof c.output !== "string") return false;
    const file = c.input?.file_path;
    if (typeof file !== "string") return false;
    const named = path.resolve(workdir, file);
    const inside = [workdir, root].some((w) => {
      const rel = path.relative(w, named);
      return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    });
    const target = real(named);
    return inside && target !== undefined && installed.has(target);
  });
  if (read) return `read of the installed ${skill}/SKILL.md`;

  // Agents also print the file from a shell (`cd .claude/skills/x && cat
  // SKILL.md`, or a loop over every file), which a path check cannot follow.
  // Count a successful shell call whose output carries the installed file's
  // opening text: then the same instructions reached the agent's context.
  const opening = [...installed]
    .map((p) => fs.readFileSync(p, "utf8").slice(0, 300).trim())
    .filter((t) => t.length >= 40);
  const shown = calls(metadata?.toolCalls).find(
    (c) =>
      c.name === "Bash" &&
      c.is_error === false &&
      typeof c.output === "string" &&
      opening.some((t) => (c.output as string).includes(t)),
  );
  if (shown) return `shell read of the installed ${skill}/SKILL.md`;
  return undefined;
}

// Optional scenarios (out-of-lane cases where declining the skill is right)
// always pass, and forbidden ones (near-miss prompts) pass only when the skill
// stayed unloaded; the score always records whether it was loaded.
export default function assertSkillUsed(
  _output: string,
  context: EvidenceContext,
): { pass: boolean; score: number; reason: string } {
  const evidence = skillEvidence(context);
  const forbidden = context.config?.forbidden === true;
  const required = !forbidden && context.config?.required !== false;
  const used = evidence !== undefined;
  const skill = String(context.config?.skill);
  return {
    pass: forbidden ? !used : used || !required,
    score: used ? 1 : 0,
    reason: used
      ? `skill used: ${evidence}${forbidden ? " (forbidden for this scenario)" : ""}`
      : `skill ${skill} not loaded${required || forbidden ? "" : " (optional for this scenario)"}`,
  };
}
