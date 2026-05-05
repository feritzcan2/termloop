// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar drill-in section: uncommitted changes in the selected task's
/// worktree. v1 placeholder — Task 23 wires GitChangesMainAreaStore projection.
struct TaskGitChangesSection: View {
    let workspaceId: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(String(localized: "tasks.sidebar.section.gitChanges",
                        defaultValue: "GIT CHANGES", table: "TermLoop"))
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
            Text(String(localized: "tasks.sidebar.section.gitChanges.empty",
                        defaultValue: "No changes.", table: "TermLoop"))
                .font(.system(size: 11))
                .foregroundColor(.secondary)
        }
    }
}
