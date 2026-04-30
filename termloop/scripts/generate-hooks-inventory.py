#!/usr/bin/env python3
"""Regenerate docs/termloop/hooks-inventory.md from the actual marker blocks
found in upstream-owned Swift files.

Scans every `.swift` file under `Sources/` and `CLI/` (excluding
`Sources/TermLoop/` and `CLI/TermLoop/`) for `// MARK: termloop-hook` /
`// MARK: /termloop-hook` pairs and emits a table:

  | File | Line | First line of block |

Run from the repo root. Writes the inventory in place.
"""

from __future__ import annotations

import sys
from pathlib import Path

MARK_OPEN = "// MARK: termloop-hook"
MARK_CLOSE = "// MARK: /termloop-hook"

EXCLUDE_PREFIXES = ("Sources/TermLoop/", "CLI/TermLoop/")
SCAN_ROOTS = ("Sources", "CLI")


def swift_files() -> list[Path]:
    roots = [Path(r) for r in SCAN_ROOTS]
    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*.swift"):
            s = str(p)
            if any(s.startswith(pref) for pref in EXCLUDE_PREFIXES):
                continue
            files.append(p)
    files.sort()
    return files


def scan_file(path: Path) -> list[tuple[int, str]]:
    """Return a list of (line_number, first_body_line) for each marker block."""
    blocks: list[tuple[int, str]] = []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip() == MARK_OPEN:
            start = i + 1
            body_preview = ""
            j = i + 1
            while j < len(lines) and lines[j].strip() != MARK_CLOSE:
                if not body_preview and lines[j].strip():
                    body_preview = lines[j].strip()
                j += 1
            blocks.append((start, body_preview or "(empty block)"))
            i = j + 1
        else:
            i += 1
    return blocks


def main() -> int:
    out_lines: list[str] = []
    out_lines.append("# Hooks Inventory")
    out_lines.append("")
    out_lines.append(
        "Auto-generated from the `// MARK: termloop-hook` marker blocks present"
    )
    out_lines.append(
        "in upstream-owned Swift files. Regenerate with"
        " `scripts/generate-hooks-inventory.py`."
    )
    out_lines.append("")
    out_lines.append("| File | Line | Hook |")
    out_lines.append("|------|------|------|")

    total = 0
    for f in swift_files():
        blocks = scan_file(f)
        for line_num, preview in blocks:
            preview_md = preview.replace("|", r"\|")
            out_lines.append(f"| `{f}` | {line_num} | `{preview_md}` |")
            total += 1
    out_lines.append("")
    out_lines.append(f"Total hook blocks: **{total}**.")
    out_lines.append("")

    target = Path("docs/termloop/hooks-inventory.md")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(out_lines), encoding="utf-8")
    print(f"wrote {target} ({total} hook block(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
