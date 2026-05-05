// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar drill-in section: worktree branches for the selected task.
/// v1 renders just the bound branch (passed via the snapshot); Task 23
/// expands to WorktreeGroup projection.
struct TaskBranchesSection: View {
    let branch: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(String(localized: "tasks.sidebar.section.branches",
                        defaultValue: "WORKTREE BRANCHES", table: "TermLoop"))
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
            if let branch {
                Text(branch).font(.system(size: 11))
            } else {
                Text(String(localized: "tasks.sidebar.section.branches.empty",
                            defaultValue: "No branch info.", table: "TermLoop"))
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
        }
    }
}
