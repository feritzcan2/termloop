#!/usr/bin/env python3
"""End-to-end smoke test for worktree.* v2 socket methods.

Run against a tagged debug build's socket:

    TERMLOOP_SOCKET=/tmp/termloop-debug-worktree-manual.sock \
        python3 tests_v2/worktree_smoke.py

Creates a temp git repo + project + workspace, exercises attach / sharing /
auto-prune / keep-on-dirty / main-checkout resolution, then cleans up.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from termloop import CmuxClient, cmuxError  # type: ignore


def sh(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


def sh_out(*args, cwd=None) -> str:
    return subprocess.run(
        args, cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def main() -> int:
    socket_path = os.environ.get("TERMLOOP_SOCKET")
    if not socket_path:
        print("TERMLOOP_SOCKET must point to a tagged debug build socket", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()
        sh("git", "init", "-q", "-b", "main", cwd=repo)
        sh("git", "config", "user.email", "smoke@example.com", cwd=repo)
        sh("git", "config", "user.name", "Smoke", cwd=repo)
        sh("git", "commit", "--allow-empty", "-q", "-m", "init", cwd=repo)

        with CmuxClient(socket_path=socket_path) as c:
            print(f"connected: {socket_path}")

            proj = c._call("project.create", {
                "name": f"smoke-{os.getpid()}",
                "folder_path": str(repo),
            })
            project_id = proj["id"]
            print(f"created project {project_id}")

            try:
                _run_suite(c, repo, project_id)
            finally:
                try:
                    c._call("project.delete", {"project_id": project_id})
                except cmuxError as e:
                    print(f"[warn] project cleanup: {e}", file=sys.stderr)

    print("worktree_smoke OK")
    return 0


def _run_suite(c: "CmuxClient", repo: Path, project_id: str) -> None:
    # Two workspaces for sharing tests
    ws1 = c._call("workspace.create", {})["workspace_id"]
    ws2 = c._call("workspace.create", {})["workspace_id"]
    print(f"workspaces: {ws1[:8]} {ws2[:8]}")

    # 1. Attach ws1 to new branch feat/a
    r = c._call("worktree.attach", {
        "workspace_id": ws1, "branch": "feat/a", "create": True,
    })
    assert r["created_worktree"] is True, r
    assert r["resolves_to_main"] is False, r
    assert Path(r["path"]).is_dir(), r["path"]
    print("[1] attach new branch OK")

    # 2. ws2 attaches to same branch -> shared path
    r2 = c._call("worktree.attach", {"workspace_id": ws2, "branch": "feat/a"})
    assert r2["path"] == r["path"], (r, r2)
    assert r2["created_worktree"] is False, r2
    print("[2] shared attach OK")

    # 3. ws1 detaches -> worktree still alive (ws2 using it)
    d1 = c._call("worktree.detach", {"workspace_id": ws1})
    assert d1["worktree_pruned"] is False, d1
    assert Path(r["path"]).is_dir(), "worktree must survive while another workspace uses it"
    print("[3] detach keeps shared worktree OK")

    # 4. ws2 detach with auto -> worktree removed
    d2 = c._call("worktree.detach", {"workspace_id": ws2, "prune": "auto"})
    assert d2["worktree_pruned"] is True, d2
    assert not Path(r["path"]).exists(), "worktree must be pruned"
    print("[4] auto-prune OK")

    # 5. Dirty worktree keeps on detach-auto
    r3 = c._call("worktree.attach", {
        "workspace_id": ws1, "branch": "feat/b", "create": True,
    })
    feat_b_path = Path(r3["path"])
    (feat_b_path / "dirty.txt").write_text("x")
    d3 = c._call("worktree.detach", {"workspace_id": ws1, "prune": "auto"})
    assert d3["worktree_pruned"] is False, d3
    assert feat_b_path.exists(), "dirty worktree must be preserved on auto"
    print("[5] dirty-auto preserves worktree OK")

    # 6. main-checkout branch attach -> resolves_to_main
    main_branch = sh_out("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=repo)
    r_main = c._call("worktree.attach", {
        "workspace_id": ws2, "branch": main_branch,
    })
    assert r_main["resolves_to_main"] is True, r_main
    assert r_main["created_worktree"] is False, r_main
    print("[6] main-checkout resolve OK")

    # Cleanup worktree entries
    c._call("worktree.detach", {"workspace_id": ws2, "prune": "keep"})


if __name__ == "__main__":
    sys.exit(main())
