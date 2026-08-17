# adopting it in a repo

two separate decisions: run the lint in CI, and run evals on a machine that has
model auth. only the first belongs in a consumer repo.

## lint in CI

```sh
pnpm add -D @uinaf/skillcheck
```

runners that install with `--ignore-scripts` are fine: the package ships
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

the job needs no secrets and no network beyond the install. node 24 is the
floor.

run it through the script rather than a bare `npx skillcheck`: the script
resolves the version the repo pinned, and `npx` would resolve the latest one on
the registry.

## evals

sweeps need model credentials, so they stay off consumer CI and run from an
operator machine or a job that already holds gateway auth:

```sh
skillcheck sweep            # resumes: only scenarios without results
skillcheck summarize        # writes .skillcheck/scorecards/<UTC-date>.json
```

commit `.skillcheck/scorecards/`. gitignore the rest:

```gitignore
.skillcheck/results/
.skillcheck/scratch/
```

a scorecard is only comparable against the tree it graded, which is why every
result carries the root repo's HEAD and `summarize` refuses to mix revisions
without `--allow-mixed`.

## upgrading

bump the version in `package.json` and rerun the sweep. results carry the
`tool_version` that produced them, so a scorecard says which harness build it
came from as well as which skills tree.

## the older install path

before the package was published, consumers installed it from a git tag:

```sh
npm i -D github:uinaf/skillcheck#v0.1.3
```

those tags are frozen and still work — they carry a committed `dist/`, and npm
12 consumers needed `allow-git=root` in `.npmrc` to accept the spec at all. the
registry install needs none of that. tags from `v0.1.4` on are npm releases and
carry no `dist/`, so a git spec pointing at one will not run.
