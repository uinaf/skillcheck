# Adopting it in a repo

Two separate decisions: run the lint in CI, and run evals on a machine that has
model auth. Only the first belongs in a consumer repo.

## Lint in CI

Pin the tag. Git installs need no registry auth, so this works in private repos.

```sh
npm i -D github:uinaf/skillcheck#v0.1.0
```

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
floor: the package ships TypeScript and relies on node's type stripping, so
there is nothing to build and nothing older to fall back to.

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

## Upgrading

Bump the tag in `package.json` and rerun the sweep. Results carry the
`tool_version` that produced them, so a scorecard says which harness build it
came from as well as which skills tree.
