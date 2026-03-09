#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
  Darwin)
    exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-launchd.sh"
    ;;
  Linux)
    exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-systemd.sh"
    ;;
  *)
    echo "install:service does not support this platform yet."
    exit 1
    ;;
esac
