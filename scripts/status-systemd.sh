#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "service:status:systemd is only supported on Linux."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found."
  exit 1
fi

UNIT_NAME="codex-cli-qq.service"

echo "=== systemctl --user status ==="
systemctl --user status "${UNIT_NAME}" --no-pager || true
echo
echo "=== journalctl (tail 40) ==="
journalctl --user -u "${UNIT_NAME}" -n 40 --no-pager || true
