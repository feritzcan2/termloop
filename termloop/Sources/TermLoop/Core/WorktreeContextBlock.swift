// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Composes a tiny `<system-reminder>` block injected only when the agent
/// runs inside an TermLoop worktree. Tells the agent which branch and
/// physical worktree path it is operating from so it does not have to
/// discover this through shell calls.
enum WorktreeContextBlock {
    static func compose(
        isWorktree: Bool,
        branchName: String?,
        runCwd: URL?
    ) -> String? {
        guard isWorktree else { return nil }
        let branch = branchName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let path = runCwd?.standardizedFileURL.path ?? ""
        guard !branch.isEmpty || !path.isEmpty else { return nil }

        var out = "<system-reminder>\n"
        out += "# Worktree Context\n\n"
        out += "You are operating from this worktree and branch — anchor your work here.\n"
        if !branch.isEmpty {
            out += "- Branch: \(branch)\n"
        }
        if !path.isEmpty {
            out += "- Worktree: \(path)\n"
        }
        out += "</system-reminder>"
        return out
    }
}
