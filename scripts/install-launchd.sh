#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install:launchd is only supported on macOS."
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="${HOME}/Library/LaunchAgents"
LABEL="com.atou.codex-cli-qq"
PLIST_PATH="${AGENTS_DIR}/${LABEL}.plist"
LOG_DIR="${PROJECT_ROOT}/logs"
STDOUT_PATH="${LOG_DIR}/codex-cli-qq.log"
STDERR_PATH="${LOG_DIR}/codex-cli-qq.err.log"
NODE_BIN="$(command -v node)"
UID_VALUE="$(id -u)"
SERVICE_REF="gui/${UID_VALUE}/${LABEL}"

mkdir -p "${AGENTS_DIR}" "${LOG_DIR}"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${PROJECT_ROOT}/src/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>HOME</key>
      <string>${HOME}</string>
      <key>SHELL</key>
      <string>/bin/zsh</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${STDOUT_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_PATH}</string>
  </dict>
</plist>
EOF

chmod 644 "${PLIST_PATH}"

if launchctl print "${SERVICE_REF}" >/dev/null 2>&1; then
  launchctl enable "${SERVICE_REF}" >/dev/null 2>&1 || true
  launchctl kickstart -k "${SERVICE_REF}"
else
  launchctl bootout "${SERVICE_REF}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID_VALUE}" "${PLIST_PATH}"
  launchctl enable "${SERVICE_REF}" >/dev/null 2>&1 || true
  launchctl kickstart -k "${SERVICE_REF}"
fi

echo "installed: ${PLIST_PATH}"
echo "service:   ${SERVICE_REF}"
echo "stdout:    ${STDOUT_PATH}"
echo "stderr:    ${STDERR_PATH}"
