# Isolated eval runner. The agent sees this image, the mounted root, and the
# Codex config mounted at $CODEX_HOME/config.toml; nothing from the operator's
# machine (installed skills, plugins, global guidance, home files) exists here.
# Usage: docs/usage.md#isolated-runs.
FROM node:24.21.0-bookworm-slim

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

RUN useradd --create-home --uid 1001 eval
USER eval
ENV HOME=/home/eval CODEX_HOME=/home/eval/.codex SKILLCHECK_ISOLATED=1
# The mounted root belongs to the host user; git must still read its tree sha.
RUN mkdir -p "$CODEX_HOME" && git config --global --add safe.directory '*'

WORKDIR /work
ENTRYPOINT ["skillcheck"]
