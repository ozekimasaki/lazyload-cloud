#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" list-functions "$@" --format compact
else
  npx lazyload-cloud list-functions "$@" --format compact
fi
