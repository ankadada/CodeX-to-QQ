#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s)" in
  Darwin)
    exec tail -n 120 -f "${PROJECT_ROOT}/logs/codex-cli-qq.log"
    ;;
  Linux)
    exec journalctl --user -u codex-cli-qq.service -f
    ;;
  *)
    echo "logs command does not support this platform yet."
    exit 1
    ;;
esac
