// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Session-only inline-preview expansion state, keyed by workspace id so
/// the Folders tree and Worktree Agents panel observe the same toggle when
/// a user expands the same workspace from either surface. Not persisted.
@MainActor
final class SidebarGitChangesExpansion: ObservableObject {
    static let shared = SidebarGitChangesExpansion()

    @Published private(set) var expandedWorkspaceIds: Set<UUID> = []

    private init() {}

    func isExpanded(_ workspaceId: UUID) -> Bool {
        expandedWorkspaceIds.contains(workspaceId)
    }

    func toggle(_ workspaceId: UUID) {
        if expandedWorkspaceIds.contains(workspaceId) {
            expandedWorkspaceIds.remove(workspaceId)
        } else {
            expandedWorkspaceIds.insert(workspaceId)
        }
    }

    func collapse(_ workspaceId: UUID) {
        expandedWorkspaceIds.remove(workspaceId)
    }
}
