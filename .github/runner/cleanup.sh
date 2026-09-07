#!/usr/bin/env bash
set -euo pipefail

# Installed outside the runner directory; shared by its start and completion hooks.
python3 - <<'PY'
import os
from pathlib import Path
import shutil
import signal

signal.alarm(180)

root = Path(os.environ["TERMLOOP_RUNNER_WORK_ROOT"])
if not root.is_absolute() or root.resolve() != root or root.name != "_work":
    raise SystemExit("Refusing an unexpected runner work root")
if not (root.parent / ".runner").is_file() or root.stat().st_uid != os.getuid():
    raise SystemExit("Refusing a work root not owned by this registered runner")

workspace = Path(os.environ["GITHUB_WORKSPACE"])
if workspace.parent.parent != root or workspace.name != workspace.parent.name:
    raise SystemExit("Refusing a workspace outside this runner's repository directory")

def remove(target):
    if target.is_symlink():
        target.unlink()
    elif target.exists():
        shutil.rmtree(target)

# Check every ancestor before traversal, including an interrupted previous checkout.
if workspace.parent.is_symlink():
    workspace.parent.unlink()
else:
    remove(workspace.parent)

# Toolchains remain installed. CARGO_HOME, PNPM_HOME and XDG cache/data paths
# point beneath this sibling directory in the runner service environment.
cache = root.parent.parent / "job-cache"
if cache.parent.resolve() != cache.parent:
    raise SystemExit("Refusing a cache with a symlinked parent")
remove(cache)

available = shutil.disk_usage(root).free // (1024 ** 3)
print(f"Runner workspace and job caches cleaned; {available} GiB available")
if available < 20:
    raise SystemExit("Runner requires at least 20 GiB free before accepting build work")
PY
