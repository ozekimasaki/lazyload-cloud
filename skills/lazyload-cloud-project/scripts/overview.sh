#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${LAZYLOAD_CLI_BIN:-}" ]]; then
  "${LAZYLOAD_CLI_BIN}" get-architecture-overview "$@" --format compact
else
  npx lazyload-cloud get-architecture-overview "$@" --format compact
fi
