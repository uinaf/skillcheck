# Adopting it in a repo

Two separate decisions: run the lint in CI, and run evals on a machine that has
model auth. Only the first belongs in a consumer repo.

## Lint in CI

Pin the tag. Git installs need no registry auth, so this works in private repos.

```sh
npm i -D github:uinaf/skillcheck#v0.1.2
```

npm 12 defaults `allow-git` to `none` and will refuse the spec outright. Add one
line to the consumer's `.npmrc` — `allow-git=root` permits git dependencies the
root project declares, without opening the door transitively:

```ini
allow-git=root
```

Runners that install with `--ignore-scripts` are fine: the package ships its
compiled `dist/` and has no install, prepare, or postinstall script.

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
          cache: npm
      - run: npm ci
      - run: npm run skills:lint
```

The job needs no secrets and no network beyond the install. Node 24 is the
floor.

Run it through the script rather than a bare `npx skillcheck`, which would
resolve against the public registry instead of the pinned install.

## Evals

Sweeps need model credentials, so they stay off consumer CI and run from an
operator machine or a job that already holds gateway auth:

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

## Why the package carries compiled output

Node refuses to strip types from any file under `node_modules`, so an installed
copy cannot run the TypeScript sources; and npm 12 blocks a dependency's
`prepare` script by default, so building at install time is not dependable
either. The package therefore commits `dist/`, and CI rebuilds it on every push
and fails on any diff. Edit `src/`, never `dist/`.

## Upgrading

Bump the tag in `package.json` and rerun the sweep. Results carry the
`tool_version` that produced them, so a scorecard says which harness build it
came from as well as which skills tree.
