#!/usr/bin/env python3
"""
E2E test for workspace.spawn_claude_session.

Since the server just types a command string into the workspace's focused
surface, we assert that the RPC returns spawned: true with the expected ids,
and that the command text ends up in the terminal via surface.read_text.
"""

from __future__ import annotations

import importlib.util
import os
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


def fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1


def main() -> int:
    project_dir = Path(tempfile.gettempdir()) / f"cmux_teleport_spawn_{os.getpid()}"
    project_dir.mkdir(parents=True, exist_ok=True)
    session_id = f"sess-{uuid.uuid4().hex}"

    try:
        with cmux() as client:
            client.set_app_focus(False)
            client.clear_notifications()

            workspace_id = client.new_workspace()

            # Missing workspace_id → invalid_params.
            try:
                client._call("workspace.spawn_claude_session", {"session_id": session_id})
                return fail("Expected invalid_params when workspace_id missing")
            except cmuxError as exc:
                if "invalid_params" not in str(exc):
                    return fail(f"Expected invalid_params, got {exc!s}")

            # Happy path.
            r = client._call(
                "workspace.spawn_claude_session",
                {
                    "workspace_id": workspace_id,
                    "session_id": session_id,
                    "cwd": str(project_dir),
                },
            )
            if r.get("spawned") is not True:
                return fail(f"Expected spawned: true, got {r!r}")
            if r.get("workspace_id") != workspace_id:
                return fail(f"Expected workspace_id {workspace_id!r}, got {r.get('workspace_id')!r}")
            if r.get("session_id") != session_id:
                return fail(f"Expected session_id {session_id!r}, got {r.get('session_id')!r}")
            if not r.get("surface_id"):
                return fail(f"Expected non-empty surface_id, got {r.get('surface_id')!r}")

            # The command string should land in the terminal buffer.
            # Give the surface a moment to render.
            deadline = time.time() + 3.0
            saw_command = False
            while time.time() < deadline:
                try:
                    tbuf = client._call("surface.read_text", {"surface_id": r["surface_id"]}) or {}
                except cmuxError:
                    tbuf = {}
                text = (tbuf.get("text") or "") if isinstance(tbuf, dict) else ""
                if f"claude --resume {session_id}" in text and f"TERMLOOP_WORKSPACE_ID={workspace_id}" in text:
                    saw_command = True
                    break
                time.sleep(0.2)
            if not saw_command:
                return fail("spawn command did not appear in surface buffer")

            print("PASS: workspace.spawn_claude_session — command typed into focused surface")
            return 0
    except (cmuxError, RuntimeError) as exc:
        return fail(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
