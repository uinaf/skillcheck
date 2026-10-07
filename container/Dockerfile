# Isolated eval runner, following promptfoo's guidance for coding agents: an
# ephemeral container, a read-only mount of the root under test with results on
# a separate writable mount, a project-local Codex home, and only the
# credentials a run needs. Nothing from the operator's machine (installed
# skills, plugins, global guidance, home files) exists here. skillcheck runs as
# root; every agent runs as the unprivileged agent user (agent-wrapper.sh),
# which cannot enter /srv or read a run's config, manifests, or promptfoo state.
# Build with this directory as context; usage: docs/usage.md#isolated-runs.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ARG SKILLCHECK_VERSION

# Tools agents reach for in a normal shell session.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global \
    "@uinaf/skillcheck@${SKILLCHECK_VERSION}" \
    "promptfoo@^0.123.1" \
    "@anthropic-ai/claude-agent-sdk@^0.3.281" \
    "@openai/codex-sdk@^0.156.1" \
  && npm cache clean --force

# npm sometimes skips an SDK's optional platform package. promptfoo's nested
# copies would still satisfy a looser check, so a build missing the binary the
# top-level SDKs resolve fails here instead of yielding a judge that errors on
# every call.
RUN root="$(npm root --global)" arch="$(node -p process.arch)" \
  && for pkg in "@anthropic-ai/claude-agent-sdk @anthropic-ai/claude-agent-sdk-linux-$arch" \
    "@openai/codex-sdk @openai/codex-linux-$arch"; do \
    set -- $pkg; \
    test -d "$root/$1/node_modules/$2" || test -d "$root/$2" \
      || { echo "missing $2 for $1; rebuild with --no-cache" >&2; exit 1; }; \
  done

# Every agent binary the SDKs can spawn starts through the wrapper.
COPY agent-wrapper.sh /usr/local/libexec/skillcheck/agent-wrapper.sh
RUN find "$(npm root --global)" -type f \( -path "*/codex-linux-*/bin/codex" -o -path "*/claude-agent-sdk-linux-*/claude" \) \
    -exec sh -c 'mv "$1" "$1.real" && cp /usr/local/libexec/skillcheck/agent-wrapper.sh "$1" && chmod 755 "$1"' _ {} \; \
  && test "$(find "$(npm root --global)" -name "*.real" | wc -l)" -gt 0

RUN useradd --create-home --uid 1002 agent \
  && install -d -m 700 /srv /var/lib/skillcheck/promptfoo \
  && install -d -m 755 /etc/skillcheck/codex \
  && git config --system --add safe.directory '*'

# Mount the Codex config at /etc/skillcheck/codex/config.toml (read-only, no
# secrets); its auth command may read a token file mounted for the agent.
ENV SKILLCHECK_ISOLATED=1 \
  SKILLCHECK_AGENT_UID=1002 \
  SKILLCHECK_AGENT_GID=1002 \
  CODEX_HOME=/etc/skillcheck/codex \
  PROMPTFOO_CONFIG_DIR=/var/lib/skillcheck/promptfoo

WORKDIR /srv/work
ENTRYPOINT ["skillcheck"]
