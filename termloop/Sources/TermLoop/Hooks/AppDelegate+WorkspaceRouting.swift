// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

extension AppDelegate {
    /// Number of workspaces across all windows currently tagged with the given
    /// project id. Used by project deletion UI to decide whether cascade
    /// options are needed.
    func workspaceCount(forProjectId projectId: UUID) -> Int {
        mainWindowContexts.values.reduce(0) { acc, context in
            acc + context.tabManager.tabs.filter { $0.projectId == projectId }.count
        }
    }

    /// Reassigns every workspace that currently belongs to `fromProjectId`
    /// over to `toProjectId`. Called after a project is deleted so orphaned
    /// workspaces remain addressable under the fallback project. Fires a
    /// session save so the change is durable.
    func reassignWorkspaces(fromProjectId: UUID, toProjectId: UUID) {
        var moved = 0
        for context in mainWindowContexts.values {
            for workspace in context.tabManager.tabs where workspace.projectId == fromProjectId {
                WorkspaceMetadataStore.shared.setProjectId(toProjectId, for: workspace)
                moved += 1
            }
        }
        if moved > 0 {
            _ = saveSessionSnapshot(includeScrollback: false)
        }
    }

    /// Closes every workspace that currently belongs to `projectId`.
    /// Used by project deletion so the project can be removed without
    /// reparenting its workspaces into a fallback project.
    @discardableResult
    func closeWorkspaces(inProjectId projectId: UUID, removeMetadata: Bool = true) -> Int {
        let workspaces = mainWindowContexts.values.flatMap { context in
            context.tabManager.tabs.filter { $0.projectId == projectId }
        }
        guard !workspaces.isEmpty else { return 0 }

        var closed = 0
        for workspace in workspaces {
            guard let tabManager = tabManagerFor(tabId: workspace.id) else { continue }
            tabManager.closeWorkspaceWithoutConfirmation(workspace)
            if removeMetadata {
                WorkspaceMetadataStore.shared.removeMetadataForId(workspace.id)
            }
            closed += 1
        }

        if closed > 0 {
            _ = saveSessionSnapshot(includeScrollback: false, forceSync: true)
        }
        return closed
    }

}
