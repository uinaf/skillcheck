# Writing scenarios

A scenario is two files in a fixed location; a directory missing either is not
discovered:

```text
<root>/skills/<skill>/evals/<scenario>/task.md
<root>/skills/<skill>/evals/<scenario>/criteria.json
```

The path is the identity: `<skill>--<scenario>` names the run, the result file,
and the scorecard entry. Codex and Grok results gain `--codex` and `--grok`
suffixes.

## task.md

The prompt handed to the agent, verbatim. Input files are embedded inline and
written into the workdir before the run:

```md
Fix the failing check in the config below.

======= FILE: config.json =======
{ "retries": -1 }
======= END FILE =======
```

The prompt then says "Input file `config.json` is available in your working
directory." Destinations must stay under the workdir, must not collide, and
must not target `.claude/`, `.agents/`, `.grok/`, or `node_modules/`.

Write the task the way a user would. Do not name the skill, describe its
steps, or hint at the checklist: routing is part of what is measured.
`skillcheck lint` rejects a task that names any skill in the root.

The agent runs online with a shell and web access. On a host run it has the
operator's logins, so a task must never ask for a live mutation such as
posting a comment, pushing, publishing, or writing to a shared workspace. Put
that state in fixture files and grade the plan. Checks the agent can run
itself (install, build, test, fetch a public page) are fair to require.

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

`type` must be `weighted_checklist` and the checklist non-empty. Every item
needs a non-empty `name` and `description` and a positive `max_score`. Weights
are relative. `skillcheck lint` applies these checks and the `skill_use` and
`install` rules below.

Each item becomes one `llm-rubric` assertion weighted by `max_score`, in an
assert-set with threshold 0.7. A separate `skill-used` assertion must also
pass, so good output without loading the skill still fails.

Write descriptions a judge can check against the deliverable: an observable
property, not a feeling. Weight the items that would make a reviewer reject the
work. Name a specific tool or version only when the skill teaches it;
otherwise grade the property the tool provides.

### skill_use

| Value                  | Use                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `"required"` (default) | The skill must load                                                                  |
| `"optional"`           | Out-of-lane scenario; loading is recorded, never failed                              |
| `"forbidden"`          | Near miss: fails when this skill loads. Not on Grok, whose load evidence is too thin |

## Trigger scenarios

A trigger scenario measures whether a natural prompt loads this skill when
adjacent skills compete for it. `"install"` names other skills under the same
root to install beside it, or `"all"` installs every model-invocable one.
Alternatives must be real directories, not symlinks. A hidden skill is never an
alternative and cannot be the skill under test.

- Positive: `"required"` with the alternatives installed. It fails when the
  agent routes elsewhere or loads nothing.
- Near miss: `"forbidden"` on a prompt that belongs to a neighbor or to no
  skill. The skill-used rate counts the misfires.

Keep the checklist on the outcome the right lane should produce, so a near
miss that loads nothing but does the work badly still fails. A control run of
either installs nothing and requires nothing.

## What the judge sees

The agent's final message, plus every workdir file that differs from the
pre-run manifest. Deleted inputs, unreadable files, and non-regular files are
named rather than read. Agent config roots, `node_modules`, and tool caches are
skipped.

Each file is capped at 16,000 characters and the total at 64,000. Keep
fixtures small enough that the deliverable fits.

## Hidden skills

A skill with `disable-model-invocation: true` is invoke-only. The eval copy has
the flag stripped, and the task gains a leading
`Use the <skill> skill for this task.` The eval measures behavior when
invoked, not routing.

## The workdir

Each trial runs in a fresh directory under the system temp dir, outside the
root, so the agent cannot reach the skill's source, its evals, or the
repository's agent guidance.

- The skill is installed where the harness discovers skills
  (`.claude/skills/`, plus `.agents/skills/` on Codex, or `.grok/skills/` on
  Grok), without its `evals/` directory.
- A symbolic link inside an installed skill is rejected.
- Sibling skills the skill links to, followed transitively, are installed
  beside it, so links such as `../other/SKILL.md` resolve. A control run
  installs none of them.
- A Codex run gets a private `CODEX_HOME` and `HOME` that hide the operator's
  user-level skills, plugins, and global guidance.
