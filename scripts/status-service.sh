#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
  Darwin)
    exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/status-launchd.sh"
    ;;
  Linux)
    exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/status-systemd.sh"
    ;;
  *)
    echo "service:status does not support this platform yet."
    exit 1
    ;;
esac
