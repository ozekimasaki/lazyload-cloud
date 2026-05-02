#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" sync-index "$@"
else
  npx lazyload-cloud sync-index "$@"
fi
