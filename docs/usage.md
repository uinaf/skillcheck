# Usage

Every subcommand resolves one root, `--root <dir>` or the current directory.
`lint` also takes the root as a positional.

## Lint

```sh
skillcheck lint            # lints the current repo
skillcheck lint ../other   # lints another root
```

Checks each `<root>/skills/<skill>/`:

- Frontmatter opens with `---` on line 1 and closes
- Keys are `name`, `description`, `disable-model-invocation` and nothing else,
  each at most once
- `name` equals the directory name; `description` is non-empty
- `disable-model-invocation`, when present, is the bare YAML boolean `true`
- Relative links in the body resolve on disk; links in code spans and fenced
  blocks are skipped
- No eval `task.md` names a skill from the root outside its inline input files
- Every eval `criteria.json` meets the
  [criteria contract](scenarios.md#criteriajson)

Dot-directories under `skills/` (`.claude-plugin`) are skipped. Findings print
one per line, relative to the root, then a count. Exit 0 clean, 1 with
findings.

## Run

```sh
skillcheck run skills/<skill>/evals/<scenario>
skillcheck run <scenario-dir> --agent MODEL --judge MODEL --harness codex
skillcheck run <scenario-dir> --harness claude --max-turns 80
skillcheck run <scenario-dir> --harness grok
skillcheck run <scenario-dir> --trials 3 --agent-effort medium
```

Materializes the scenario into a temp workdir per trial
([workdir](scenarios.md#the-workdir)), installs the skill, drives the agent,
and grades the files it wrote. Exit 0 means pass, 1 graded fail, 2 error. A
missing eval peer exits 2 with the exact `pnpm add` command. An errored test
was never graded: it exits 2, prints the provider's message, and is never
reported as a failing score.

- `--harness` defaults to `claude`. On `codex` and `grok`, omitting `--agent`
  uses that CLI's default model.
- `--max-turns` and `--agent-effort low|medium|high|xhigh|max` work only with
  `--harness claude`; other harnesses fail before the eval starts.
- `--harness grok` runs the locally installed, logged-in Grok Build CLI.

### Isolated runs

Run evals inside the image in [container/](../container/Dockerfile). On the
host the agent can read the operator's installed skills, plugins, global
guidance, and any file by absolute path, so `run` and `sweep` warn.

```sh
docker build -t skillcheck:<version> --build-arg SKILLCHECK_VERSION=<version> container
docker run --rm --env-file <owner-only env file> \
  -v "$PWD:/srv/work:ro" -v "$PWD/.skillcheck:/srv/work/.skillcheck" \
  -v <codex config.toml>:/etc/skillcheck/codex/config.toml:ro \
  skillcheck:<version> run --root /srv/work skills/<skill>/evals/<scenario> --trials 3
```

- Start one container per `run` or `sweep`. Agents in one container share a
  user, so a control must never share a container with a skill run.
- Pass Claude gateway auth through the env file ([auth](#auth)).
- Mount a Codex `config.toml` written for the run that names only the model
  provider and its auth, never the operator's own. The `agent` user must be
  able to read any token its auth command reads.
- Results record `isolated`. `summarize` refuses to mix isolated and host
  rows, and `sweep` reruns host results.

### Trials

`--trials <k>` (default 1) runs the agent k times, each in its own workdir, all
graded in one promptfoo eval. Use 3 or more before calling a skill change
better or worse. A scenario's result aggregates its trials:

| Field                           | Meaning                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pass`                          | pass^k: every trial passed. Exit 0 needs this                                                     |
| `passes`, `pass_rate`           | Trials that passed, as a count and a fraction                                                     |
| `score`                         | Mean weighted checklist score (the assert-set, without skill-used)                                |
| `score_min`                     | Lowest trial score                                                                                |
| `score_spread`                  | Highest minus lowest trial score                                                                  |
| `skill_used`, `skill_used_rate` | Trials that loaded the skill, as a count and fraction; on a near-miss scenario these are misfires |
| `noisy`                         | Trials both passed and failed, or `score_spread` is at least 0.2                                  |

One errored trial, a result with fewer rows than trials, or a row without its
checklist and `skill-used` components makes the whole scenario an ERROR.

### Control

`--control` runs a scenario without the skill: nothing is installed, a hidden
skill's explicit invocation is dropped from the task, and `skill-used` never
fails. The result is `<name>--control.json` with `variant: "control"` in the
sidecar; `sweep --control` covers every scenario. `summarize` adds the mean
control score and the lift (skill score minus control score) per skill. A
scenario whose control passes every trial prints `NO LIFT`: it does not test
the skill.

### Judges

`--judge` takes a bare Claude model, graded through the Anthropic selection in
[auth](#auth), or a provider-qualified promptfoo id, passed through verbatim
and recorded in the scorecard's `judge_model`:

```sh
skillcheck run <scenario-dir> --judge openai:chat:gpt-5.6-sol --judge-effort high
skillcheck run <scenario-dir> --judge claude-opus-5-5 --judge-effort high --trials 3
```

`--judge-effort` takes `minimal|low|medium|high` for a provider-qualified
judge (`reasoning_effort`) and `low|medium|high|xhigh|max` for a Claude judge
(`effort`).

## Sweep

```sh
skillcheck sweep           # scenarios without completed results
skillcheck sweep --all     # rerun everything
```

Runs every scenario under `<root>/skills/*/evals/*` and
`<root>/cli/*/skills/*/evals/*` sequentially. Exit 2 if anything errored, 1 if
anything failed, else 0.

- A scenario is skipped only when its completed result used the same agent
  model and effort, judge model and effort, and trial count. Others rerun as
  `RERUN`.
- `EVALS_CONCURRENCY` (default 4) parallelizes the trials of one scenario. To
  spread scenarios, start several `skillcheck run` processes.
- A gateway transport drop surfaces as an ERROR, not a graded FAIL. Rerun
  `sweep`; it picks up missing and ungraded results.

## Summarize

```sh
skillcheck summarize [--allow-mixed]
```

Reduces `<root>/.skillcheck/results/*.json` into
`<root>/.skillcheck/scorecards/<UTC-date>.json`, one entry per scenario with
the [trial aggregate](#trials), run configuration, mean latency, and summed
tokens. It prints one row per skill and harness, then each noisy scenario.

- An existing scorecard for today merges on `(skill, scenario, harness)`; this
  run's entries win. A same-date file that cannot be parsed stops the write.
- Rows for scenarios no longer in the tree are dropped, unless the root has no
  skills tree.
- Non-result files and ungraded transport errors are skipped with a warning. A
  rubric item whose judge call failed errors the trial. If a skipped file
  matches an existing scorecard row, `summarize` fails and leaves the scorecard
  unchanged, so an errored rerun cannot carry forward its old score.

## Provenance

Each successful run writes a `<name>.meta.json` sidecar next to its result:

```json
{
  "skills_tree_sha": "<root repo HEAD at run time>",
  "skill": "<skill directory name>",
  "scenario": "<scenario directory name>",
  "harness": "claude",
  "agent_model": "claude-opus-5",
  "agent_effort": "medium",
  "judge_model": "claude-opus-5",
  "judge_effort": null,
  "trials": 3,
  "agent_access": "online",
  "isolated": true,
  "aggregate": { "pass": false, "pass_rate": 0.6667, "score": 0.81, "...": "..." },
  "ran_at": "<ISO timestamp>",
  "tool_version": "<skillcheck version>"
}
```

`summarize` refuses to mix skills-tree revisions or run configurations within
a harness, retained rows included, and leaves the scorecard unchanged.
`--allow-mixed` overrides it: the top-level `skills_tree_sha` becomes `mixed`.
A result with no sidecar reduces as `unattested`.

## State

`<root>/.skillcheck/results/` is disposable; gitignore it.
`<root>/.skillcheck/scorecards/` is the history to keep. In the isolated image
`.skillcheck/` is a separate writable mount, so a separate evals repository can
pin the skill repository to a commit and keep the scorecards.

## Auth

| Variable                                      | Effect                                                            |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | The claude agent and judge go through a gateway                   |
| None of the above                             | Falls back to the local Claude Code session                       |
| `ANTHROPIC_API_KEY`                           | Judge grades over `anthropic:messages:<model>` instead of the SDK |
| `CODEX_HOME` (default `~/.codex`)             | Where the codex harness finds the local `codex` CLI login         |
| `OPENAI_API_KEY`                              | Agent auth for codex when there is no local login                 |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL`          | A provider-qualified `--judge openai:…`, optionally via a gateway |

- A bare `--judge` model uses the Anthropic selection whatever the harness.
- The Claude agent loads project settings only, so an `apiKeyHelper` or `env`
  block in `~/.claude/settings.json` never reaches it and the run fails with
  `Not logged in`. Export `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`
  instead.
- Run from a plain shell. Inside a Claude Code session, its `CLAUDECODE` and
  `CLAUDE_CODE_*` variables leak into the agent.
