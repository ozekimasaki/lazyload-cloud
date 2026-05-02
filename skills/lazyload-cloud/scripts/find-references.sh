#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" find-references "$@" --format compact
else
  npx lazyload-cloud find-references "$@" --format compact
fi
