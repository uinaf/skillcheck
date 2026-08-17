# authoring and auditing skills

what `lint` and evals cannot judge: whether a skill is worth routing to and
cheap to load. use this when writing a skill or auditing one. evidence beats
stylistic preference; run `skillcheck lint` first and let this cover the rest.

## metadata and discovery

- `name` is concrete and easy to say out loud. `helper`, `tools`, `utils` are
  discovery smells.
- `description` is third person and says both what the skill does and when to
  use it. it is an always-loaded retrieval pointer: front-load the concrete
  action or domain that should activate it.
- one trigger per materially distinct request branch. collapse synonyms that
  rename the same branch.
- state the main overlap boundary without naming another skill.

## body shape

- keep `SKILL.md` on workflow, principles, boundaries, and routing. lead with
  the task, not a bibliography.
- assume the model is smart; spend tokens on repo-specific judgment. delete any
  instruction that would not change a capable model's behavior.
- match freedom to risk: high for contextual judgment, medium when a preferred
  pattern exists, low for fragile operations.
- say what evidence to gather and what a complete result includes. end each
  step with an observable completion condition, not "understood" or "handled".

## progressive disclosure

- durable detail, rubrics, and long examples go in `references/`, one hop from
  `SKILL.md`, each with a task-shaped retrieval job. material every path needs
  stays inline.
- for repeated deterministic work, route to the target's existing framework,
  schema, task graph, or library; otherwise add a tested module in the
  project's primary language, not ad-hoc shell rendered as prose.
- when executable code belongs to another maintained project, link the exact
  public artifact and state the contract it demonstrates; do not fork it into
  prose.
- a package stays independently usable: state prerequisites and out-of-scope
  next steps locally. never invoke, import, or assume a sibling skill.

## audit

grade each dimension strong, mixed, or weak:

| dimension              | question                                                              |
| ---------------------- | --------------------------------------------------------------------- |
| discovery              | does metadata alone route a realistic request here                    |
| workflow               | does the body say how to begin, what evidence to gather, when to stop |
| progressive disclosure | is detail in the right file                                           |
| repo fit               | are links, commands, and conventions current                          |
| verification           | is the strongest mechanical check named, plus a real evidence loop    |
| boundaries             | are limits and next steps stated without leaning on a sibling skill   |

blockers, must-fix: invalid frontmatter; a description that fails discovery;
stale commands, paths, or links; a workflow with no start, evidence loop, or
completion; conflicts with the repo's guidance; sibling-skill dependencies.

major findings: vague name; synonym-stuffed description; bloated `SKILL.md`;
missing or muddy boundaries; prose re-inventing a deterministic tool; abstract
examples.

## improve

fix blockers first, then the highest-leverage majors. prefer the smallest
change that improves activation, decision quality, or proof. when pruning,
measure common-path context for representative requests; line count alone does
not reveal retrieval cost. after edits, rerun `skillcheck lint` and the repo's
gate, and rerun evals when behavior was the thing changed.
