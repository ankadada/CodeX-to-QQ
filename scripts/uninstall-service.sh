#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
  Darwin)
    exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/uninstall-launchd.sh"
    ;;
  Linux)
    exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/uninstall-systemd.sh"
    ;;
  *)
    echo "uninstall:service does not support this platform yet."
    exit 1
    ;;
esac
