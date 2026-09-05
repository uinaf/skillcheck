# Usage

Every subcommand resolves one root, `--root <dir>` or the current directory.
`lint` also takes the root as a positional, because that is the shape CI reaches
for first.

## Lint

```sh
skillcheck lint            # lints the current repo
skillcheck lint ../other   # lints another root
```

Checks each `<root>/skills/<skill>/`:

- Frontmatter opens with `---` on line 1 and closes
- Keys are `name`, `description`, `disable-model-invocation` and nothing else,
  each at most once
- `name` equals the directory name; `description` is non-empty
- `disable-model-invocation`, when present, is the bare YAML boolean `true`.
  A quoted `"true"` is an error
- Relative links in the body resolve on disk

Code spans and fenced blocks are stripped before links are checked, so example
links never fail. External schemes and `#anchors` pass. Dot-directories under
`skills/` (`.claude-plugin`) are plugin metadata, not packages, and are skipped.

Findings print one per line, relative to the linted root, then a count. Exit 0
clean, 1 with findings.

## Run

```sh
skillcheck run skills/<skill>/evals/<scenario>
skillcheck run <scenario-dir> --agent MODEL --judge MODEL --harness codex --max-turns 80
```

Materializes the scenario into `<root>/.skillcheck/scratch/<name>/workdir`,
installs the skill under test into that workdir, drives the agent, and grades
the files it wrote. Exit 0 means pass, 1 means graded fail, and 2 means error.
Exit 2 covers missing usable promptfoo output or optional eval peers. The
message carries the exact `pnpm add` command; see
[adoption](adoption.md#evals).

A test that errored was never graded, so it exits 2, prints the provider's
message, and writes no provenance sidecar. It is never reported as
`FAIL score=0.0000`; only a real judged verdict can fail a run.

Defaults: `--harness claude`, agent `claude-opus-5`, judge `claude-opus-5`,
`--max-turns 50`. On the codex and cursor harnesses, omitting `--agent` leaves
the model to that CLI's own default.

`--harness cursor` drives the scenario through the Cursor Agent CLI
(`cursor-agent` on PATH) with the skill installed under `.cursor/skills/`;
`--agent` names a Cursor model id, e.g. `composer-2.5`. There is no promptfoo
cursor provider, so the run uses this package's own provider module, which
replays the CLI's `stream-json` output: the `result` event becomes the graded
output and `SKILL.md` reads under `.cursor/skills/` become the `skill-used`
evidence. The judge leg is unchanged.

`--judge` takes either a bare Claude model (graded through the Anthropic
selection in [auth](#auth)) or a provider-qualified promptfoo id, passed
through verbatim:

```sh
skillcheck run <scenario-dir> --judge openai:chat:gpt-5.6-sol --judge-effort high
```

A provider-qualified judge authenticates through that provider's own env
(`OPENAI_API_KEY`, plus `OPENAI_BASE_URL` for a gateway) and is recorded
verbatim in the scorecard's `judge_model` column. `--judge-effort`
(minimal|low|medium|high) sets `reasoning_effort` and requires a
provider-qualified judge; the Anthropic judge does not take one.

## Sweep

```sh
skillcheck sweep           # only scenarios without results
skillcheck sweep --all     # rerun everything
```

Walks `<root>/skills/*/evals/*` and `<root>/cli/*/skills/*/evals/*`, in sorted
order, sequentially. A scenario needs both `task.md` and `criteria.json` to be
discovered. Exit 2 if anything errored, 1 if anything failed, else 0.

`EVALS_CONCURRENCY` is passed to promptfoo as `-j` (default 4). It parallelizes
within one scenario, not across them.

One known failure mode: judge calls through a gateway can drop at the transport
layer ([uinaf/zebroid-infra#44](https://github.com/uinaf/zebroid-infra/issues/44)).
That surfaces as an ERROR with no usable result, not as a graded FAIL, and the
mitigation is a rerun. `sweep` without `--all` resumes, so a rerun only picks up
what is missing.

## Summarize

```sh
skillcheck summarize [--allow-mixed]
```

Reduces `<root>/.skillcheck/results/*.json` into
`<root>/.skillcheck/scorecards/<UTC-date>.json`: one entry per scenario with
skill, scenario, harness, tree sha, score, pass, both models, latency, tokens.

If a scorecard for today already exists, the two are merged on
`(skill, scenario, harness)`: entries from this run win, entries it did not
touch survive, and the merge is reported on stdout. Summarizing after rerunning
six of twenty-nine scenarios therefore leaves twenty-nine rows in the file, not
six. A same-date file that cannot be parsed stops the write instead of being
overwritten.

Files that are not promptfoo results and ungraded transport errors are skipped
with a warning rather than failing the reduction. Graded assertion failures
remain scored results. If a skipped file matches an existing scorecard row,
summary generation fails and leaves the scorecard unchanged, so an errored rerun
cannot carry forward its old score. This also applies with `--allow-mixed`.
Runs keep a `<name>.json.attempt` marker until a graded result and its provenance
are written. An outstanding marker makes `summarize` skip that identity even
when the child produced no result file or left partial output. The marker does
not count as a result for the sweep's existence check, so no-output failures
remain eligible for retry.

## Provenance

Each successful run writes a `<name>.meta.json` sidecar next to its result:

```json
{
  "skills_tree_sha": "<root repo HEAD at run time>",
  "harness": "claude",
  "ran_at": "<ISO timestamp>",
  "tool_version": "<skillcheck version>"
}
```

`summarize` reads those sidecars and refuses to mix skills-tree revisions in one
scorecard, including retained rows from partial reruns, unless `--allow-mixed`.
Rejection leaves the existing scorecard unchanged. With the override, the top-level `skills_tree_sha`
becomes `mixed` and per-entry shas remain. A result with no sidecar reduces as
`unattested`.

## State

`<root>/.skillcheck/` holds `scratch/` and `results/`, both disposable and safe
to gitignore, and `scorecards/`, which is meant to be committed. Nothing is ever
written inside the installed package.

## Auth

| Variable                                      | Effect                                                            |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | The claude agent and judge go through a gateway                   |
| None of the above                             | Falls back to the local Claude Code session                       |
| `ANTHROPIC_API_KEY`                           | Judge grades over `anthropic:messages:<model>` instead of the SDK |
| `CODEX_HOME` (default `~/.codex`)             | Where the codex harness finds the local `codex` CLI login         |
| `OPENAI_API_KEY`                              | Agent auth for codex when there is no local login                 |
| `CURSOR_API_KEY`                              | Agent auth for cursor; a logged-in `cursor-agent` also works      |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL`          | A provider-qualified `--judge openai:…`, optionally via a gateway |

A bare `--judge` model stays on the Anthropic selection regardless of the
agent harness; a provider-qualified `--judge` uses that provider's env instead.
