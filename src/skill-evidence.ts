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
  input?: { file_path?: unknown } | null;
}

interface EvidenceContext {
  vars: { workdir?: unknown };
  config?: { skill?: unknown; required?: unknown };
  metadata?: { skillCalls?: unknown; toolCalls?: unknown } | null;
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

  const skillCall = calls(context.metadata?.skillCalls).find(
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
  const read = calls(context.metadata?.toolCalls).find((c) => {
    if (c.name !== "Read" || c.is_error !== false || typeof c.output !== "string") return false;
    const file = c.input?.file_path;
    if (typeof file !== "string") return false;
    const named = path.resolve(workdir, file);
    const inside = [workdir, root].some((w) => !path.relative(w, named).startsWith(".."));
    const target = real(named);
    return inside && target !== undefined && installed.has(target);
  });
  if (read) return `read of the installed ${skill}/SKILL.md`;
  return undefined;
}

// Optional scenarios (out-of-lane cases where declining the skill is right)
// always pass; the score still records whether the skill was loaded.
export default function assertSkillUsed(
  _output: string,
  context: EvidenceContext,
): { pass: boolean; score: number; reason: string } {
  const evidence = skillEvidence(context);
  const required = context.config?.required !== false;
  const used = evidence !== undefined;
  return {
    pass: used || !required,
    score: used ? 1 : 0,
    reason: used
      ? `skill used: ${evidence}`
      : `skill ${String(context.config?.skill)} not loaded${required ? "" : " (optional for this scenario)"}`,
  };
}
