#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" get-class "$@" --format compact
else
  npx lazyload-cloud get-class "$@" --format compact
fi
