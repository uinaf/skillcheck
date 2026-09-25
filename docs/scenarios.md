# Writing scenarios

A scenario is two files in a frozen location:

```text
<root>/skills/<skill>/evals/<scenario>/task.md
<root>/skills/<skill>/evals/<scenario>/criteria.json
```

The path is the identity: `<skill>--<scenario>` names the run, the result file,
and the scorecard entry. Codex and Grok results gain `--codex` and `--grok`
suffixes, so harnesses can hold results side by side. Double hyphens and
leading or trailing hyphens in a skill or scenario name are escaped in the run
and result filename; the scorecard keeps the original name.
A directory missing either file is not discovered.

## task.md

The prompt handed to the agent, verbatim, with one piece of syntax. Input files
are embedded inline and materialized into the workdir before the run:

```md
Fix the failing check in the config below.

======= FILE: config.json =======
{ "retries": -1 }
======= END FILE =======
```

Each block is replaced in the prompt with a pointer ("Input file `config.json`
is available in your working directory.") and written to disk. Destinations
must stay under the workdir, must not collide, and must not target `.claude/`,
`.agents/`, `.grok/`, or `node_modules/`, since a fixture must not configure its
own examiner or embed generated dependencies.

Write the task the way a user would write it. Do not name the skill, describe
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

`type` must be `weighted_checklist` and the checklist must be non-empty. Every
item needs a non-empty `name` and `description` and a positive `max_score`.

Each item becomes one `llm-rubric` assertion weighted by `max_score`, inside an
assert-set with threshold 0.7. A separate `skill-used` assertion sits outside
that aggregate, so a run that produces good output without ever loading the
skill still fails. The skill counts as loaded when the harness reports a skill
call for it, or when the agent completed a read of the installed
`<config-root>/skills/<skill>/SKILL.md` in its workdir. Claude Code often reads
the file directly instead of calling its Skill tool, and either way the same
instructions reach its context.

An out-of-lane scenario, where the right answer is to decline the skill, sets
`"skill_use": "optional"` in `criteria.json`. The assertion then always passes,
and the result still records whether the skill was loaded. Omitted, it is
`"required"`. There is no test-level threshold: both must pass. The
reported score is the assert-set's weighted score; skill-used is reported
separately as a rate across trials.

Write descriptions a judge can check against the deliverable: an observable
property, not a feeling. Weight the items that would make a reviewer reject the
work.

The agent can read, search, and write files in its workdir, but has no shell.
It cannot install, build, test, or reach the network. A checklist item that
requires live proof, such as a frozen lockfile or a verified release, cannot
pass. Grade whether the deliverable names the checks it could not run and hands
them over precisely. The shell stays off because the agent runs on the
operator's machine with the operator's credentials.

Name a specific tool or version only when the skill teaches it. Otherwise grade
the property the tool provides, so an equivalent approach passes.

## What the judge sees

The agent's final message, plus every file in the workdir that differs from the
pre-run manifest. Unchanged inputs are omitted; deleted inputs, unreadable
files, and non-regular files are named rather than read.

Sections are sorted by path, each file is capped at 16,000 characters and the
appended total at 64,000, with truncation stated inline. Very large outputs make
rubric judges return nothing at all, which is why the caps exist. Keep fixtures
small enough that the deliverable fits.

## Hidden skills

A skill with `disable-model-invocation: true` is explicit-invoke-only in
production, which the agent SDK cannot simulate. So the eval copy, never the shipped one,
has the flag stripped, and the task gains a leading
`Use the <skill> skill for this task.` The eval then measures
behavior-when-invoked rather than routing. The flag is only honored inside the
frontmatter block; body text mentioning the key does not count.

## The workdir

Per run, under a scratch directory in the system temp dir
(`skillcheck-<hash of the root>/<name>/trial-<n>/`), rebuilt from scratch each
time. It stays outside the root so the agent cannot reach the skill's source,
its evals, or the repository's own agent guidance. The skill under test is installed where the harness discovers skills:
`.claude/skills/<skill>/`, plus `.agents/skills/<skill>/` on codex, or
`.grok/skills/<skill>/` on Grok, with its `evals/` directory excluded, so
criteria never leak into the agent's context.

Scenario quality is behavioral proof; [authoring](authoring.md) covers the
judgment layer lint and evals cannot grade.
