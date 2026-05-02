#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" list-files "$@" --format compact
else
  npx lazyload-cloud list-files "$@" --format compact
fi
