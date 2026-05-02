#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" get-module-dependencies "$@" --format compact
else
  npx lazyload-cloud get-module-dependencies "$@" --format compact
fi
