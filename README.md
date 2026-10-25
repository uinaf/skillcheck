![skillcheck — lint and eval harness for agent skills.](https://uinaf.dev/og/banner/skillcheck.png)

# uinaf/skillcheck

Lint and eval harness for agent skills: a keyless structural lint any repo can
run in CI, and a promptfoo-driven eval loop that grades what a skill makes an
agent do.

## Install

```sh
pnpm add -D @uinaf/skillcheck
```

Node 24 or newer. The lint-only install has no regular dependencies and runs
no install scripts. Evals need optional peers ([adoption](docs/adoption.md)).

## Use

```sh
skillcheck lint                              # structural lint, no credentials
skillcheck run skills/wat/evals/basic        # one scenario, graded end to end
skillcheck sweep --trials 3                  # every scenario, three trials each
skillcheck summarize                         # per-scenario and per-skill scorecard
```

`run` and `sweep` need model auth ([usage](docs/usage.md#auth)).

## Layout contract

Fixed, with no config file. Every command reads one root: `--root <dir>`, or
the current directory.

```text
<root>/skills/<skill>/SKILL.md                       linted
<root>/skills/<skill>/evals/<scenario>/task.md       the problem + input files
<root>/skills/<skill>/evals/<scenario>/criteria.json the weighted checklist
<root>/.skillcheck/                                  results, scorecards
```

`cli/*/skills/<skill>/` is scanned too, for repos that keep a skill next to the
CLI it documents.

## Docs

| Doc                                                                                            | When                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [Usage](docs/usage.md)                                                                         | Every subcommand, flag, and auth path              |
| [Scenarios](docs/scenarios.md)                                                                 | Writing an eval scenario                           |
| [Adoption](docs/adoption.md)                                                                   | Wiring the lint into another repo                  |
| [Contributing](CONTRIBUTING.md)                                                                | Local setup, the verify gate, and the npm pipeline |
| [Skill quality](https://github.com/uinaf/ffss/blob/main/skills/slopaudit/references/skills.md) | Writing and auditing the skill itself              |
| [Security](https://github.com/uinaf/skillcheck/security/policy)                                | Reporting a vulnerability                          |

## License

MIT · undefined is not a function LLC
