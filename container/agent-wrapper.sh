#!/bin/sh
# Installed in place of each agent binary. skillcheck runs as root and reads the
# root under test from /srv, which only root can enter; the agent drops to the
# unprivileged agent user and reaches only the run directories handed to it.
# If the drop fails, the agent fails instead of running as root.
case "$HOME" in /root | "") HOME=/home/agent ;; esac
exec setpriv --reuid=agent --regid=agent --init-groups -- env HOME="$HOME" "$0.real" "$@"
