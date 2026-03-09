#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "service:status:launchd is only supported on macOS."
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.atou.codex-cli-qq"
SERVICE_REF="gui/$(id -u)/${LABEL}"
LOG_DIR="${PROJECT_ROOT}/logs"

echo "=== launchctl ==="
launchctl print "${SERVICE_REF}" 2>/dev/null | sed -n '1,80p' || echo "service not loaded"
echo
echo "=== stdout (tail 40) ==="
tail -n 40 "${LOG_DIR}/codex-cli-qq.log" 2>/dev/null || true
echo
echo "=== stderr (tail 40) ==="
tail -n 40 "${LOG_DIR}/codex-cli-qq.err.log" 2>/dev/null || true
