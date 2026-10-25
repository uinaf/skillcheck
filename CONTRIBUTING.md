# Contributing

## Setup

Node (see `.node-version`) and [pnpm](https://pnpm.io/installation):

```sh
pnpm install --frozen-lockfile
```

The install also wires the commit hook.

## Validation

```sh
pnpm run verify        # cached
pnpm run verify:full   # uncached; what CI and publishing run
```

While iterating:

```sh
pnpm exec vp check --fix
pnpm exec vp test run
pnpm exec vp test watch
```

`run`, `sweep`, and `summarize` need model auth ([usage](docs/usage.md#auth))
and are not part of the gate.

## Pull requests

Use Conventional Commits; the subject picks the next version. `feat` is a
minor, `fix` a patch, and `!` or a `BREAKING CHANGE:` footer a major. `docs:`
and `chore:` do not release. Fill in the pull request template.

## Releasing

Every push to `main` publishes to npm through `.github/workflows/release.yml`
and the `release` environment.

- Keep the `release.yml` path and the `release` environment name: npm Trusted
  Publishing is bound to both. The environment holds `UINAF_CI_APP_CLIENT_ID`
  and `UINAF_CI_APP_PRIVATE_KEY`; deleting it deletes them.
- Never move or delete a tag. Consumers still pin the legacy `v0.1.0`–`v0.1.3`
  git tags, and semantic-release continues from them.
- If a release fails after GitHub accepts its version commit, finish only the
  missing publication steps from that commit; never cut another version.

Check the next version without publishing:

```sh
pnpm dlx semantic-release --dry-run --no-ci
```
