---
name: lazyload-cloud-project
description: Use lazyload-cloud to understand project shape: list files, list functions, inspect module dependencies, and check architecture overview. Use this before deep code changes or when onboarding into a repository.
---

Use this skill when the task is structural rather than symbol-specific.

Recommended workflow:

1. Run `scripts/list-files.sh` to identify hot spots.
2. Run `scripts/list-functions.sh` to see the most relevant entry points.
3. Run `scripts/module-dependencies.sh <module>` to understand how one module connects to the rest of the project.
4. Run `scripts/overview.sh` for a compact architecture summary.
