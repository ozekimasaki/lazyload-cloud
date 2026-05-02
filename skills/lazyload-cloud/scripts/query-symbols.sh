#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" search-symbols "$@" --format compact
else
  npx lazyload-cloud search-symbols "$@" --format compact
fi
