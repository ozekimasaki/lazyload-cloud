#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" trace-types "$@" --format compact
else
  npx lazyload-cloud trace-types "$@" --format compact
fi
