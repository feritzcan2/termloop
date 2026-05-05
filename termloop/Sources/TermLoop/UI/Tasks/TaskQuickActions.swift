// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Quick actions available from the Tasks page (detail pane buttons,
/// sidebar drill-in actions, card context menu).
///
/// Per CLAUDE.md: agent-spawn must use the existing AgentInputs prompt
/// templates. We never inline a prompt string here; instead we route through
/// the existing Work-tab create-agent affordance which shows the user the
/// template picker.
@MainActor
enum TaskQuickActions {
    /// Switch the active sidebar tab to `.work` and select the bound workspace.
    /// Wired to actual focus plumbing in Task 18.
    static func openWorktree(workspaceId: UUID) {
        // Switch sidebar to work and store the selected workspace via existing
        // AppDelegate / AppStorage path. The existing ⌘Click affordance already
        // owns this — we just emit the same intent here.
        UserDefaults.standard.set(
            TermLoopSidebarTab.work.rawValue,
            forKey: TermLoopSidebarTab.storageKey
        )
        TaskQuickActionsBridge.requestFocusWorkspace(workspaceId)
    }

    /// Switch to Work tab on the bound workspace and ask the existing
    /// "+ Agent" affordance to open. No prompt is supplied — the user picks a
    /// template in the existing UI.
    static func addAgentRun(workspaceId: UUID) {
        openWorktree(workspaceId: workspaceId)
        TaskQuickActionsBridge.requestNewAgentPanel(workspaceId)
    }
}

/// Indirection point so the actions don't directly couple to AppDelegate /
/// TabManager APIs. The real bridge is set at app startup; tests can stub.
@MainActor
public enum TaskQuickActionsBridge {
    public static var requestFocusWorkspace: (UUID) -> Void = { _ in }
    public static var requestNewAgentPanel: (UUID) -> Void = { _ in }
}
