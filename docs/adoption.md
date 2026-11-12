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

Add a CI job that checks out, sets up pnpm and the
[supported Node](../README.md#install), installs with `--frozen-lockfile`, and
runs `pnpm run skills:lint`. The job needs no secrets, and `--ignore-scripts` installs work. Run it through
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
