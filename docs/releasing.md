# Releasing

## Pipeline

A push to `main` runs one workflow, `.github/workflows/release.yml`:

```text
verify ──> release   npm publish, OIDC + uinaf-ci  (release environment)
```

`verify` is the one gate, called from `verify.yml`; its last step runs the
shared push-time scan from `uinaf/.github` over the pushed range. A second copy
of the gate on another push-to-`main` workflow would race this one over the same
commit.

The file name `release.yml` is load-bearing. See below.

## npm

`@uinaf/skillcheck` publishes from `.github/workflows/release.yml`, which
calls the shared `release-npm` workflow in `uinaf/.github`, via npm Trusted
Publishing (OIDC) and the `uinaf-ci` GitHub App. No npm token exists in this
repository, its environments, or the organization.

Required on the `release` GitHub Environment, which the shared job binds, so
GitHub substitutes these values for the names in `release.yml`:

| Name                       | Kind   | Purpose                                     |
| -------------------------- | ------ | ------------------------------------------- |
| `UINAF_CI_APP_CLIENT_ID`   | var    | GitHub App client id for the releaser bot   |
| `UINAF_CI_APP_PRIVATE_KEY` | secret | GitHub App private key for the releaser bot |

The trusted publisher on npmjs.com is registered by **file path**, so
`.github/workflows/release.yml` cannot be renamed or moved without editing that
registration first. A rename fails the publish with an identity mismatch, and
nothing earlier in the run reports it. The `release` environment name is bound
the same way.

Deleting the `release` environment deletes both rows above with it, and there is
no repo-level fallback: `create-github-app-token` then runs with empty inputs
and the job fails at that step. The private key cannot be read back from
GitHub; recreating it means generating a new one in the App settings.

## Version history

The version and the tag are owned by semantic-release. `tagFormat` is `v${version}` and
history continues from `v0.1.3`; `v0.1.0`–`v0.1.3` are the legacy git-install
tags and are never deleted or moved.

During preparation, `@semantic-release/npm` stages the released `package.json`
version and `scripts/release-commit.ts` commits it through GitHub's signed
`createCommitOnBranch` API as the authenticated App. The checkout and expected
branch head are the verified workflow event SHA. GitHub atomically rejects the
write if `main` has advanced; a successful response is fetched by its immutable
commit SHA. The plugin checks its parent, unchanged source, and exact prepared
manifest before semantic-release tags it. Only the package version may
change. The `[skip ci]` marker on that commit stops a release from releasing
itself.

If GitHub accepts the commit but fetching or validating it fails, preparation
stops before tagging or publishing. Inspect that commit's parent, tree, version
and verified signature, plus existing tags, npm versions and GitHub Releases,
before recovery. Reconcile only missing publication steps from the validated
commit; do not create another version or move an existing tag to hide failure.

Check what the next version would be without publishing anything:

```sh
pnpm dlx semantic-release --dry-run --no-ci
```

## The artifact

`dist/` is generated and untracked. `prepublishOnly` runs `pnpm run verify:full`,
which builds it, so the tarball is always packed from a tree that just passed
the gate. `files` is `dist`, `docs`, `README.md`, `LICENSE`.

Manual publish is emergency recovery only: `npm publish --access public`, which
runs the full gate through `prepublishOnly`.

Consumers pinned to the legacy git tags are covered in
[adoption](adoption.md#the-older-install-path).
