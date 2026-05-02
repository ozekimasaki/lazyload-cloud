#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" get-function "$@" --format compact
else
  npx lazyload-cloud get-function "$@" --format compact
fi
