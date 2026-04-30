#!/usr/bin/env python3
"""Regression test: termloop CLI should not exit with SIGPIPE on broken stdout pipes."""

from __future__ import annotations

import glob
import os
import shutil
import subprocess


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


def run_with_closed_stdout(cli_path: str, *args: str) -> tuple[int, str]:
    read_fd, write_fd = os.pipe()
    os.close(read_fd)
    proc = subprocess.Popen(
        [cli_path, *args],
        stdout=write_fd,
        stderr=subprocess.PIPE,
        text=True,
        close_fds=True,
    )
    os.close(write_fd)
    _, stderr = proc.communicate()
    return proc.returncode, (stderr or "").strip()


def require_zero_exit(cli_path: str, *args: str) -> tuple[bool, str]:
    code, err = run_with_closed_stdout(cli_path, *args)
    if code != 0:
        cmd = " ".join(args)
        return False, f"`termloop {cmd}` exited {code} with closed stdout pipe (stderr={err!r})"
    return True, ""


def main() -> int:
    try:
        cli_path = resolve_termloop_cli()
    except Exception as exc:
        print(f"FAIL: {exc}")
        return 1

    ok_version, version_msg = require_zero_exit(cli_path, "--version")
    ok_help, help_msg = require_zero_exit(cli_path, "help")

    failures = [msg for msg in [version_msg, help_msg] if msg]
    if failures:
        print("FAIL: CLI still fails on broken stdout pipes")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("PASS: CLI ignores SIGPIPE and exits cleanly when stdout pipe is closed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
