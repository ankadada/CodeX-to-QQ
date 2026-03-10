#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "uninstall:systemd is only supported on Linux."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found."
  exit 1
fi

UNIT_NAME="codex-cli-qq.service"
UNIT_PATH="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${UNIT_NAME}"

systemctl --user disable --now "${UNIT_NAME}" >/dev/null 2>&1 || true
rm -f "${UNIT_PATH}"
systemctl --user daemon-reload
systemctl --user reset-failed "${UNIT_NAME}" >/dev/null 2>&1 || true

echo "uninstalled: ${UNIT_NAME}"
echo "removed:     ${UNIT_PATH}"
echo "note: logs/data/workspaces were left untouched."
