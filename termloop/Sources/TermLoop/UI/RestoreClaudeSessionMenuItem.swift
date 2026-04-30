// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

extension TermLoopSidebar {
    /// Context-menu entry that re-runs `claude --resume <sid>` for a
    /// workspace whose prior claude session was saved to the TermLoop
    /// sidecar. Rendered only when at least one of the selected
    /// workspaces has a pending persisted session AND no currently-live
    /// one (a live session means either claude is already running or the
    /// auto-restore already fired — either way, no injecting duplicate
    /// keystrokes). When multiple workspaces are selected, clicking the
    /// item restores each eligible one in turn.
    struct RestoreClaudeSessionMenuItem: View {
        let targetIds: [UUID]
        @ObservedObject private var metadata = WorkspaceMetadataStore.shared

        private var eligibleIds: [UUID] {
            targetIds.filter { id in
                metadata.persistedAgentSession(for: id)?.agentId == TerminalAgent.claudeId &&
                metadata.claudeSession(workspaceId: id.uuidString) == nil
            }
        }

        var body: some View {
            if !eligibleIds.isEmpty {
                Divider()
                Button(String(
                    localized: "contextMenu.restoreClaudeSession",
                    defaultValue: "Restore Claude Session",
                    table: "TermLoop"
                )) {
                    for id in eligibleIds {
                        ClaudeRestoreCoordinator.shared.restoreNow(workspaceId: id)
                    }
                }
            }
        }
    }
}
