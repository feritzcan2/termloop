#!/usr/bin/env python3
"""
E2E test for workspace.kill_claude_session.

Flow:
1. Create a workspace.
2. Spawn a real `sleep` process and treat its pid as the "claude" pid.
3. Call workspace.report_claude_session with the pid.
4. Assert kill returns { killed: true, pid, session_id } and the pid is gone.
5. Re-call kill; expect { killed: false, reason: "no_session" }.
6. Report another session without pid; expect { killed: false, reason: "no_pid" }.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


def _load_v2_client():
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)
    v2_path = os.path.join(repo_root, "tests_v2", "cmux.py")
    if not os.path.exists(v2_path):
        raise RuntimeError(f"tests_v2/cmux.py not found at {v2_path}")
    spec = importlib.util.spec_from_file_location("cmux_v2", v2_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to build import spec for {v2_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_v2 = _load_v2_client()
cmux = _v2.cmux
cmuxError = _v2.cmuxError


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1


def main() -> int:
    project_dir = Path(tempfile.gettempdir()) / f"cmux_teleport_kill_{os.getpid()}"
    project_dir.mkdir(parents=True, exist_ok=True)
    session_id = f"sess-{uuid.uuid4().hex}"

    sleeper = None
    try:
        with cmux() as client:
            client.set_app_focus(False)
            client.clear_notifications()

            workspace_id = client.new_workspace()

            # Spawn a sleep process we can kill as a stand-in for claude.
            sleeper = subprocess.Popen(
                ["sleep", "120"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            sleep_pid = sleeper.pid

            # Register session + pid via the v2 socket (bypassing the CLI hook).
            client._call(
                "workspace.report_claude_session",
                {
                    "workspace_id": workspace_id,
                    "session_id": session_id,
                    "cwd": str(project_dir),
                    "pid": sleep_pid,
                },
            )

            # Kill should succeed and report our pid.
            r = client._call("workspace.kill_claude_session", {"workspace_id": workspace_id})
            if r.get("killed") is not True:
                return fail(f"Expected killed: true, got {r!r}")
            if r.get("pid") != sleep_pid:
                return fail(f"Expected pid {sleep_pid}, got {r.get('pid')!r}")
            if r.get("session_id") != session_id:
                return fail(f"Expected session_id {session_id!r}, got {r.get('session_id')!r}")

            # Give SIGTERM a moment to land.
            deadline = time.time() + 3.0
            while time.time() < deadline:
                if not pid_alive(sleep_pid):
                    break
                time.sleep(0.1)
            if pid_alive(sleep_pid):
                return fail(f"pid {sleep_pid} still alive after kill RPC")

            # Clear the session (simulating session-end hook) and kill again — no_session.
            client._call(
                "workspace.clear_claude_session",
                {"workspace_id": workspace_id},
            )
            r2 = client._call("workspace.kill_claude_session", {"workspace_id": workspace_id})
            if r2.get("killed") is not False or r2.get("reason") != "no_session":
                return fail(f"Expected killed: false, reason: no_session, got {r2!r}")

            # Register a session without a pid — kill should refuse with no_pid.
            client._call(
                "workspace.report_claude_session",
                {
                    "workspace_id": workspace_id,
                    "session_id": session_id,
                    "cwd": str(project_dir),
                },
            )
            r3 = client._call("workspace.kill_claude_session", {"workspace_id": workspace_id})
            if r3.get("killed") is not False or r3.get("reason") != "no_pid":
                return fail(f"Expected killed: false, reason: no_pid, got {r3!r}")

            print("PASS: workspace.kill_claude_session — happy path, no_session, no_pid")
            return 0
    except (cmuxError, RuntimeError) as exc:
        return fail(str(exc))
    finally:
        if sleeper is not None and sleeper.poll() is None:
            try:
                sleeper.send_signal(signal.SIGKILL)
            except ProcessLookupError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
