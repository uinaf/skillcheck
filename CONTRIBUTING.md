# Contributing

## Setup

Node (see `.node-version`) with Corepack enabled:

```sh
pnpm install --frozen-lockfile
```

The `prepare` script runs `vp config --no-agent` during that install, so the
commit hook is wired with no second setup step.

## Validation

```sh
pnpm run verify
# force every lane:
pnpm run verify:full
```

The repository-owned Vite+ graph caches format, lint, pack, source tests, and
the consumer contract independently. The order matters: `dist/` is generated,
and the consumer test installs the packed tarball without scripts or eval peers
before running its CLI. CI and publishing force the same graph without cache.

Narrower loops while iterating:

```sh
pnpm exec vp check --fix
pnpm exec vp test run
pnpm exec vp test watch
```

`run`, `sweep`, and `summarize` need model auth and are not part of the gate.
See [usage](docs/usage.md) for how that auth is resolved.

## Branches and pull requests

Conventional Commits; the subject line is what picks the next version. `feat`
is a minor, `fix` is a patch, a `!` or `BREAKING CHANGE:` footer is a major.

Fill in the pull request template. `Verification` should carry the commands you
actually ran and their result, not an intention.

## Releasing

See [Releasing](docs/releasing.md). Publishing happens from `main` through the
`release` environment; there is no manual publish in the normal path.
