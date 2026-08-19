# Authoring and auditing skills

What `lint` and evals cannot judge: whether a skill is worth routing to and
cheap to load. Use this when writing a skill or auditing one. Evidence beats
stylistic preference; run `skillcheck lint` first and let this cover the rest.

## Metadata and discovery

- `name` is concrete and easy to say out loud. `helper`, `tools`, `utils` are
  discovery smells.
- `description` is third person and says both what the skill does and when to
  use it. It is an always-loaded retrieval pointer: front-load the concrete
  action or domain that should activate it.
- One trigger per materially distinct request branch. Collapse synonyms that
  rename the same branch.
- State the main overlap boundary without naming another skill.

## Body shape

- Keep `SKILL.md` on workflow, principles, boundaries, and routing. Lead with
  the task, not a bibliography.
- Assume the model is smart; spend tokens on repo-specific judgment. Delete any
  instruction that would not change a capable model's behavior.
- Match freedom to risk: high for contextual judgment, medium when a preferred
  pattern exists, low for fragile operations.
- Say what evidence to gather and what a complete result includes. End each
  step with an observable completion condition, not "understood" or "handled".

## Progressive disclosure

- Durable detail, rubrics, and long examples go in `references/`, one hop from
  `SKILL.md`, each with a task-shaped retrieval job. Material every path needs
  stays inline.
- For repeated deterministic work, route to the target's existing framework,
  schema, task graph, or library; otherwise add a tested module in the
  project's primary language, not ad-hoc shell rendered as prose.
- When executable code belongs to another maintained project, link the exact
  public artifact and state the contract it demonstrates; do not fork it into
  prose.
- A package stays independently usable: state prerequisites and out-of-scope
  next steps locally. Never invoke, import, or assume a sibling skill.

## Audit

Grade each dimension strong, mixed, or weak:

| Dimension              | Question                                                              |
| ---------------------- | --------------------------------------------------------------------- |
| discovery              | does metadata alone route a realistic request here                    |
| workflow               | does the body say how to begin, what evidence to gather, when to stop |
| progressive disclosure | is detail in the right file                                           |
| repo fit               | are links, commands, and conventions current                          |
| verification           | is the strongest mechanical check named, plus a real evidence loop    |
| boundaries             | are limits and next steps stated without leaning on a sibling skill   |

Blockers, must-fix: invalid frontmatter; a description that fails discovery;
stale commands, paths, or links; a workflow with no start, evidence loop, or
completion; conflicts with the repo's guidance; sibling-skill dependencies.

Major findings: vague name; synonym-stuffed description; bloated `SKILL.md`;
missing or muddy boundaries; prose re-inventing a deterministic tool; abstract
examples.

## Improve

Fix blockers first, then the highest-leverage majors. Prefer the smallest
change that improves activation, decision quality, or proof. When pruning,
measure common-path context for representative requests; line count alone does
not reveal retrieval cost. After edits, rerun `skillcheck lint` and the repo's
gate, and rerun evals when behavior was the thing changed.
