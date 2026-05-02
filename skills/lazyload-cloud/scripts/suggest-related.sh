#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" suggest-related "$@" --format compact
else
  npx lazyload-cloud suggest-related "$@" --format compact
fi
