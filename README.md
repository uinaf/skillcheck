![skillcheck — lint and eval harness for agent skills.](https://uinaf.dev/og/banner/skillcheck.png)

# uinaf/skillcheck

lint and eval harness for agent skills. one CLI with two halves: a keyless
structural lint any repo can run in CI, and a promptfoo-driven eval loop that
grades what a skill actually makes an agent do.

built for [uinaf](https://uinaf.dev) skill repos. nothing in it is
uinaf-specific. it ships no opinion about what a skill should say, only about
where skills sit and how a scenario is scored.

## install

```sh
pnpm add -D @uinaf/skillcheck
```

node 24 or newer. the package ships compiled ESM and runs no install scripts,
so a runner using `--ignore-scripts` is fine. consumers still pinned to the
pre-npm git tags are covered in [adoption](docs/adoption.md).

## use

```sh
skillcheck lint                              # structural lint, no credentials
skillcheck run skills/wat/evals/basic        # one scenario, graded end to end
skillcheck sweep && skillcheck summarize     # every scenario, then a scorecard
```

`lint` needs nothing. `run` and `sweep` need model auth, which is why sweeps
stay operator-run and consumer repos never hold credentials. every command,
flag, and auth variable is in [usage](docs/usage.md).

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

## docs

| doc                                                             | when                                  |
| --------------------------------------------------------------- | ------------------------------------- |
| [usage](docs/usage.md)                                          | every subcommand, flag, and auth path |
| [scenarios](docs/scenarios.md)                                  | writing an eval scenario              |
| [authoring](docs/authoring.md)                                  | writing and auditing the skill itself |
| [adoption](docs/adoption.md)                                    | wiring the lint into another repo     |
| [releasing](docs/releasing.md)                                  | the npm pipeline                      |
| [contributing](CONTRIBUTING.md)                                 | local setup and the verify gate       |
| [security](https://github.com/uinaf/skillcheck/security/policy) | reporting a vulnerability             |

## license

MIT · undefined is not a function LLC
