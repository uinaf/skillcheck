# AGENTS.md

`@uinaf/skillcheck`: a lint and eval harness for agent skills, published to npm and used by uinaf skill repos.

## Invariants

- The layout under a root is a fixed contract with no config file: `<root>/skills/<skill>/SKILL.md`, `<root>/skills/<skill>/evals/<scenario>/`, state in `<root>/.skillcheck/`. Every subcommand resolves one root: `--root`, else the cwd.
- `lint` has no dependencies, no network, and no model auth. Consumer CI runs it, including installs with `--ignore-scripts`.
- The package has zero regular `dependencies`. promptfoo (about 670 packages, including Playwright, ONNX Runtime, and Sharp) and the provider SDKs are optional `peerDependencies`, so a lint-only consumer stays small. `run` and `sweep` preflight the peers they need and exit 2 with the install command when one is missing. promptfoo runs from its resolved install path; `npx` would fetch an unpinned copy.
- `dist/transform.js`, `dist/grok-provider.js`, and `dist/skill-evidence.js` are loaded by `file://` URL from beside `dist/cli.js` (`src/cli.ts`, `selfExt`). That is why each has its own `pack.entry` in `vite.config.ts` and `unbundle` is on: `dist/` mirrors `src/`.
- `skill-used` evidence is a reported skill call, a completed read of the installed `SKILL.md` inside the workdir, or a successful shell command whose output carries that file's opening text. On Grok it is a completed native `read_file` of `.grok/skills/<skill>/SKILL.md`.
- Scratch workdirs live in the system temp dir, outside the root, so the agent cannot read the skill's source, its evals, or the repo's agent guidance.
- `pack.fixedExtension` is `false`: the package is `type: module`, and the default `.mjs` output would move the `bin` target.
- `dist/` is generated and untracked. The Vite+ graph runs `pack` before both test lanes, so the symlinked-`bin` test has a file to run, and `prepublishOnly` forces the full graph.
- `test/fixtures/` is lint input, and one tree is deliberately broken. Vitest, Oxlint, and Oxfmt all skip it; formatting it would change what lint is asserted to reject.
- Tags `v0.1.0`–`v0.1.3` are the legacy `github:uinaf/skillcheck#<tag>` install path. Consumers still pin them and semantic-release continues from `v0.1.3`, so they stay where they are.
- npm Trusted Publishing binds this package to the path `.github/workflows/release.yml` and the `release` environment name. Renaming either breaks publishing.

## Commands

```sh
pnpm install --frozen-lockfile   # Node from .node-version, pnpm from packageManager
pnpm run verify                  # cached Vite+ graph
pnpm run verify:full             # uncached; what CI and publishing run
```

While iterating: `pnpm exec vp check` (format, lint, types; `--fix` applies autofixes), `pnpm exec vp test run`, `pnpm exec vp pack`. The pre-commit hook runs `vp check --fix` on staged files.

`run`, `sweep`, and `summarize` need model auth. Operators run them by hand; they are outside `verify` and CI.

## Pipelines

`.github/workflows/verify.yml` is the one gate, run on pull requests and called by `.github/workflows/release.yml` on every push to `main`, which then publishes to npm. Its last step is the push-time scan. `[skip ci]` on `verify` skips the release too, so the version writeback commit does not release again. Release runs queue (`queue: max`) so every pushed range is scanned; the `verify-` concurrency prefix keeps the called run out of the caller's `main-` group.

`pnpm-workspace.yaml` denies the browser, ONNX, and image build scripts promptfoo pulls in; scenarios grade text with a remote judge.

`test/consumer.test.ts` packs the tarball, installs it without scripts or eval peers, and runs `skillcheck lint` from `node_modules/.bin`.

Credentials: [docs/releasing.md](docs/releasing.md).

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
