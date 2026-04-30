// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Disclosure chevron used next to a workspace's git-change indicator in
/// both the Folders tree (`WorktreeBadge`) and Worktree Agents rows
/// (`AgentRowCoreView` trailing slot). Unified here so the two surfaces
/// share one tooltip key and one visual contract.
@MainActor
struct SidebarGitChangesChevron: View {
    let isExpanded: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .frame(width: 14, height: 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isExpanded
            ? String(
                localized: "sidebarGitChanges.collapse",
                defaultValue: "Hide changed files",
                table: "TermLoop"
            )
            : String(
                localized: "sidebarGitChanges.expand",
                defaultValue: "Show changed files",
                table: "TermLoop"
            )
        )
    }
}
