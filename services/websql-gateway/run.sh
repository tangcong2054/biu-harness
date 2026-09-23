#!/bin/zsh
set -euo pipefail

CONFIG="${HOME}/.config/biu-websql-gateway/env"
if [[ -f "${CONFIG}" ]]; then
  set -a
  source "${CONFIG}"
  set +a
fi

SCRIPT_DIR="${0:A:h}"
exec /opt/homebrew/bin/node "${SCRIPT_DIR}/server.mjs"
