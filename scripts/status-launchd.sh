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
BOOT_MARKER="=== CodeX-to-QQ boot ==="

tail_since_last_boot() {
  local file_path="$1"
  if [[ ! -f "${file_path}" ]]; then
    return 0
  fi
  awk -v marker="${BOOT_MARKER}" '
    { lines[NR] = $0 }
    index($0, marker) { start = NR }
    END {
      if (!NR) exit
      if (!start) start = NR - 39
      if (start < 1) start = 1
      for (i = start; i <= NR; i++) print lines[i]
    }
  ' "${file_path}" | tail -n 40
}

echo "=== launchctl ==="
launchctl print "${SERVICE_REF}" 2>/dev/null | sed -n '1,80p' || echo "service not loaded"
echo
echo "=== stdout (tail 40) ==="
tail_since_last_boot "${LOG_DIR}/codex-cli-qq.log" 2>/dev/null || true
echo
echo "=== stderr (tail 40) ==="
tail_since_last_boot "${LOG_DIR}/codex-cli-qq.err.log" 2>/dev/null || true
