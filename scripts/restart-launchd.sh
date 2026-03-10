#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "service:restart:launchd is only supported on macOS."
  exit 1
fi

AGENTS_DIR="${HOME}/Library/LaunchAgents"
LABEL="com.atou.codex-cli-qq"
PLIST_PATH="${AGENTS_DIR}/${LABEL}.plist"
SERVICE_REF="gui/$(id -u)/${LABEL}"

if [[ ! -f "${PLIST_PATH}" ]]; then
  echo "launchd plist not found: ${PLIST_PATH}"
  echo "Run npm run install:launchd first."
  exit 1
fi

if launchctl print "${SERVICE_REF}" >/dev/null 2>&1; then
  launchctl enable "${SERVICE_REF}" >/dev/null 2>&1 || true
  launchctl kickstart -k "${SERVICE_REF}"
else
  launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
  launchctl enable "${SERVICE_REF}" >/dev/null 2>&1 || true
  launchctl kickstart -k "${SERVICE_REF}"
fi

echo "restarted: ${SERVICE_REF}"
