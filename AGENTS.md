# AGENTS.md

`@uinaf/skillcheck`: a lint and eval harness for agent skills, published to npm
and used by uinaf skill repos. The [README](README.md) has the layout contract
and the docs map.

## Invariants

- The layout under a root is a fixed contract with no config file. Every
  subcommand resolves one root: `--root`, else the cwd.
- `lint` has no dependencies, no network, and no model auth. Consumer CI runs
  it, including installs with `--ignore-scripts`.
- The package has zero regular `dependencies`. promptfoo and the provider SDKs
  are optional `peerDependencies`, so a lint-only consumer stays small. `run`
  and `sweep` preflight the peers they need and exit 2 with the install
  command. promptfoo runs from its resolved install path; `npx` would fetch an
  unpinned copy.
- `dist/transform.js`, `dist/grok-provider.js`, and `dist/skill-evidence.js`
  load by `file://` URL from beside `dist/cli.js` (`selfExt` in `src/cli.ts`).
  Each needs its own `pack.entry` in `vite.config.ts`, with `unbundle` on.
- `pack.fixedExtension` stays `false`: the default `.mjs` output would move the
  `bin` target.
- Scratch workdirs stay in the system temp dir, outside the root, so the agent
  cannot read the skill's source, its evals, or the repo's agent guidance.
- `test/fixtures/` is lint input, and one tree is deliberately broken. Keep
  Vitest, Oxlint, and Oxfmt off it; formatting it would change what lint is
  asserted to reject.
- `src/cli.ts` prints `docs/usage.md#isolated-runs`; keep that anchor.
- Every push to `main` publishes to npm. Read
  [Releasing](CONTRIBUTING.md#releasing) before touching `release.yml`, the
  `release` environment, tags, or a failed release.

## Commands

```sh
pnpm install --frozen-lockfile   # Node from .node-version, pnpm from packageManager
pnpm run verify                  # cached Vite+ graph
pnpm run verify:full             # uncached; what CI and publishing run
```

While iterating: `pnpm exec vp check --fix`, `pnpm exec vp test run`,
`pnpm exec vp pack`.

`run`, `sweep`, and `summarize` need model auth. Operators run them by hand;
they are outside `verify` and CI.
