#!/usr/bin/env python3
"""
E2E test for claude_hooks_installed probe exposed on workspace.list.

Uses the `termloop install-claude-hooks` / `termloop check-claude-hooks` CLIs to
set/clear the expected entries in ~/.claude/settings.json and asserts the
summary field flips appropriately. Saves and restores any pre-existing
settings.json.
"""

from __future__ import annotations

import glob
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path


def _load_v2_client():
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)
    v2_path = os.path.join(repo_root, "tests_v2", "cmux.py")
    spec = importlib.util.spec_from_file_location("cmux_v2", v2_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_v2 = _load_v2_client()
cmux = _v2.cmux
cmuxError = _v2.cmuxError


def resolve_termloop_cli() -> str:
    explicit = os.environ.get("TERMLOOP_CLI_BIN") or os.environ.get("TERMLOOP_CLI")
    if explicit and os.path.exists(explicit) and os.access(explicit, os.X_OK):
        return explicit
    candidates: list[str] = []
    candidates.extend(glob.glob(os.path.expanduser(
        "~/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug/termloop"
    )))
    candidates.extend(glob.glob("/tmp/termloop-*/Build/Products/Debug/termloop"))
    candidates = [p for p in candidates if os.path.exists(p) and os.access(p, os.X_OK)]
    if candidates:
        candidates.sort(key=os.path.getmtime, reverse=True)
        return candidates[0]
    in_path = shutil.which("termloop") or shutil.which("cmux")
    if in_path:
        return in_path
    raise RuntimeError("Unable to find termloop CLI binary. Set TERMLOOP_CLI_BIN.")


def fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1


def get_hooks_installed(client, workspace_id: str) -> bool | None:
    res = client._call("workspace.list") or {}
    for row in res.get("workspaces", []):
        if isinstance(row, dict) and str(row.get("id")) == workspace_id:
            return row.get("claude_hooks_installed")
    raise RuntimeError("workspace not found in list")


def wait_for_hooks_flag(client, workspace_id: str, expected: bool, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = get_hooks_installed(client, workspace_id)
        if last == expected:
            return True
        time.sleep(0.6)
    print(f"last observed claude_hooks_installed={last!r}")
    return False


def main() -> int:
    try:
        cli_path = resolve_termloop_cli()
    except Exception as exc:
        return fail(str(exc))

    settings_path = Path(os.path.expanduser("~/.claude/settings.json"))
    backup: str | None = None
    if settings_path.exists():
        backup = settings_path.read_text()

    try:
        # Start empty — no hooks installed.
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps({}))

        with cmux() as client:
            workspace_id = client.new_workspace()
            if not wait_for_hooks_flag(client, workspace_id, False):
                return fail("Expected claude_hooks_installed == false before install")

            # Install.
            proc = subprocess.run(
                [cli_path, "install-claude-hooks"],
                capture_output=True, text=True, check=False,
            )
            if proc.returncode != 0:
                return fail(f"install-claude-hooks failed: {proc.stderr}")

            if not wait_for_hooks_flag(client, workspace_id, True):
                return fail("Expected claude_hooks_installed == true after install")

            # Remove one required hook → flips back to false.
            current = json.loads(settings_path.read_text())
            hooks = current.get("hooks", {})
            hooks.pop("SessionStart", None)
            current["hooks"] = hooks
            settings_path.write_text(json.dumps(current))

            if not wait_for_hooks_flag(client, workspace_id, False):
                return fail("Expected claude_hooks_installed == false after removing SessionStart")

        print("PASS: claude_hooks_installed probe flips on install and on removal")
        return 0
    except (cmuxError, RuntimeError) as exc:
        return fail(str(exc))
    finally:
        try:
            if backup is not None:
                settings_path.write_text(backup)
            else:
                if settings_path.exists():
                    settings_path.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
