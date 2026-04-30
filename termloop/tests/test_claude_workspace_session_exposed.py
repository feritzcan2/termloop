#!/usr/bin/env python3
"""
E2E regression test for Claude session id exposure on workspace.list.

Validates:
1) workspace.list returns claude_session_id == null before any session
2) after claude-hook session-start, workspace.list shows the session id + cwd
3) after claude-hook session-end, the field is null again

The v2 JSON-RPC response for `workspace.list` carries the new
`claude_session_id` + `claude_cwd` fields (injected by
`TerminalController+TermLoop.termLoopWorkspaceSummaryFields`). The v1 text
protocol used by tests/cmux.py strips those fields, so this test imports the
v2 client (tests_v2/cmux.py) and calls `_call("workspace.list")` directly.
"""

from __future__ import annotations

import glob
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path


def _load_v2_client():
    """Load tests_v2/cmux.py as a distinct module (tests/cmux.py is v1)."""

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


def resolve_termloop_cli() -> str:
    explicit = os.environ.get("TERMLOOP_CLI_BIN") or os.environ.get("TERMLOOP_CLI")
    if explicit and os.path.exists(explicit) and os.access(explicit, os.X_OK):
        return explicit
    candidates: list[str] = []
    candidates.extend(
        glob.glob(
            os.path.expanduser(
                "~/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug/termloop"
            )
        )
    )
    candidates.extend(glob.glob("/tmp/termloop-*/Build/Products/Debug/termloop"))
    candidates = [p for p in candidates if os.path.exists(p) and os.access(p, os.X_OK)]
    if candidates:
        candidates.sort(key=os.path.getmtime, reverse=True)
        return candidates[0]
    in_path = shutil.which("termloop") or shutil.which("cmux")
    if in_path:
        return in_path
    raise RuntimeError("Unable to find termloop CLI binary. Set TERMLOOP_CLI_BIN.")


def run_claude_hook(cli_path, socket_path, subcommand, payload, env):
    proc = subprocess.run(
        [cli_path, "--socket", socket_path, "claude-hook", subcommand],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"termloop claude-hook {subcommand} failed:\n"
            f"exit={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}"
        )


def fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1


def workspace_summary(client, workspace_id: str) -> dict:
    """Look up the v2 dict summary for a workspace via workspace.list."""

    res = client._call("workspace.list") or {}
    summaries = res.get("workspaces") or []
    for row in summaries:
        if isinstance(row, dict) and str(row.get("id")) == workspace_id:
            return row
    raise RuntimeError(
        f"workspace {workspace_id} not found in workspace.list; got {summaries!r}"
    )


def main() -> int:
    try:
        cli_path = resolve_termloop_cli()
    except Exception as exc:
        return fail(str(exc))

    state_path = Path(tempfile.gettempdir()) / f"cmux_claude_ws_state_{os.getpid()}.json"
    lock_path = Path(str(state_path) + ".lock")
    for p in (state_path, lock_path):
        try:
            if p.exists():
                p.unlink()
        except OSError:
            pass

    project_dir = Path(tempfile.gettempdir()) / f"cmux_claude_ws_project_{os.getpid()}"
    project_dir.mkdir(parents=True, exist_ok=True)
    session_id = f"sess-{uuid.uuid4().hex}"

    try:
        with cmux() as client:
            client.set_app_focus(False)
            client.clear_notifications()

            workspace_id = client.new_workspace()

            pre = workspace_summary(client, workspace_id)
            if pre.get("claude_session_id") is not None:
                return fail(
                    f"Expected claude_session_id null pre-start, got {pre.get('claude_session_id')!r}"
                )
            if pre.get("claude_cwd") is not None:
                return fail(
                    f"Expected claude_cwd null pre-start, got {pre.get('claude_cwd')!r}"
                )

            hook_env = os.environ.copy()
            hook_env["TERMLOOP_SOCKET_PATH"] = client.socket_path
            hook_env["TERMLOOP_WORKSPACE_ID"] = workspace_id
            hook_env["TERMLOOP_CLAUDE_HOOK_STATE_PATH"] = str(state_path)

            run_claude_hook(
                cli_path,
                client.socket_path,
                "session-start",
                {"session_id": session_id, "cwd": str(project_dir)},
                hook_env,
            )

            after_start = workspace_summary(client, workspace_id)
            if after_start.get("claude_session_id") != session_id:
                return fail(
                    f"Expected claude_session_id={session_id!r} after start, "
                    f"got {after_start.get('claude_session_id')!r}"
                )
            if after_start.get("claude_cwd") != str(project_dir):
                return fail(
                    f"Expected claude_cwd={project_dir!s} after start, "
                    f"got {after_start.get('claude_cwd')!r}"
                )

            run_claude_hook(
                cli_path,
                client.socket_path,
                "session-end",
                {"session_id": session_id},
                hook_env,
            )

            after_end = workspace_summary(client, workspace_id)
            if after_end.get("claude_session_id") is not None:
                return fail(
                    f"Expected claude_session_id null after session-end, "
                    f"got {after_end.get('claude_session_id')!r}"
                )

            print("PASS: claude_session_id round-trip on workspace.list")
            return 0
    except (cmuxError, RuntimeError) as exc:
        return fail(str(exc))
    finally:
        for p in (state_path, lock_path):
            try:
                if p.exists():
                    p.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
