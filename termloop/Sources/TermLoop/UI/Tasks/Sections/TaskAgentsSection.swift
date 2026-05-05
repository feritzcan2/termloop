// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar drill-in section: agents bound to the selected task's workspace.
/// v1 placeholder — Task 22 wires the real projection from
/// TerminalAgentActivityStore + WorkspaceMetadataStore.
struct TaskAgentsSection: View {
    let workspaceId: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(String(localized: "tasks.sidebar.section.agents",
                        defaultValue: "AGENTS", table: "TermLoop"))
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
            if workspaceId == nil {
                Text(String(localized: "tasks.sidebar.section.agents.unbound",
                            defaultValue: "Bind a worktree to add agents.", table: "TermLoop"))
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            } else {
                // v1 placeholder; Task 22 swaps in the real projection.
                Text(String(localized: "tasks.sidebar.section.agents.empty",
                            defaultValue: "No agent runs yet.", table: "TermLoop"))
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
        }
    }
}
