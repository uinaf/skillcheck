# Usage

Every subcommand resolves one root — `--root <dir>`, or the current directory.
`lint` also takes the root as a positional, because that is the shape CI reaches
for first.

## lint

```sh
skillcheck lint            # lints the current repo
skillcheck lint ../other   # lints another root
```

Checks each `<root>/skills/<skill>/`:

- frontmatter opens with `---` on line 1 and closes
- keys are `name`, `description`, `disable-model-invocation` and nothing else,
  each at most once
- `name` equals the directory name; `description` is non-empty
- `disable-model-invocation`, when present, is the bare YAML boolean `true` —
  a quoted `"true"` is an error
- relative links in the body resolve on disk

Code spans and fenced blocks are stripped before links are checked, so example
links never fail. External schemes and `#anchors` pass. Dot-directories under
`skills/` (`.claude-plugin`) are plugin metadata, not packages, and are skipped.

Findings print one per line, relative to the linted root, then a count. Exit 0
clean, 1 with findings.

## run

```sh
skillcheck run skills/<skill>/evals/<scenario>
skillcheck run <scenario-dir> --agent MODEL --judge MODEL --harness codex --max-turns 80
```

Materializes the scenario into `<root>/.skillcheck/scratch/<name>/workdir`,
installs the skill under test into that workdir, drives the agent, and grades
the files it wrote. Exit 0 pass, 1 graded fail, 2 error (promptfoo produced no
usable result).

Defaults: `--harness claude`, agent `claude-opus-5`, judge `claude-opus-5`,
`--max-turns 50`. On the codex harness, omitting `--agent` leaves the model to
the Codex CLI's own default.

## sweep

```sh
skillcheck sweep           # only scenarios without results
skillcheck sweep --all     # rerun everything
```

Walks `<root>/skills/*/evals/*` and `<root>/cli/*/skills/*/evals/*`, in sorted
order, sequentially. A scenario needs both `task.md` and `criteria.json` to be
discovered. Exit 2 if anything errored, 1 if anything failed, else 0.

`EVALS_CONCURRENCY` is passed to promptfoo as `-j` (default 4). It parallelizes
within one scenario, not across them.

## summarize

```sh
skillcheck summarize [--allow-mixed]
```

Reduces `<root>/.skillcheck/results/*.json` into
`<root>/.skillcheck/scorecards/<UTC-date>.json`: one entry per scenario with
skill, scenario, harness, tree sha, score, pass, both models, latency, tokens.

Files that are not promptfoo results are skipped with a warning rather than
failing the reduction.

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
scorecard unless `--allow-mixed`, in which case the top-level `skills_tree_sha`
becomes `mixed` and per-entry shas remain. A result with no sidecar reduces as
`unattested`.

## State

`<root>/.skillcheck/` holds `scratch/` and `results/` — both disposable, both
safe to gitignore — and `scorecards/`, which is meant to be committed. Nothing
is ever written inside the installed package.

## Auth

- Claude agent and judge: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` for a
  gateway, or nothing at all to fall back to the local Claude Code session.
- `ANTHROPIC_API_KEY`: judge grades over `anthropic:messages:<model>` instead of
  the agent SDK.
- Codex agent: the local `codex` CLI login, found via `CODEX_HOME` (default
  `~/.codex`), or `OPENAI_API_KEY`. The judge stays on the Anthropic selection.
