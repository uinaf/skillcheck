# Usage

Every subcommand resolves one root, `--root <dir>` or the current directory.
`lint` also takes the root as a positional, because that is the shape CI reaches
for first.

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
- `disable-model-invocation`, when present, is the bare YAML boolean `true`.
  A quoted `"true"` is an error
- Relative links in the body resolve on disk
- No eval `task.md` names a skill from the root, outside its inline input
  files. A named skill gives routing away, and a no-skill control can read
  the operator's installed copy
- Every eval `criteria.json` is valid JSON and meets the
  [criteria contract](scenarios.md#criteriajson) `run` enforces before it
  starts, so a broken file fails CI instead of stopping a sweep midway

Code spans and fenced blocks are stripped before links are checked, so example
links never fail. External schemes and `#anchors` pass. Dot-directories under
`skills/` (`.claude-plugin`) are plugin metadata, not packages, and are skipped.

Findings print one per line, relative to the linted root, then a count. Exit 0
clean, 1 with findings.

## Run

```sh
skillcheck run skills/<skill>/evals/<scenario>
skillcheck run <scenario-dir> --agent MODEL --judge MODEL --harness codex
skillcheck run <scenario-dir> --harness claude --max-turns 80
skillcheck run <scenario-dir> --harness grok
skillcheck run <scenario-dir> --trials 3 --agent-effort medium
```

Materializes the scenario into a temp-dir workdir per trial ([workdir](scenarios.md#the-workdir)),
installs the skill under test into that workdir, drives the agent, and grades
the files it wrote. Exit 0 means pass, 1 means graded fail, and 2 means error.
Exit 2 covers missing usable promptfoo output or optional eval peers. The
message carries the exact `pnpm add` command; see
[adoption](adoption.md#evals).

A test that errored was never graded, so it exits 2, prints the provider's
message, and writes no provenance sidecar. It is never reported as
`FAIL score=0.0000`; only a real judged verdict can fail a run.

Defaults: `--harness claude`, agent `claude-opus-5`, judge `claude-opus-5`,
and a Claude agent limit of 50 turns. `--max-turns` changes that limit only for
Claude; passing it with `codex` or `grok` fails before the eval starts. On
those harnesses, omitting `--agent` leaves the model to that CLI's own default.

### Isolated runs

Run evals inside the image in [container/](../container/Dockerfile), which
follows promptfoo's guidance for
[coding agents](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/):
a workspace is not a sandbox, so agents run in an ephemeral container with a
read-only mount of the repository, writes on a separate volume, a
project-local Codex home, and only the credentials they need. On the host the
agent shares the operator's machine: it can read installed skills, enabled
plugins, global guidance, and any file by absolute path. `run` and `sweep` warn
when they are not isolated.

```sh
docker build -t skillcheck:<version> --build-arg SKILLCHECK_VERSION=<version> container
docker run --rm --env-file <owner-only env file> \
  -v "$PWD:/srv/work:ro" -v "$PWD/.skillcheck:/srv/work/.skillcheck" \
  -v <codex config.toml>:/etc/skillcheck/codex/config.toml:ro \
  skillcheck:<version> run --root /srv/work skills/<skill>/evals/<scenario> --trials 3
```

skillcheck runs as root and reads the repository from `/srv`, which only root
can enter. Each agent binary starts through a wrapper that drops to the
unprivileged `agent` user, which owns only its workdir and the run's homes; the
run's promptfoo config and manifests, which carry the criteria, and promptfoo's
own state stay root-only. Start one container per `run` or `sweep`
invocation, as above: agents in one container share the agent user, so a
control must never share a container with a skill run. The image's home is
empty. Pass Claude gateway auth
through the env file ([auth](#auth)) and mount a Codex `config.toml` written for
the run that names only the model provider and its auth, never the operator's
own; a token its auth command reads must be readable by the agent user. Codex's
namespace sandbox cannot start inside a container, so skillcheck runs it with
full access there; the container and the user drop are the boundary. A run
counts as isolated only inside a container, with the image's marker variable,
skillcheck running as root, an agent user configured, and the wrapper
installed; results record `isolated` in their run
configuration, so `summarize` refuses to mix isolated and host rows and `sweep`
reruns host results.

### Trials

One trial is one sample of a noisy process: the same scenario and skill can
score 0.49 and then 0.99. `--trials <k>` (default 1) runs the agent k times,
each in its own workdir with its own manifest, all graded in one promptfoo eval.
promptfoo's `--repeat` is not used because it reuses one set of vars and one
`working_dir`, so concurrent trials would write into the same tree and each
would be graded on all of their deliverables.

A scenario's result aggregates its trials:

| Field                           | Meaning                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pass`                          | pass^k: every trial passed. Exit 0 needs this                                                     |
| `passes`, `pass_rate`           | Trials that passed, as a count and a fraction                                                     |
| `score`                         | Mean weighted checklist score (the assert-set, without skill-used)                                |
| `score_min`                     | Lowest trial score                                                                                |
| `score_spread`                  | Highest minus lowest trial score                                                                  |
| `skill_used`, `skill_used_rate` | Trials that loaded the skill, as a count and fraction; on a near-miss scenario these are misfires |
| `noisy`                         | Trials both passed and failed, or `score_spread` is at least 0.2                                  |

A trial that errored was never graded, so one errored trial makes the whole
scenario an ERROR: pass^k over fewer than k trials is not the requested number.
So is a result with fewer rows than trials, or a row without its checklist and
`skill-used` components.
With `--trials` above 1, `run` and `sweep` print min, spread, pass count,
skill-used count, and `NOISY`.

### Control

`--control` runs a scenario without the skill: nothing is installed in the
workdir, a hidden skill's explicit invocation is dropped from the task, and the
`skill-used` assertion never fails. Its result sits beside the skill run
(`<name>--control.json`) with `variant: "control"` in the sidecar, and `sweep
--control` covers every scenario. `summarize` pairs each scenario with its
control and adds two columns per skill: the mean control score, and the lift
(skill score minus control score over the paired scenarios). A scenario whose
control passes every trial prints as `NO LIFT`: it passes without the skill, so
it does not test the skill.

### Agent effort

`--agent-effort low|medium|high|xhigh|max` sets the Claude agent's effort.
promptfoo passes it to the Agent SDK, which starts Claude Code with `--effort`.
Omitting it leaves Claude Code's default. Only `--harness claude` takes it;
`codex` and `grok` fail before the eval starts. It is separate from
`--judge-effort`.

### Harnesses and judges

`--harness grok` runs the locally installed Grok Build CLI in the disposable
workdir with the skill under `.grok/skills/`. It uses native streaming events
to count a completed read of that skill's `SKILL.md` as `skill-used` evidence.
Grok must be logged in locally or have its supported credentials configured.
The run disables subagents and grants edit permission in the workdir; web
search stays on. `--agent` selects a Grok model ID. Malformed fields consumed by
the provider are reported as run errors. Progress-only tool updates and pending read inputs are
ignored. Skill-read evidence requires a file path on the initial tool call
(`path` or `target_file`) and a completed update.

`--judge` takes either a bare Claude model (graded through the Anthropic
selection in [auth](#auth)) or a provider-qualified promptfoo id, passed
through verbatim:

```sh
skillcheck run <scenario-dir> --judge openai:chat:gpt-5.6-sol --judge-effort high
```

A provider-qualified judge authenticates through that provider's own env
(`OPENAI_API_KEY`, plus `OPENAI_BASE_URL` for a gateway) and is recorded
verbatim in the scorecard's `judge_model` column. For it, `--judge-effort`
(minimal|low|medium|high) sets `reasoning_effort`. For a bare Claude judge,
`--judge-effort` takes Claude's levels (low|medium|high|xhigh|max) and is passed
as `effort` on either Anthropic path; the SDK judge starts Claude Code with
`--effort`:

```sh
skillcheck run <scenario-dir> --agent claude-opus-5-5 --agent-effort medium \
  --judge claude-opus-5-5 --judge-effort high --trials 3
```

The SDK judge runs Claude Code with auto memory off and a fixed session title.
Each call gets a fresh temp working directory, and the memory section would
put that path into the system prompt; without it, every call sends the same
system prompt, which the prompt cache can share. A gateway that moves the
caller's system prompt behind the first user message prevents that sharing.
The fixed title saves the second request, on the judge model, that Claude Code
otherwise sends per call to name the session.

## Sweep

```sh
skillcheck sweep           # scenarios without completed results
skillcheck sweep --all     # rerun everything
```

Walks `<root>/skills/*/evals/*` and `<root>/cli/*/skills/*/evals/*`, in sorted
order, sequentially. A scenario needs both `task.md` and `criteria.json` to be
discovered. Exit 2 if anything errored, 1 if anything failed, else 0.

`EVALS_CONCURRENCY` is passed to promptfoo as `-j` (default 4). It parallelizes
the trials of one scenario, not separate scenarios. To spread scenarios, start
several `skillcheck run` processes; each scenario has its own result, attempt
marker, and scratch directory.

A scenario is skipped only when its completed result was graded with the same
run configuration: agent model, agent effort, judge model, judge effort, and
trial count. A result from another configuration is rerun and reported as
`RERUN`.

One known failure mode: judge calls through a gateway can drop at the transport
layer ([uinaf/zebroid-infra#44](https://github.com/uinaf/zebroid-infra/issues/44)).
That surfaces as an ERROR with no usable result, not as a graded FAIL, and the
mitigation is a rerun. `sweep` without `--all` resumes, so a rerun picks up
missing or ungraded results.

## Summarize

```sh
skillcheck summarize [--allow-mixed]
```

Reduces `<root>/.skillcheck/results/*.json` into
`<root>/.skillcheck/scorecards/<UTC-date>.json`: one entry per scenario with
skill, scenario, harness, tree sha, the trial aggregate from [trials](#trials),
the run configuration, mean latency per trial, and tokens summed over trials.
It then prints one row per skill and harness: scenarios, pass^k count, mean pass
rate, mean score, and noisy count. Each noisy scenario follows on its own line.

If a scorecard for today already exists, the two are merged on
`(skill, scenario, harness)`: entries from this run win, entries it did not
touch survive, and the merge is reported on stdout. Summarizing after rerunning
six of twenty-nine scenarios therefore leaves twenty-nine rows in the file, not
six. A same-date file that cannot be parsed stops the write instead of being
overwritten.

Rows for scenarios that no longer exist in the tree, whether carried from
today's scorecard or left in `results/`, are dropped and counted on stdout.
A root with no skills tree (`skills/` or `cli/*/skills/`) holds results only
and keeps every row.

Files that are not promptfoo results and ungraded transport errors are skipped
with a warning rather than failing the reduction. Graded assertion failures
remain scored results. A rubric item whose judge call failed (promptfoo tags it
`graderError`) errors the trial instead, since it judged nothing. If a skipped file matches an existing scorecard row,
summary generation fails and leaves the scorecard unchanged, so an errored rerun
cannot carry forward its old score. A graded result for the same identity
supersedes a skipped attempt only when the result file is newer. This also
applies with `--allow-mixed`.
Results from the retired Cursor harness are skipped with their original identity,
so they cannot become Claude scores or silently carry an old Cursor row.
Runs keep a `<name>.json.attempt` marker until a graded result and its provenance
are written. The marker records the original skill, scenario, and harness. An outstanding marker makes `summarize` skip that identity even
when the child produced no result file or left partial output. The marker does
not count as a result for the sweep's existence check, so no-output failures
remain eligible for retry.
Long escaped names use a short hashed filename; the original identity is kept
in the attempt marker and result sidecar. `sweep` retries existing results that
contain no grade, including results written by older versions without a marker.

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

`summarize` reads those sidecars and refuses to mix skills-tree revisions or
run configurations (agent model and effort, judge model and effort, trials,
agent access, and isolation) in
one scorecard, including retained rows from partial reruns, unless
`--allow-mixed`. Configurations are compared within a harness, since harnesses
differ by design. Sidecars written before run configurations were recorded fall
back to the promptfoo config stored in the result.
Rejection leaves the existing scorecard unchanged. With the override, the top-level `skills_tree_sha`
becomes `mixed` and per-entry shas remain. A result with no sidecar reduces as
`unattested`.

## State

`<root>/.skillcheck/` holds `results/`, disposable and safe to gitignore, and
`scorecards/`, the history to keep. In the isolated image it is a separate
writable mount, so it can live outside the repository under test: a separate
evals repository can pin the skill repository to a commit, keep its scorecards,
and leave the skill repository with only scenarios and `skillcheck lint`. Scratch workdirs live under the
system temp dir, outside the root. Nothing is ever written inside the installed
package.

## Auth

| Variable                                      | Effect                                                            |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | The claude agent and judge go through a gateway                   |
| None of the above                             | Falls back to the local Claude Code session                       |
| `ANTHROPIC_API_KEY`                           | Judge grades over `anthropic:messages:<model>` instead of the SDK |
| `CODEX_HOME` (default `~/.codex`)             | Where the codex harness finds the local `codex` CLI login         |
| `OPENAI_API_KEY`                              | Agent auth for codex when there is no local login                 |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL`          | A provider-qualified `--judge openai:…`, optionally via a gateway |

A bare `--judge` model stays on the Anthropic selection regardless of the
agent harness; a provider-qualified `--judge` uses that provider's env instead.

The Claude agent loads project settings only, so an `apiKeyHelper` or `env`
block in the operator's `~/.claude/settings.json` never reaches it; the run
fails with `Not logged in`. Export the gateway variables instead:
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` set to the helper's output.
Running from inside a Claude Code session also leaks that session's
`CLAUDECODE` and `CLAUDE_CODE_*` variables into the agent; run from a plain shell.
