// Lint every skill package under a root: frontmatter contract, name/dir
// agreement, and resolvable relative links. Zero dependencies and no model
// auth; node 24+ runs it natively.

import fs from "node:fs";
import path from "node:path";

const ALLOWED_KEYS = new Set(["name", "description", "disable-model-invocation"]);

export interface LintReport {
  errors: string[];
  count: number;
}

// Findings name paths relative to the linted root, so output reads the same
// whether the tool runs from inside the repo or from an install elsewhere.
function lintSkill(dir: string, root: string, errors: string[]): void {
  const skillMd = path.join(dir, "SKILL.md");
  const label = path.relative(root, skillMd);
  if (!fs.existsSync(skillMd)) {
    errors.push(`${path.relative(root, dir)}: missing SKILL.md`);
    return;
  }
  const text = fs.readFileSync(skillMd, "utf8");
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    errors.push(`${label}: frontmatter must open with --- on line 1`);
    return;
  }
  const close = lines.indexOf("---", 1);
  if (close === -1) {
    errors.push(`${label}: frontmatter never closes`);
    return;
  }

  // Raw tokens are kept alongside unquoted values: scalar type matters
  // (disable-model-invocation must be the bare YAML boolean, not "true").
  const fields = new Map<string, { raw: string; value: string }>();
  for (const line of lines.slice(1, close)) {
    const m = line.match(/^([a-z-]+):\s*(.*)$/);
    if (!m) {
      errors.push(`${label}: unparseable frontmatter line: ${line}`);
      continue;
    }
    const [, key, raw] = m;
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`${label}: unknown frontmatter key: ${key}`);
      continue;
    }
    if (fields.has(key)) {
      errors.push(`${label}: duplicate frontmatter key: ${key}`);
      continue;
    }
    const value = raw
      .replace(/^"(.*)"$/s, "$1")
      .replace(/^'(.*)'$/s, "$1")
      .trim();
    fields.set(key, { raw: raw.trim(), value });
  }

  const name = fields.get("name")?.value ?? "";
  if (name !== path.basename(dir)) {
    errors.push(
      `${label}: frontmatter name ${JSON.stringify(name)} != directory ${path.basename(dir)}`,
    );
  }
  if (!fields.get("description")?.value) {
    errors.push(`${label}: description is required and must be non-empty`);
  }
  const dmi = fields.get("disable-model-invocation");
  if (dmi !== undefined && dmi.raw !== "true") {
    errors.push(
      `${label}: disable-model-invocation must be the literal boolean true, got ${JSON.stringify(dmi.raw)}`,
    );
  }

  // Relative links in the body must resolve; external and anchor links pass.
  // Code spans and fences are stripped first so example links never lint, and
  // optional link titles ("...") are parsed rather than hiding the target.
  const body = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/`[^`\n]*`/g, "");
  for (const link of body.matchAll(/\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g)) {
    const target = link[1].replace(/^<(.*)>$/, "$1");
    if (/^[a-z][a-z+.-]*:/.test(target) || target.startsWith("#") || target === "") continue;
    const resolved = path.join(dir, target.split("#")[0]);
    if (!fs.existsSync(resolved)) {
      errors.push(`${label}: link target does not exist: ${target}`);
    }
  }
}

// Pure-ish reducer over a root: reads the tree, returns findings, prints
// nothing. The layout contract is frozen at <root>/skills/<skill>/.
export function lintSkills(root: string): LintReport {
  const roots = ["skills", ...fs.globSync("cli/*/skills", { cwd: root })].map((r) =>
    path.join(root, r),
  );
  const errors: string[] = [];
  let count = 0;
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Dot-dirs (.claude-plugin) are plugin metadata, not skill packages.
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      lintSkill(path.join(dir, entry.name), root, errors);
      count++;
    }
  }
  return { errors, count };
}
