# Adopting it in a repo

Run the lint in the consumer repo's CI. Run evals only on a machine with model
auth.

## Lint in CI

```sh
pnpm add -D @uinaf/skillcheck
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
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "24"
      - run: pnpm install --frozen-lockfile
      - run: pnpm run skills:lint
```

The job needs no secrets, and `--ignore-scripts` installs work. Run it through
the script: a bare `npx skillcheck` resolves the latest registry version, not
the pinned one.

## Evals

Keep sweeps off consumer CI. For pnpm 12, add this override to the operator
project's `pnpm-workspace.yaml` before installing; it drops promptfoo's unused
local-inference path and its unpatched `sprintf-js`
([GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)):

```yaml
overrides:
  "promptfoo>@huggingface/transformers": "-"
```

Install the peers next to skillcheck, then sweep and summarize:

```sh
pnpm add -D promptfoo @anthropic-ai/claude-agent-sdk @openai/codex-sdk
skillcheck sweep            # resumes: only scenarios without results
skillcheck summarize        # writes .skillcheck/scorecards/<UTC-date>.json
```

Keep `.skillcheck/scorecards/`, committed here or in a separate evals
repository ([isolated runs](usage.md#isolated-runs)), and gitignore the
results:

```gitignore
.skillcheck/results/
```

## Legacy git tags

Tags `v0.1.0`–`v0.1.3` (`npm i -D github:uinaf/skillcheck#v0.1.3`) carry a
committed `dist/` and still work. Tags from `v0.1.4` on carry no `dist/`, so a
git spec pointing at one will not run. Move to the registry install.
