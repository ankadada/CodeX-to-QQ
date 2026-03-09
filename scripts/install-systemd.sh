#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "install:systemd is only supported on Linux."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found."
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
UNIT_NAME="codex-cli-qq.service"
UNIT_PATH="${SYSTEMD_DIR}/${UNIT_NAME}"
NODE_BIN="$(command -v node)"

mkdir -p "${SYSTEMD_DIR}"

cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=codex-cli-qq
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=${NODE_BIN} ${PROJECT_ROOT}/src/index.js
Restart=always
RestartSec=2
Environment=PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
Environment=HOME=${HOME}

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}"
systemctl --user restart "${UNIT_NAME}"

echo "installed: ${UNIT_PATH}"
echo "service:   ${UNIT_NAME}"
echo "logs:      journalctl --user -u ${UNIT_NAME} -n 50 --no-pager"
