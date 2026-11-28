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
  providerResponse?: { metadata?: Metadata | null; raw?: unknown } | null;
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

const callList = (value: unknown): Array<Call> =>
  Array.isArray(value) ? value.filter((c): c is Call => c !== null && typeof c === "object") : [];

export function skillEvidence(context: EvidenceContext): string | undefined {
  const skill = context.config?.skill;
  const workdir = context.vars.workdir;

  if (typeof skill !== "string" || typeof workdir !== "string") {
    return undefined;
  }

  const metadata = context.metadata ?? context.providerResponse?.metadata;

  const skillCall = callList(metadata?.skillCalls).find(
    (c) => c.name === skill && c.is_error !== true,
  );

  if (skillCall) {
    return `skill call ${skill}`;
  }

  const installed = new Set(
    SKILL_ROOTS.flatMap((root) => {
      const p = real(path.join(workdir, root, "skills", skill, "SKILL.md"));

      return p === undefined ? [] : [p];
    }),
  );

  const root = real(workdir) ?? workdir;

  const read = callList(metadata?.toolCalls).find((c) => {
    if (c.name !== "Read" || c.is_error !== false || typeof c.output !== "string") {
      return false;
    }

    const file = c.input?.file_path;

    if (typeof file !== "string") {
      return false;
    }

    const named = path.resolve(workdir, file);

    const inside = [workdir, root].some((w) => {
      const rel = path.relative(w, named);

      return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    });

    const target = real(named);

    return inside && target !== undefined && installed.has(target);
  });

  if (read) {
    return `read of the installed ${skill}/SKILL.md`;
  }

  const opening = [...installed].flatMap((p) => {
    const t = fs.readFileSync(p, "utf8").slice(0, 300).trim();

    return t.length >= 40 ? [t] : [];
  });

  const shown = callList(metadata?.toolCalls).find(
    (c) =>
      c.name === "Bash" &&
      c.is_error === false &&
      typeof c.output === "string" &&
      opening.some((t) => (c.output as string).includes(t)),
  );

  if (shown) {
    return `shell read of the installed ${skill}/SKILL.md`;
  }

  const printed = codexCommandOutputs(context.providerResponse?.raw).some((out) =>
    opening.some((t) => out.includes(t)),
  );

  if (printed) {
    return `shell read of the installed ${skill}/SKILL.md`;
  }

  return undefined;
}

function codexCommandOutputs(raw: unknown): Array<string> {
  let parsed: unknown = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  const items = (parsed as { items?: unknown } | null)?.items;

  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((item: { type?: unknown; aggregated_output?: unknown } | null) =>
    item?.type === "command_execution" && typeof item.aggregated_output === "string"
      ? [item.aggregated_output]
      : [],
  );
}

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
