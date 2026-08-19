# usage

every subcommand resolves one root, `--root <dir>` or the current directory.
`lint` also takes the root as a positional, because that is the shape CI reaches
for first.

## lint

```sh
skillcheck lint            # lints the current repo
skillcheck lint ../other   # lints another root
```

checks each `<root>/skills/<skill>/`:

- frontmatter opens with `---` on line 1 and closes
- keys are `name`, `description`, `disable-model-invocation` and nothing else,
  each at most once
- `name` equals the directory name; `description` is non-empty
- `disable-model-invocation`, when present, is the bare YAML boolean `true`.
  a quoted `"true"` is an error
- relative links in the body resolve on disk

code spans and fenced blocks are stripped before links are checked, so example
links never fail. external schemes and `#anchors` pass. dot-directories under
`skills/` (`.claude-plugin`) are plugin metadata, not packages, and are skipped.

findings print one per line, relative to the linted root, then a count. exit 0
clean, 1 with findings.

## run

```sh
skillcheck run skills/<skill>/evals/<scenario>
skillcheck run <scenario-dir> --agent MODEL --judge MODEL --harness codex --max-turns 80
```

materializes the scenario into `<root>/.skillcheck/scratch/<name>/workdir`,
installs the skill under test into that workdir, drives the agent, and grades
the files it wrote. exit 0 pass, 1 graded fail, 2 error (promptfoo produced no
usable result).

a test that errored was never graded, so it exits 2, prints the provider's
message, and writes no provenance sidecar. it is never reported as
`FAIL score=0.0000`; only a real judged verdict can fail a run.

defaults: `--harness claude`, agent `claude-opus-5`, judge `claude-opus-5`,
`--max-turns 50`. on the codex and cursor harnesses, omitting `--agent` leaves
the model to that CLI's own default.

`--harness cursor` drives the scenario through the Cursor Agent CLI
(`cursor-agent` on PATH) with the skill installed under `.cursor/skills/`;
`--agent` names a Cursor model id, e.g. `composer-2.5`. there is no promptfoo
cursor provider, so the run uses this package's own provider module, which
replays the CLI's `stream-json` output: the `result` event becomes the graded
output and `SKILL.md` reads under `.cursor/skills/` become the `skill-used`
evidence. the judge leg is unchanged.

`--judge` takes either a bare Claude model (graded through the Anthropic
selection in [auth](#auth)) or a provider-qualified promptfoo id, passed
through verbatim:

```sh
skillcheck run <scenario-dir> --judge openai:chat:gpt-5.6-sol --judge-effort high
```

a provider-qualified judge authenticates through that provider's own env
(`OPENAI_API_KEY`, plus `OPENAI_BASE_URL` for a gateway) and is recorded
verbatim in the scorecard's `judge_model` column. `--judge-effort`
(minimal|low|medium|high) sets `reasoning_effort` and requires a
provider-qualified judge; the Anthropic judge does not take one.

## sweep

```sh
skillcheck sweep           # only scenarios without results
skillcheck sweep --all     # rerun everything
```

walks `<root>/skills/*/evals/*` and `<root>/cli/*/skills/*/evals/*`, in sorted
order, sequentially. a scenario needs both `task.md` and `criteria.json` to be
discovered. exit 2 if anything errored, 1 if anything failed, else 0.

`EVALS_CONCURRENCY` is passed to promptfoo as `-j` (default 4). it parallelizes
within one scenario, not across them.

one known failure mode: judge calls through a gateway can drop at the transport
layer ([uinaf/agent-platform#28](https://github.com/uinaf/agent-platform/issues/28)).
that surfaces as an ERROR with no usable result, not as a graded FAIL, and the
mitigation is a rerun. `sweep` without `--all` resumes, so a rerun only picks up
what is missing.

## summarize

```sh
skillcheck summarize [--allow-mixed]
```

reduces `<root>/.skillcheck/results/*.json` into
`<root>/.skillcheck/scorecards/<UTC-date>.json`: one entry per scenario with
skill, scenario, harness, tree sha, score, pass, both models, latency, tokens.

if a scorecard for today already exists, the two are merged on
`(skill, scenario, harness)`: entries from this run win, entries it did not
touch survive, and the merge is reported on stdout. summarizing after rerunning
six of twenty-nine scenarios therefore leaves twenty-nine rows in the file, not
six. a same-date file that cannot be parsed stops the write instead of being
overwritten.

files that are not promptfoo results are skipped with a warning rather than
failing the reduction.

## provenance

each successful run writes a `<name>.meta.json` sidecar next to its result:

```json
{
  "skills_tree_sha": "<root repo HEAD at run time>",
  "harness": "claude",
  "ran_at": "<ISO timestamp>",
  "tool_version": "<skillcheck version>"
}
```

`summarize` reads those sidecars and refuses to mix skills-tree revisions in one
scorecard unless `--allow-mixed`, in which case the top-level `skills_tree_sha`
becomes `mixed` and per-entry shas remain. a result with no sidecar reduces as
`unattested`.

## state

`<root>/.skillcheck/` holds `scratch/` and `results/`, both disposable and safe
to gitignore, and `scorecards/`, which is meant to be committed. nothing is ever
written inside the installed package.

## auth

| variable                                      | effect                                                            |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | claude agent and judge go through a gateway                       |
| none of the above                             | falls back to the local Claude Code session                       |
| `ANTHROPIC_API_KEY`                           | judge grades over `anthropic:messages:<model>` instead of the SDK |
| `CODEX_HOME` (default `~/.codex`)             | where the codex harness finds the local `codex` CLI login         |
| `OPENAI_API_KEY`                              | codex agent auth when there is no local login                     |
| `CURSOR_API_KEY`                              | cursor agent auth; a logged-in `cursor-agent` also works          |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL`          | a provider-qualified `--judge openai:…`, optionally via a gateway |

a bare `--judge` model stays on the Anthropic selection regardless of the
agent harness; a provider-qualified `--judge` uses that provider's env instead.
