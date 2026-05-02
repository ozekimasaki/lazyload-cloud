---
name: lazyload-cloud-sync
description: "Use lazyload-cloud to prepare, authenticate, and sync a local project index with the Cloudflare-backed backend. Use this when the task depends on remote status, remote query mode, or Cloudflare deployment/setup."
license: MIT
---

Use this skill for operational workflows around auth, sync, and remote status.

Recommended workflow:

1. Run `scripts/auth-status.sh` to confirm resolved auth.
2. Run `scripts/status.sh` to inspect local vs remote project state.
3. Run `scripts/sync-index.sh` after indexing if remote data must be current.

If remote auth is missing, use `lazyload-cloud auth login` before syncing.
