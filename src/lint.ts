import fs from "node:fs";
import path from "node:path";
import { FILE_BLOCK, isHiddenSkill, parseCriteria } from "./scenario.ts";

const ALLOWED_KEYS = new Set(["name", "description", "disable-model-invocation"]);

export interface LintReport {
  errors: Array<string>;
  count: number;
}

function lintSkill(dir: string, root: string, errors: Array<string>): void {
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

  const body = lines
    .slice(close + 1)
    .join("\n")
    .replaceAll(/^```[\s\S]*?^```/gm, "")
    .replaceAll(/`[^`\n]*`/g, "");

  for (const link of body.matchAll(/\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g)) {
    const target = link[1].replace(/^<(.*)>$/, "$1");

    if (/^[a-z][a-z+.-]*:/.test(target) || target.startsWith("#") || target === "") {
      continue;
    }

    const resolved = path.join(dir, target.split("#")[0]);

    if (!fs.existsSync(resolved)) {
      errors.push(`${label}: link target does not exist: ${target}`);
    }
  }
}

export function lintSkills(root: string): LintReport {
  const roots = ["skills", ...fs.globSync("cli/*/skills", { cwd: root })].map((r) =>
    path.join(root, r),
  );

  const errors: Array<string> = [];
  const skills: Array<string> = [];

  for (const dir of roots) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      lintSkill(path.join(dir, entry.name), root, errors);
      skills.push(path.join(dir, entry.name));
    }
  }

  lintEvals(skills, root, errors);

  return { errors, count: skills.length };
}

function lintEvals(skills: Array<string>, root: string, errors: Array<string>): void {
  const names = skills.map((dir) => path.basename(dir));

  for (const dir of skills) {
    const evals = path.join(dir, "evals");

    if (!fs.existsSync(evals)) {
      continue;
    }

    const skillMd = path.join(dir, "SKILL.md");
    const hidden = fs.existsSync(skillMd) && isHiddenSkill(fs.readFileSync(skillMd, "utf8"));

    for (const scenario of fs.readdirSync(evals, { withFileTypes: true })) {
      if (!scenario.isDirectory()) {
        continue;
      }

      const scenarioDir = path.join(evals, scenario.name);
      const criteria = path.join(scenarioDir, "criteria.json");

      if (fs.existsSync(criteria)) {
        try {
          parseCriteria(scenarioDir, hidden);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${path.relative(root, criteria)}: ${message}`);
        }
      }

      const file = path.join(scenarioDir, "task.md");

      if (!fs.existsSync(file)) {
        continue;
      }

      const text = fs.readFileSync(file, "utf8").replace(FILE_BLOCK, "");

      for (const name of names) {
        const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

        if (new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text)) {
          errors.push(`${path.relative(root, file)}: task names skill ${name}`);
        }
      }
    }
  }
}
