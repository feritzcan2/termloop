// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Restore-time prune for ability-agent workspaces.
///
/// `TabManager.closeWorkspace(_:)` hard-guards on `tabs.count > 1` (correct
/// for interactive Cmd+W — never leave the user with zero tabs). That guard
/// makes a loop silently no-op once count hits 1, so a restore where every
/// tab is an ability-agent would strand the last one. When that's the case,
/// we spawn a blank replacement first so the guard stays satisfied.
@MainActor
extension TabManager {
    /// Iterates the window's tabs, closes every workspace flagged as an
    /// ability-agent session, and maintains upstream's non-empty-tabs
    /// invariant by spawning a replacement when the prune would otherwise
    /// leave the window empty. No-op when there is nothing to prune.
    func pruneAbilityAgentWorkspaces() {
        let victims = tabs.filter {
            TermLoopHooks.shouldPruneOnRestore(workspaceId: $0.id)
        }
        guard !victims.isEmpty else { return }

        // If the prune would leave the window with zero tabs, spawn a
        // blank replacement first so closeWorkspace's `tabs.count > 1`
        // guard does not block the final close. The replacement becomes
        // the new selected tab at the end of the loop.
        let allTaggedBranch = victims.count == tabs.count
        if allTaggedBranch {
            _ = addWorkspace(
                title: nil,
                workingDirectory: nil,
                select: true,
                eagerLoadTerminal: false
            )
        }

        // closeWorkspace fires TermLoopHooks.workspaceDidClose, which
        // clears the agent-session metadata. No need to clear here.
        for ws in victims {
            closeWorkspace(ws)
        }

        // If selectedTabId still points at a pruned workspace (can happen
        // if upstream selection logic ran before our hook), repair it.
        if let selected = selectedTabId,
           !tabs.contains(where: { $0.id == selected }),
           let first = tabs.first {
            selectedTabId = first.id
        }
    }
}
