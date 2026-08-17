// promptfoo output transform: append files the agent created or changed in the
// scenario workdir, so llm-rubric grades the deliverables, not just chat text.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface TransformContext {
  vars: { workdir: string; manifest: string; [key: string]: string };
}

// Rubric judges choke on very large graded outputs (observed: a 117KB
// transcript+deliverable dump returned "No output" for every rubric call).
// Cap each file and the total; truncation is explicit so the judge knows.
const PER_FILE_CAP = 4_000;
const TOTAL_CAP = 24_000;

// String.slice can split a surrogate pair; back off one unit when it would.
function safeSlice(text: string, end: number): string {
  let cut = text.slice(0, end);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

function capped(rel: string, text: string): string {
  if (text.length <= PER_FILE_CAP)
    return `=== OUTPUT FILE: ${rel} ===\n${text}\n=== END OUTPUT FILE ===`;
  return `=== OUTPUT FILE: ${rel} (truncated: showing ${PER_FILE_CAP} of ${text.length} chars) ===\n${safeSlice(text, PER_FILE_CAP)}\n=== END OUTPUT FILE ===`;
}

export default function transform(output: string, context: TransformContext): string {
  const workdir = context.vars.workdir;
  const manifest: Record<string, string> = JSON.parse(
    fs.readFileSync(context.vars.manifest, "utf8"),
  );
  const sections: { rel: string; text: string }[] = [];
  const visited = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".claude") walk(p);
      } else if (e.isFile()) {
        const rel = path.relative(workdir, p);
        visited.add(rel);
        let body;
        try {
          body = fs.readFileSync(p);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          sections.push({ rel, text: `=== UNREADABLE FILE: ${rel} === (${detail})` });
          continue;
        }
        const hash = createHash("sha256").update(body).digest("hex");
        if (manifest[rel] !== hash) {
          sections.push({ rel, text: capped(rel, body.toString("utf8")) });
        }
      } else {
        // Symlinks, FIFOs, sockets: name them for the judge, never read them.
        const nrel = path.relative(workdir, p);
        sections.push({ rel: nrel, text: `=== NON-REGULAR FILE: ${nrel} ===` });
      }
    }
  };
  walk(workdir);
  for (const rel of Object.keys(manifest)) {
    if (!visited.has(rel))
      sections.push({
        rel,
        text: `=== DELETED FILE: ${rel} === (input file removed by the agent)`,
      });
  }
  if (sections.length === 0) return output;
  // Deterministic path order: the total cap must not drop files by readdir
  // whim; later-sorting files are still the ones cut, but reproducibly so.
  sections.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let appended = sections.map((s) => s.text).join("\n\n");
  if (appended.length > TOTAL_CAP) {
    appended = `${safeSlice(appended, TOTAL_CAP)}\n\n=== TRUNCATED: output files exceeded ${TOTAL_CAP} chars total ===`;
  }
  return `${output}\n\n${appended}`;
}
