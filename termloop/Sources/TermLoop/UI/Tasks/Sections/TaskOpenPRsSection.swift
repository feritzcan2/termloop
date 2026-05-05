// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar drill-in section: open PRs for the selected task's branch.
/// v1 placeholder — Task 23 wires the existing PR query path.
struct TaskOpenPRsSection: View {
    let workspaceId: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(String(localized: "tasks.sidebar.section.openPRs",
                        defaultValue: "OPEN PRS", table: "TermLoop"))
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
            Text(String(localized: "tasks.sidebar.section.openPRs.empty",
                        defaultValue: "No open PRs.", table: "TermLoop"))
                .font(.system(size: 11))
                .foregroundColor(.secondary)
        }
    }
}
