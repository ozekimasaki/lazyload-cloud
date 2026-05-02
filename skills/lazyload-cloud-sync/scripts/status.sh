#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" status "$@" --format compact
else
  npx lazyload-cloud status "$@" --format compact
fi
