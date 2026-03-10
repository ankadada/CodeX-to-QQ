#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "service:restart:systemd is only supported on Linux."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found."
  exit 1
fi

UNIT_NAME="codex-cli-qq.service"
UNIT_PATH="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${UNIT_NAME}"

if [[ ! -f "${UNIT_PATH}" ]]; then
  echo "systemd unit not found: ${UNIT_PATH}"
  echo "Run npm run install:systemd first."
  exit 1
fi

systemctl --user daemon-reload
systemctl --user restart "${UNIT_NAME}"

echo "restarted: ${UNIT_NAME}"
