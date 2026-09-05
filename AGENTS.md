# AGENTS.md

`@uinaf/skillcheck`: a lint and eval harness for agent skills, published to npm and used by uinaf skill repos.

## Tracker

[radar](https://github.com/orgs/uinaf/projects/2)

## Invariants

- The layout contract under a root is frozen, not configurable: `<root>/skills/<skill>/SKILL.md`, `<root>/skills/<skill>/evals/<scenario>/`, state in `<root>/.skillcheck/`. Every subcommand resolves exactly one root (`--root`, else the cwd). Adding a config file is how this stops being a contract.
- The lint half has no dependencies, no network, and no model auth. That is the half consumer CI runs, and it is why `skillcheck lint` works in a repo that installed with `--ignore-scripts`. Anything that gives `lint` a dependency breaks its whole reason to exist.
- The package declares zero regular `dependencies`. The eval engine (`promptfoo`) and provider
  SDKs are optional `peerDependencies`, plus devDependencies here. promptfoo brings about 670
  packages, including Playwright, SWC, ONNX Runtime, and Sharp. A lint-only consumer must never
  install them. `run` and `sweep` preflight the peers required by the selected harness and judge,
  then exit 2 with the exact install command when one is missing. promptfoo runs from its resolved
  install path. Never use `npx`, which would fetch an unpinned copy from the registry.
- `dist/cursor-process.js` must sit beside `dist/cursor-provider.js`: the Cursor
  provider forks this supervisor by file URL. Keep its explicit pack entry and
  the installed-consumer fake-process proof when changing packaging.
- `dist/transform.js` must sit beside `dist/cli.js`. `cli.ts` hands promptfoo a `file://` URL built as `path.join(here, "transform" + selfExt)`, so the transform is loaded by path, not imported. That is why the transform has an explicit `pack.entry` and `unbundle` is on; the emitted tree stays 1:1 with `src/`.
- `pack.fixedExtension` is `false` on purpose. The package is `type: module`, so `.js` is already ESM; the default would emit `.mjs` and quietly move the `bin` target out from under the tests and the tarball.
- `dist/` is generated and untracked, and `bin` points into it. So the Vite+ graph runs `pack` before both test lanes (otherwise the "invoked through a symlink, `dist/cli.js` still runs" test finds no file and passes without proving anything), and `prepublishOnly` forces the full graph, so nothing publishes an empty `dist/`.
- `test/fixtures/` is lint input, not source. One tree is deliberately broken. It is excluded from Vitest collection, Oxlint, and Oxfmt; formatting a fixture would change what the lint is asserted to reject.
- Tags `v0.1.0`–`v0.1.3` are the legacy `github:uinaf/skillcheck#<tag>` install path and must never be deleted or moved. Consumers still pin them, and semantic-release continues its version history from `v0.1.3`.
- `.github/workflows/release.yml` cannot be renamed or moved, and the `release` environment cannot be renamed. Trusted Publishing on npm binds this package's OIDC identity to that exact file path plus that environment name.

## Commands

```sh
pnpm install --frozen-lockfile   # bootstrap: Node from .node-version, pnpm from packageManager
pnpm run verify                  # cached affected Vite+ graph
pnpm run verify:full             # uncached gate CI and publishing run
```

Prefer `vp` directly while iterating: `pnpm exec vp check`, `pnpm exec vp test run`, `pnpm exec vp pack`.

`vp check` is format + lint + type check in one pass; `vp check --fix` applies both autofixers. The pre-commit hook runs it on staged files (`.vite-hooks/pre-commit`, staged policy in `vite.config.ts`).

`run`, `sweep`, and `summarize` need model auth and are operator-run; they are not part of `verify` and never run in CI.

## Pipelines

| Workflow                        | Trigger                          | Jobs                                                                                    |
| ------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `.github/workflows/verify.yml`  | PR, merge queue, `workflow_call` | `verify`; the one definition, called by below                                           |
| `.github/workflows/release.yml` | Push to `main`                   | (verify + scan) → npm publish (`release` environment)                                   |
| `.github/workflows/scan.yml`    | PR, weekly                       | Caller for the shared scan in `uinaf/.github`: gitleaks, trufflehog, actionlint, zizmor |

`verify` and `scan` run in parallel; `release` waits on both. `[skip ci]` is declared once on the two gates, and a skipped dependency skips its dependents, so the release's own version writeback does not trigger another release.

`test/consumer.test.ts` packs the tarball, installs it without scripts or eval peers, and runs `skillcheck lint` from `node_modules/.bin`. The same `verify` graph proves both source and artifact locally; CI forces that graph without cache.

Credentials are in [docs/releasing.md](docs/releasing.md).

## Docs map

| Doc                                    | When                                  |
| -------------------------------------- | ------------------------------------- |
| [README.md](README.md)                 | Install and consumer usage            |
| [docs/usage.md](docs/usage.md)         | Every subcommand and flag             |
| [docs/scenarios.md](docs/scenarios.md) | Writing an eval scenario              |
| [docs/authoring.md](docs/authoring.md) | Writing and auditing the skill itself |
| [docs/adoption.md](docs/adoption.md)   | Adopting the lint in another repo     |
| [docs/releasing.md](docs/releasing.md) | The npm pipeline and its credentials  |
| [CONTRIBUTING.md](CONTRIBUTING.md)     | Local setup and the verify gate       |
