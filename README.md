# skillcheck

Lint and eval harness for agent skills. One CLI with two halves: a keyless
structural lint that any repo can run in CI, and a promptfoo-driven eval loop
that grades what a skill actually makes an agent do.

Built for [uinaf](https://uinaf.dev) skill repos. Nothing in it is uinaf-specific
— it ships no opinion about what a skill should say, only about where skills sit
and how a scenario is scored.

## Install

Tag-pinned git installs. No registry auth, so private repos work the same way.

```sh
npm i -D github:uinaf/skillcheck#v0.1.3
```

npm 12 refuses git dependencies by default. Consumers on it need one line in
`.npmrc`:

```ini
allow-git=root
```

That permits git specs the root project declares, and nothing transitively.

Node 24 or newer. Source is TypeScript; the package ships the compiled `dist/`
alongside it and installs run no scripts.

## Layout contract

Frozen, not configurable. Every command reads one root: `--root <dir>`, or the
current directory.

```
<root>/skills/<skill>/SKILL.md                       linted
<root>/skills/<skill>/evals/<scenario>/task.md       the problem + input files
<root>/skills/<skill>/evals/<scenario>/criteria.json the weighted checklist
<root>/.skillcheck/                                  results, scratch, scorecards
```

`cli/*/skills/<skill>/` is scanned too, for repos that keep a skill next to the
CLI it documents.

## Commands

| Command | What it does |
| --- | --- |
| `skillcheck lint [<root>]` | Frontmatter contract, name/directory agreement, resolvable relative links |
| `skillcheck run <scenario-dir>` | One scenario end to end — exit 0 pass, 1 fail, 2 error |
| `skillcheck sweep [--all]` | Every discovered scenario; skips ones that already have results |
| `skillcheck summarize [--allow-mixed]` | Reduces results into a dated scorecard |

Flags: `--root DIR` · `--agent MODEL` · `--judge MODEL` ·
`--harness claude|codex` · `--max-turns N`. `EVALS_CONCURRENCY` sets
promptfoo's job count, default 4.

More in [usage](docs/usage.md), [writing scenarios](docs/scenarios.md), and
[adopting it in a repo](docs/ci.md).

## Auth

Split deliberately, so consumer repos never hold model credentials.

- **lint** — no credentials, no network, no dependencies. This is the half that
  belongs in every skill repo's CI.
- **run / sweep** — model auth required, so sweeps stay operator-run. Point
  `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` at a gateway, or fall back to
  the local Claude Code session. Setting `ANTHROPIC_API_KEY` moves the judge to
  the plain messages API. The codex harness reuses the local `codex` login via
  `CODEX_HOME`, default `~/.codex`.

## Known caveat

Judge calls through the gateway drop at the transport layer
([uinaf/agent-platform#28](https://github.com/uinaf/agent-platform/issues/28)).
That surfaces as an ERROR with no usable result, not as a graded FAIL — it is a
transport failure and the mitigation is a rerun. `sweep` without `--all` resumes,
so a rerun only picks up what is missing.

## License

MIT · undefined is not a function LLC
