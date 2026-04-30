// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
enum TerminalAgentResolver {
    /// Resolves which `TerminalAgent` should be used for a workspace.
    /// Precedence: workspace override → project default → global default →
    /// the first built-in (claude). Returns nil only if the registry is
    /// empty, which is a programming error in v1.
    static func resolve(workspaceId: UUID) -> TerminalAgent? {
        let registry = TerminalAgentRegistry.shared

        if let explicit = WorkspaceMetadataStore.shared.terminalAgentId(for: workspaceId),
           let found = registry.agent(id: explicit) {
            return found
        }

        if let projectId = resolvedProjectId(workspaceId: workspaceId),
           let project = ProjectStore.shared.projects.first(where: { $0.id == projectId }),
           let projectDefault = project.defaultTerminalAgentId,
           let found = registry.agent(id: projectDefault) {
            return found
        }

        let global = TermLoopSettings.shared.defaultTerminalAgentId
        if let found = registry.agent(id: global) { return found }

        return registry.agents.first
    }

    private static func resolvedProjectId(workspaceId: UUID) -> UUID? {
        if let projectId = WorkspaceMetadataStore.shared.byWorkspaceId[workspaceId]?.projectId,
           ProjectStore.shared.project(id: projectId) != nil {
            return projectId
        }
        return ProjectStore.shared.activeProjectId
    }
}
