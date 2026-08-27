# Adopting it in a repo

Two separate decisions: run the lint in CI, and run evals on a machine that has
model auth. Only the first belongs in a consumer repo.

## Lint in CI

```sh
pnpm add -D @uinaf/skillcheck
```

Runners that install with `--ignore-scripts` are fine: the package ships
compiled ESM and has no install, prepare, or postinstall script.

```json
{ "scripts": { "skills:lint": "skillcheck lint" } }
```

```yaml
jobs:
  skills:
    name: skills lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "24"
      - run: pnpm install --frozen-lockfile
      - run: pnpm run skills:lint
```

The job needs no secrets and no network beyond the install. Node 24 is the
floor.

Run it through the script rather than a bare `npx skillcheck`: the script
resolves the version the repo pinned, and `npx` would resolve the latest one on
the registry.

## Evals

Sweeps need model credentials, so they stay off consumer CI and run from an
operator machine or a job that already holds gateway auth. They also need the
eval engine, which is an optional peer precisely so the lint-only install
above stays small. Install it next to the package on the operator machine:

```sh
pnpm add -D promptfoo @anthropic-ai/claude-agent-sdk @openai/codex-sdk
```

`run` and `sweep` check for the peers the selected harness needs and exit 2
with that install command when they are missing, so a lint-only install never
crashes into a resolution error. Then:

```sh
skillcheck sweep            # resumes: only scenarios without results
skillcheck summarize        # writes .skillcheck/scorecards/<UTC-date>.json
```

Commit `.skillcheck/scorecards/`. Gitignore the rest:

```gitignore
.skillcheck/results/
.skillcheck/scratch/
```

A scorecard is only comparable against the tree it graded, which is why every
result carries the root repo's HEAD and `summarize` refuses to mix revisions
without `--allow-mixed`.

## Upgrading

Bump the version in `package.json` and rerun the sweep. Results carry the
`tool_version` that produced them, so a scorecard says which harness build it
came from as well as which skills tree.

## The older install path

Before the package was published, consumers installed it from a git tag:

```sh
npm i -D github:uinaf/skillcheck#v0.1.3
```

Those tags are frozen and still work: they carry a committed `dist/`, and npm
12 consumers needed `allow-git=root` in `.npmrc` to accept the spec at all. The
registry install needs none of that. Tags from `v0.1.4` on are npm releases and
carry no `dist/`, so a git spec pointing at one will not run.
