#!/usr/bin/env python3
"""
Regression test: install-claude-hooks must guard commands so they no-op
outside termloop instead of surfacing stale-socket errors in plain terminals.
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


def resolve_termloop_cli() -> str:
    explicit = os.environ.get("TERMLOOP_CLI_BIN") or os.environ.get("TERMLOOP_CLI")
    if explicit and os.path.exists(explicit) and os.access(explicit, os.X_OK):
        return explicit

    candidates: list[str] = []
    candidates.extend(glob.glob(os.path.expanduser("~/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug/termloop")))
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


def first_command(settings: dict, event: str) -> str:
    return (
        settings.get("hooks", {})
        .get(event, [{}])[0]
        .get("hooks", [{}])[0]
        .get("command", "")
    )


def main() -> int:
    try:
        cli_path = resolve_termloop_cli()
    except Exception as exc:
        return fail(str(exc))

    with tempfile.TemporaryDirectory(prefix="termloop-claude-hooks-home-") as home:
        env = os.environ.copy()
        env["HOME"] = home
        env["CFFIXED_USER_HOME"] = home

        proc = subprocess.run(
            [cli_path, "install-claude-hooks"],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        if proc.returncode != 0:
            return fail(f"install-claude-hooks failed: {proc.stderr}")

        settings_path = Path(home) / ".claude" / "settings.json"
        if not settings_path.exists():
            return fail(f"settings.json was not written at {settings_path}")

        settings = json.loads(settings_path.read_text())
        expected = {
            "SessionStart": "claude-hook session-start",
            "UserPromptSubmit": "claude-hook prompt-submit",
            "Stop": "stop.sh",
            "SessionEnd": "claude-hook session-end",
            "Notification": "notification.sh",
        }

        for event, needle in expected.items():
            command = first_command(settings, event)
            if not command:
                return fail(f"{event} hook command missing")
            if needle not in command:
                return fail(f"{event} hook missing expected marker {needle!r}: {command!r}")
            if "TERMLOOP_SURFACE_ID" not in command or "TERMLOOP_WORKSPACE_ID" not in command:
                return fail(f"{event} hook missing inside-termloop guard: {command!r}")
            if "|| echo '{}'" not in command:
                return fail(f"{event} hook missing no-op fallback: {command!r}")

        print("PASS: install-claude-hooks guards commands outside termloop")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
