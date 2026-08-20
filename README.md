![skillcheck — lint and eval harness for agent skills.](https://uinaf.dev/og/banner/skillcheck.png)

# uinaf/skillcheck

Lint and eval harness for agent skills. One CLI with two halves: a keyless
structural lint any repo can run in CI, and a promptfoo-driven eval loop that
grades what a skill actually makes an agent do.

Built for [uinaf](https://uinaf.dev) skill repos. Nothing in it is
uinaf-specific. It ships no opinion about what a skill should say, only about
where skills sit and how a scenario is scored.

## Install

```sh
pnpm add -D @uinaf/skillcheck
```

Node 24 or newer. The package ships compiled ESM, runs no install scripts, and
has no regular dependencies, so a runner using `--ignore-scripts` is fine and
the lint-only install stays at a handful of packages. The promptfoo eval engine
and provider SDKs are optional peers, installed only on the operator machine
that runs evals ([adoption](docs/adoption.md)). Consumers still pinned to the
pre-npm git tags are covered there too.

## Use

```sh
skillcheck lint                              # structural lint, no credentials
skillcheck run skills/wat/evals/basic        # one scenario, graded end to end
skillcheck sweep && skillcheck summarize     # every scenario, then a scorecard
```

`lint` needs nothing. `run` and `sweep` need model auth, which is why sweeps
stay operator-run and consumer repos never hold credentials. Every command,
flag, and auth variable is in [usage](docs/usage.md).

## Layout contract

Frozen, not configurable. Every command reads one root: `--root <dir>`, or the
current directory.

```text
<root>/skills/<skill>/SKILL.md                       linted
<root>/skills/<skill>/evals/<scenario>/task.md       the problem + input files
<root>/skills/<skill>/evals/<scenario>/criteria.json the weighted checklist
<root>/.skillcheck/                                  results, scratch, scorecards
```

`cli/*/skills/<skill>/` is scanned too, for repos that keep a skill next to the
CLI it documents.

## Docs

| Doc                                                             | When                                  |
| --------------------------------------------------------------- | ------------------------------------- |
| [Usage](docs/usage.md)                                          | Every subcommand, flag, and auth path |
| [Scenarios](docs/scenarios.md)                                  | Writing an eval scenario              |
| [Authoring](docs/authoring.md)                                  | Writing and auditing the skill itself |
| [Adoption](docs/adoption.md)                                    | Wiring the lint into another repo     |
| [Releasing](docs/releasing.md)                                  | The npm pipeline                      |
| [Contributing](CONTRIBUTING.md)                                 | Local setup and the verify gate       |
| [Security](https://github.com/uinaf/skillcheck/security/policy) | Reporting a vulnerability             |

## License

MIT · undefined is not a function LLC
