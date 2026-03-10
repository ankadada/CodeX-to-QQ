#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "uninstall:launchd is only supported on macOS."
  exit 1
fi

AGENTS_DIR="${HOME}/Library/LaunchAgents"
LABEL="com.atou.codex-cli-qq"
PLIST_PATH="${AGENTS_DIR}/${LABEL}.plist"
SERVICE_REF="gui/$(id -u)/${LABEL}"

launchctl bootout "${SERVICE_REF}" >/dev/null 2>&1 || true
if [[ -f "${PLIST_PATH}" ]]; then
  launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" >/dev/null 2>&1 || true
  rm -f "${PLIST_PATH}"
fi

echo "uninstalled: ${SERVICE_REF}"
echo "removed:     ${PLIST_PATH}"
echo "note: logs/data/workspaces were left untouched."
