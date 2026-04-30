#!/usr/bin/env python3
"""TermLoop fork discipline check.

Runs four static checks against staged changes (pre-commit) or an
arbitrary git range (CI). See docs/termloop/isolation-rules.md for the
full rules.

Checks:

  K1  new Swift files live under Sources/TermLoop/ or CLI/TermLoop/.
  K3a marker counts balance: every `// MARK: termloop-hook` is closed
      by a `// MARK: /termloop-hook`.
  K3b upstream-file edits sit inside marker blocks (no stray hunks).
  K4  no TermLoop-flavored localization keys leak into the upstream
      `Resources/Localizable.xcstrings` table.

Usage:
  termloop-check.py --staged              (pre-commit: staged vs HEAD)
  termloop-check.py --vs upstream/main    (CI: branch vs upstream)

An `termloop-exception: <reason>` trailer in the most recent commit
downgrades failures to warnings (only honored in --vs mode).
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

TERMLOOP_SOURCE_PREFIXES = (
    "Sources/TermLoop/",
    "CLI/TermLoop/",
)

TERMLOOP_KEY_PREFIXES = (
    "termloop.",
    "feature.",
    "project.",
    "skills.",
    "tcpBridge.",
)

MARK_OPEN = "// MARK: termloop-hook"
MARK_CLOSE = "// MARK: /termloop-hook"


def run(cmd: list[str]) -> tuple[int, str]:
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.returncode, res.stdout


def git_diff_args(mode: str, ref: str) -> list[str]:
    if mode == "staged":
        return ["--cached", ref]
    return [f"{ref}..HEAD"]


def changed_files(mode: str, ref: str) -> list[str]:
    rc, out = run(["git", "diff", "--name-only", *git_diff_args(mode, ref)])
    if rc != 0:
        print(f"error: `git diff` failed for mode={mode} ref={ref}", file=sys.stderr)
        sys.exit(2)
    return [f for f in out.strip().split("\n") if f]


def added_files(mode: str, ref: str) -> list[str]:
    rc, out = run(
        ["git", "diff", "--name-only", "--diff-filter=A", *git_diff_args(mode, ref)]
    )
    if rc != 0:
        return []
    return [f for f in out.strip().split("\n") if f]


def file_diff(mode: str, ref: str, path: str) -> str:
    rc, out = run(["git", "diff", *git_diff_args(mode, ref), "--", path])
    return out if rc == 0 else ""


def is_termloop_source(path: str) -> bool:
    return any(path.startswith(p) for p in TERMLOOP_SOURCE_PREFIXES)


def is_upstream_swift(path: str) -> bool:
    if not path.endswith(".swift"):
        return False
    if is_termloop_source(path):
        return False
    return path.startswith("Sources/") or path.startswith("CLI/")


def check_k1(new_files: list[str]) -> list[str]:
    errors: list[str] = []
    for f in new_files:
        if not f.endswith(".swift"):
            continue
        if f.startswith("Sources/") and not f.startswith("Sources/TermLoop/"):
            errors.append(f"K1: new Swift file outside Sources/TermLoop/: {f}")
        elif f.startswith("CLI/") and not f.startswith("CLI/TermLoop/"):
            errors.append(f"K1: new Swift file outside CLI/TermLoop/: {f}")
    return errors


def check_k3_balance(files: list[str]) -> list[str]:
    errors: list[str] = []
    for f in files:
        if not is_upstream_swift(f):
            continue
        p = Path(f)
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        opens = text.count(MARK_OPEN)
        closes = text.count(MARK_CLOSE)
        if opens != closes:
            errors.append(f"K3: marker imbalance in {f} (open={opens}, close={closes})")
    return errors


def stray_added_lines(diff_text: str) -> list[str]:
    """Return added lines in `diff_text` that fall outside marker blocks.

    Hunks are examined one at a time. Within a hunk we track whether we are
    inside a marker block by scanning BOTH context (' ') and added ('+')
    lines so the state matches what Swift actually sees in the final file.
    Marker lines themselves are always allowed.

    To avoid false positives when git re-emits a context line as remove+add
    (common when a method signature is pushed down by insertions above it),
    any `+` line whose raw content matches an earlier `-` line is ignored.
    """
    removed_contents: set[str] = set()
    removed_loose: set[str] = set()
    for line in diff_text.splitlines():
        if line.startswith("-") and not line.startswith("---"):
            content = line[1:]
            removed_contents.add(content)
            # Loose form: trailing comma + trailing whitespace stripped. Adding
            # a new parameter often forces a comma onto an upstream line.
            removed_loose.add(content.rstrip().rstrip(","))

    stray: list[str] = []
    inside = False
    in_hunk = False
    for line in diff_text.splitlines():
        if (
            line.startswith("diff ")
            or line.startswith("index ")
            or line.startswith("--- ")
            or line.startswith("+++ ")
            or line.startswith("new file")
            or line.startswith("deleted file")
            or line.startswith("similarity ")
            or line.startswith("rename ")
            or line.startswith("Binary ")
        ):
            continue
        if line.startswith("@@"):
            # New hunk — marker state is only known for lines we've seen.
            # Be conservative: assume `outside` at hunk start. If the first
            # lines are context lines with marker, we'll flip to inside before
            # seeing any `+` lines.
            inside = False
            in_hunk = True
            continue
        if not in_hunk:
            continue
        if line.startswith("+") and not line.startswith("+++"):
            content = line[1:]
            stripped = content.strip()
            if stripped == MARK_OPEN:
                inside = True
                continue
            if stripped == MARK_CLOSE:
                inside = False
                continue
            if not stripped:
                continue
            if content in removed_contents:
                # Re-emitted context line (git's diff minimization artefact).
                continue
            if content.rstrip().rstrip(",") in removed_loose:
                # Upstream line gained a trailing comma to accommodate an
                # appended parameter in the marker block below it.
                continue
            if not inside:
                # Snip for readability
                preview = stripped if len(stripped) <= 100 else stripped[:97] + "..."
                stray.append(preview)
        elif line.startswith(" "):
            content = line[1:].strip()
            if content == MARK_OPEN:
                inside = True
            elif content == MARK_CLOSE:
                inside = False
        elif line.startswith("-") and not line.startswith("---"):
            content = line[1:].strip()
            if content == MARK_OPEN:
                # Marker line being removed — treat context as if still outside.
                pass
    return stray


def check_k3_stray(mode: str, ref: str, files: list[str]) -> list[str]:
    errors: list[str] = []
    for f in files:
        if not is_upstream_swift(f):
            continue
        diff = file_diff(mode, ref, f)
        if not diff:
            continue
        stray = stray_added_lines(diff)
        if not stray:
            continue
        sample = ", ".join(repr(s) for s in stray[:3])
        more = f" (+{len(stray) - 3} more)" if len(stray) > 3 else ""
        errors.append(f"K3: stray edit(s) outside markers in {f}: {sample}{more}")
    return errors


def check_k4(mode: str, ref: str, files: list[str]) -> list[str]:
    target = "Resources/Localizable.xcstrings"
    if target not in files:
        return []
    diff = file_diff(mode, ref, target)
    pat = re.compile(r'^\+\s*"([^"]+)"\s*:\s*\{')
    offenders: list[str] = []
    for line in diff.splitlines():
        m = pat.match(line)
        if not m:
            continue
        key = m.group(1)
        if any(key.startswith(p) for p in TERMLOOP_KEY_PREFIXES):
            offenders.append(key)
    if not offenders:
        return []
    sample = ", ".join(offenders[:5])
    more = f" (+{len(offenders) - 5} more)" if len(offenders) > 5 else ""
    return [
        f"K4: TermLoop-flavored key(s) in upstream Localizable.xcstrings: "
        f"{sample}{more} (move to Resources/TermLoop.xcstrings)"
    ]


def has_exception_trailer(msg_file: str | None = None) -> bool:
    """Look for `termloop-exception:` trailer on the pending commit.

    `--msg-file` (commit-msg hook path) takes precedence when provided,
    since pre-commit runs before the message is stored anywhere readable.
    Otherwise fall back to HEAD's message, which is what CI/`--vs` wants.
    """
    if msg_file:
        try:
            text = Path(msg_file).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return False
        return any(line.startswith("termloop-exception:") for line in text.splitlines())
    rc, out = run(["git", "log", "-1", "--pretty=%B"])
    if rc != 0:
        return False
    return any(line.startswith("termloop-exception:") for line in out.splitlines())


def main() -> int:
    ap = argparse.ArgumentParser(description="TermLoop fork discipline check")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--staged", action="store_true", help="check staged index vs HEAD")
    group.add_argument("--vs", metavar="REF", help="check HEAD vs REF (e.g. upstream/main)")
    ap.add_argument(
        "--skip-stray-edits",
        action="store_true",
        help="skip K3b stray-edit check (useful for pre-commit, since that "
             "hook cannot see the commit message; defer the trailer-aware "
             "check to commit-msg)",
    )
    ap.add_argument(
        "--msg-file",
        metavar="PATH",
        help="path to the pending commit message file (git commit-msg $1); "
             "enables `termloop-exception:` trailer downgrade in --staged mode",
    )
    args = ap.parse_args()

    if args.staged:
        mode, ref = "staged", "HEAD"
    else:
        mode, ref = "vs", args.vs

    files = changed_files(mode, ref)
    new_files = added_files(mode, ref)

    if not files:
        print("TermLoop discipline: no relevant changes.")
        return 0

    errors: list[str] = []
    errors += check_k1(new_files)
    errors += check_k3_balance(files)
    if not args.skip_stray_edits:
        errors += check_k3_stray(mode, ref, files)
    errors += check_k4(mode, ref, files)

    if not errors:
        print(f"TermLoop discipline: OK ({len(files)} file(s) checked).")
        return 0

    downgraded = has_exception_trailer(args.msg_file)
    level = "warn" if downgraded else "error"
    print(f"TermLoop discipline {level.upper()}:", file=sys.stderr)
    for e in errors:
        print(f"  {e}", file=sys.stderr)
    print("", file=sys.stderr)
    print(
        "See docs/termloop/isolation-rules.md. For a one-off exception, add an\n"
        "  termloop-exception: <reason>\n"
        "commit trailer AND a new entry in docs/termloop/exceptions.md.",
        file=sys.stderr,
    )
    return 0 if downgraded else 1


if __name__ == "__main__":
    sys.exit(main())
