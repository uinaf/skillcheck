# writing scenarios

a scenario is two files in a frozen location:

```text
<root>/skills/<skill>/evals/<scenario>/task.md
<root>/skills/<skill>/evals/<scenario>/criteria.json
```

the path is the identity — `<skill>--<scenario>` names the run, the result file,
and the scorecard entry. on the codex harness the name gains a `--codex` suffix,
so both harnesses can hold results side by side. a directory missing either file
is not discovered.

## task.md

the prompt handed to the agent, verbatim, with one piece of syntax. input files
are embedded inline and materialized into the workdir before the run:

```md
Fix the failing check in the config below.

======= FILE: config.json =======
{ "retries": -1 }
======= END FILE =======
```

each block is replaced in the prompt with a pointer — "Input file `config.json`
is available in your working directory." — and written to disk. destinations
must stay under the workdir, must not collide, and must not target `.claude/` or
`.agents/`, since a fixture that writes agent config would be configuring its
own examiner.

write the task the way a user would write it. do not name the skill, describe
its steps, or hint at the checklist: routing is part of what is being measured.

## criteria.json

```json
{
  "type": "weighted_checklist",
  "context": "one line describing what a good answer looks like",
  "checklist": [
    { "name": "short-handle", "description": "what the judge should look for", "max_score": 3 }
  ]
}
```

`type` must be `weighted_checklist` and the checklist must be non-empty. every
item needs a non-empty `name` and `description` and a positive `max_score`.

each item becomes one `llm-rubric` assertion weighted by `max_score`, inside an
assert-set with threshold 0.7. a separate `skill-used` assertion sits outside
that aggregate, so a run that produces good output without ever loading the
skill still fails. there is no test-level threshold: both must pass.

write descriptions a judge can check against the deliverable — an observable
property, not a feeling. weight the items that would make a reviewer reject the
work.

## what the judge sees

the agent's final message, plus every file in the workdir that differs from the
pre-run manifest. unchanged inputs are omitted; deleted inputs, unreadable
files, and non-regular files are named rather than read.

sections are sorted by path, each file is capped at 4,000 characters and the
appended total at 24,000, with truncation stated inline. very large outputs make
rubric judges return nothing at all, which is why the caps exist. keep fixtures
small enough that the deliverable fits.

## hidden skills

a skill with `disable-model-invocation: true` is explicit-invoke-only in
production, which the agent SDK cannot simulate. so the eval copy — never the
shipped one — has the flag stripped, and the task gains a leading
`Use the <skill> skill for this task.` the eval then measures
behavior-when-invoked rather than routing. the flag is only honored inside the
frontmatter block; body text mentioning the key does not count.

## the workdir

per run, under `<root>/.skillcheck/scratch/<name>/`, rebuilt from scratch each
time. the skill under test is installed at `.claude/skills/<skill>/` — and also
`.agents/skills/<skill>/` on the codex harness — with its `evals/` directory
excluded, so criteria never leak into the agent's context.
