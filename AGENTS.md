# AGENTS.md

`@uinaf/skillcheck`: a lint and eval harness for agent skills, published to npm and used by uinaf skill repos.

## Tracker

[radar](https://github.com/orgs/uinaf/projects/2)

## Invariants

- The layout contract under a root is frozen, not configurable: `<root>/skills/<skill>/SKILL.md`, `<root>/skills/<skill>/evals/<scenario>/`, state in `<root>/.skillcheck/`. Every subcommand resolves exactly one root (`--root`, else the cwd). Adding a config file is how this stops being a contract.
- The lint half has no dependencies, no network, and no model auth. That is the half consumer CI runs, and it is why `skillcheck lint` works in a repo that installed with `--ignore-scripts`. Anything that gives `lint` a dependency breaks its whole reason to exist.
- `dist/transform.js` must sit beside `dist/cli.js`. `cli.ts` hands promptfoo a `file://` URL built as `path.join(here, "transform" + selfExt)`, so the transform is loaded by path, not imported. That is why `pack.entry` has two entries and `unbundle` is on; the emitted tree stays 1:1 with `src/`.
- `pack.fixedExtension` is `false` on purpose. The package is `type: module`, so `.js` is already ESM; the default would emit `.mjs` and quietly move the `bin` target out from under the tests and the tarball.
- `dist/` is generated and untracked, and `bin` points into it. So `vp pack` runs before `vp test run` in `verify` (otherwise the "invoked through a symlink, `dist/cli.js` still runs" test finds no file and passes without proving anything), and `prepublishOnly` runs `verify`, so nothing publishes an empty `dist/`.
- `test/fixtures/` is lint input, not source. One tree is deliberately broken. It is excluded from Vitest collection, Oxlint, and Oxfmt; formatting a fixture would change what the lint is asserted to reject.
- Tags `v0.1.0`–`v0.1.3` are the legacy `github:uinaf/skillcheck#<tag>` install path and must never be deleted or moved. Consumers still pin them, and semantic-release continues its version history from `v0.1.3`.
- `.github/workflows/release.yml` cannot be renamed or moved, and the `release` environment cannot be renamed. npm Trusted Publishing binds this package's OIDC identity to that exact file path plus that environment name.

## Commands

```sh
pnpm install --frozen-lockfile   # bootstrap: Node from .node-version, pnpm from packageManager
pnpm run verify                  # the gate CI runs: vp check, vp pack, vp test run
```

Prefer `vp` directly while iterating: `pnpm exec vp check`, `pnpm exec vp test run`, `pnpm exec vp pack`.

`vp check` is format + lint + type check in one pass; `vp check --fix` applies both autofixers. The pre-commit hook runs it on staged files (`.vite-hooks/pre-commit`, staged policy in `vite.config.ts`).

`run`, `sweep`, and `summarize` need model auth and are operator-run; they are not part of `verify` and never run in CI.

## Pipelines

| Workflow                             | Trigger                          | Jobs                                                      |
| ------------------------------------ | -------------------------------- | --------------------------------------------------------- |
| `.github/workflows/verify.yml`       | PR, merge queue, `workflow_call` | `verify`, `consumer`; the one definition, called by below |
| `.github/workflows/release.yml`      | push to `main`                   | (verify + secrets) → npm publish (`release` environment)  |
| `.github/workflows/secrets.yml`      | PR, `workflow_call`, weekly      | gitleaks, trufflehog                                      |
| `.github/workflows/actions-lint.yml` | `.github/workflows/**`           | actionlint, zizmor; third-party, digest-pinned, in Docker |

`verify` and `secrets` run in parallel; `release` waits on both. `[skip ci]` is declared once on the two gates, and a skipped dependency skips its dependents, so the release's own version writeback does not trigger another release.

`consumer` is the job that packs the tarball, installs it into a throwaway project, and runs `skillcheck lint` from `node_modules/.bin`. `verify` proves the source; only that proves the artifact.

Credentials are in `docs/releasing.md`.

## Docs map

| Doc                 | When                                 |
| ------------------- | ------------------------------------ |
| `README.md`         | install and consumer usage           |
| `docs/usage.md`     | every subcommand and flag            |
| `docs/scenarios.md` | writing an eval scenario             |
| `docs/adoption.md`  | adopting the lint in another repo    |
| `docs/releasing.md` | the npm pipeline and its credentials |
| `CONTRIBUTING.md`   | local setup and the verify gate      |
