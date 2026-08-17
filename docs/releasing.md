# releasing

## pipeline

a push to `main` runs one workflow, `.github/workflows/release.yml`:

```text
verify ──┐
         ├──> release   npm publish, OIDC + uinaf-releaser  (release environment)
secrets ─┘
```

`verify` and `secrets` are the shared gate, called from `verify.yml` and
`secrets.yml`, so one definition serves pull requests, the merge queue, and this
push. keep it that way — a second copy of the gate on a push-to-`main` workflow
races this one over the same commit.

the file name `release.yml` is load-bearing. see below.

## npm

`@uinaf/skillcheck` publishes from `.github/workflows/release.yml` via npm
Trusted Publishing (OIDC) and the `uinaf-releaser` GitHub App. there is no npm
token in this repository, in its environments, or in the organization.

required on the `release` GitHub Environment:

| name                            | kind   | purpose                                     |
| ------------------------------- | ------ | ------------------------------------------- |
| `UINAF_RELEASE_APP_CLIENT_ID`   | var    | GitHub App client id for the releaser bot   |
| `UINAF_RELEASE_APP_PRIVATE_KEY` | secret | GitHub App private key for the releaser bot |

the trusted publisher on npmjs.com is registered by **file path**, so
`.github/workflows/release.yml` cannot be renamed or moved without editing that
registration first. a rename fails the publish with an identity mismatch, and
nothing earlier in the run reports it. the `release` environment name is bound
the same way.

deleting the `release` environment deletes both rows above with it, and there is
no repo-level fallback: `create-github-app-token` then runs with empty inputs
and the job fails at that step. the private key cannot be read back from
GitHub — recreating it means generating a new one in the App settings.

## version history

semantic-release owns the version and the tag. `tagFormat` is `v${version}` and
history continues from `v0.1.3`; `v0.1.0`–`v0.1.3` are the legacy git-install
tags and are never deleted or moved.

during preparation, `@semantic-release/npm` stages the released `package.json`
version and `@jno21/semantic-release-github-commit` commits it to `main` through
GitHub's API as the authenticated App. GitHub signs that commit, and the release
tag points to it. the `[skip ci]` marker on that commit is what stops a release
from releasing itself.

check what the next version would be without publishing anything:

```sh
pnpm dlx semantic-release --dry-run --no-ci
```

## the artifact

`dist/` is generated and untracked. `prepublishOnly` runs `pnpm run verify`,
which builds it, so the tarball is always packed from a tree that just passed
the gate. `files` is `dist`, `docs`, `README.md`, `LICENSE`.

manual publish is emergency recovery only:

```sh
pnpm run verify
npm publish --access public
```

## the old install path

before `@uinaf/skillcheck` existed, consumers installed
`github:uinaf/skillcheck#v0.1.3`. those tags still resolve and still carry a
committed `dist/`, so anything pinned to them keeps working untouched. new
consumers use npm.
