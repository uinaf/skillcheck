# @uinaf/skillcheck

lint and eval harness for agent skills. one CLI with two halves: a keyless
structural lint any repo can run in CI, and a promptfoo-driven eval loop that
grades what a skill actually makes an agent do.

built for [uinaf](https://uinaf.dev) skill repos. nothing in it is
uinaf-specific — it ships no opinion about what a skill should say, only about
where skills sit and how a scenario is scored.

## install

```sh
pnpm add -D @uinaf/skillcheck
```

node 24 or newer. the package ships compiled ESM and runs no install scripts, so
a runner using `--ignore-scripts` is fine.

installs pinned to `github:uinaf/skillcheck#v0.1.3` and earlier tags still
resolve and still work. those tags are frozen; new consumers use npm.

## layout contract

frozen, not configurable. every command reads one root: `--root <dir>`, or the
current directory.

```text
<root>/skills/<skill>/SKILL.md                       linted
<root>/skills/<skill>/evals/<scenario>/task.md       the problem + input files
<root>/skills/<skill>/evals/<scenario>/criteria.json the weighted checklist
<root>/.skillcheck/                                  results, scratch, scorecards
```

`cli/*/skills/<skill>/` is scanned too, for repos that keep a skill next to the
CLI it documents.

## commands

| command                                | what it does                                                              |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `skillcheck lint [<root>]`             | frontmatter contract, name/directory agreement, resolvable relative links |
| `skillcheck run <scenario-dir>`        | one scenario end to end — exit 0 pass, 1 fail, 2 error                    |
| `skillcheck sweep [--all]`             | every discovered scenario; skips ones that already have results           |
| `skillcheck summarize [--allow-mixed]` | reduces results into a dated scorecard                                    |

flags: `--root DIR` · `--agent MODEL` · `--judge MODEL` ·
`--harness claude|codex` · `--max-turns N`. `EVALS_CONCURRENCY` sets promptfoo's
job count, default 4.

## auth

split deliberately, so consumer repos never hold model credentials.

| half           | needs                                                 |
| -------------- | ----------------------------------------------------- |
| `lint`         | nothing — no credentials, no network, no dependencies |
| `run`, `sweep` | model auth, so sweeps stay operator-run               |

point `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` at a gateway, or fall back
to the local Claude Code session. setting `ANTHROPIC_API_KEY` moves the judge to
the plain messages API. the codex harness reuses the local `codex` login via
`CODEX_HOME`, default `~/.codex`.

## known caveat

judge calls through the gateway drop at the transport layer
([uinaf/agent-platform#28](https://github.com/uinaf/agent-platform/issues/28)).
that surfaces as an ERROR with no usable result, not as a graded FAIL — it is a
transport failure and the mitigation is a rerun. `sweep` without `--all` resumes,
so a rerun only picks up what is missing.

## docs

| doc                             | when                             |
| ------------------------------- | -------------------------------- |
| [usage](docs/usage.md)          | every subcommand and flag        |
| [scenarios](docs/scenarios.md)  | writing an eval scenario         |
| [adopting it](docs/ci.md)       | running the lint in another repo |
| [releasing](docs/releasing.md)  | the npm pipeline                 |
| [contributing](CONTRIBUTING.md) | local setup and the verify gate  |
| [security](SECURITY.md)         | reporting a vulnerability        |

## license

MIT · undefined is not a function LLC
