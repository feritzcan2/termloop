---
title: "Update run targets"
description: "MCP hint for keeping the TermLoop Running popover current."
enabled: true
mcpTool: "set_run_targets"
includeInSkillFooter: true
---

Telemetry: After you start, restart, or stop something the user can look at (a dev server URL, an app bundle path, a dashboard, a tail-able log), call `mcp__termloop__set_run_targets` with the FULL current set as `{ targets: [{ label, url|path, status }] }`. Full-replace semantics: anything you drop from the array disappears from the chip. Each target is one row in the worktree's Running popover. Recommended `status` values: "running", "stopped", "error". Skip duplicate calls when nothing changed.

