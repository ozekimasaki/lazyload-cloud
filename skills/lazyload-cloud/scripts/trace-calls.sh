#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" trace-calls "$@" --format compact
else
  npx lazyload-cloud trace-calls "$@" --format compact
fi
