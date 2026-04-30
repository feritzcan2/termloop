// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// One-pass migration that backfills `WorkspaceMetadataStore.terminalAgentId`
/// for every workspace that predates the single-agent-per-workspace model
/// (i.e. sidecar v3 installs upgrading to v4). Idempotent — workspaces that
/// already carry an id are left alone.
@MainActor
enum WorkspaceAgentMigration {
    /// Returns the workspace ids that were just migrated (so the focus path
    /// can surface a one-time banner). An empty array either means there was
    /// nothing to migrate or that every candidate already had an id.
    @discardableResult
    static func runIfNeeded() -> [UUID] {
        let fallback = TermLoopSettings.shared.defaultTerminalAgentId
        guard TerminalAgentRegistry.shared.agent(id: fallback) != nil else { return [] }

        var affected: [UUID] = []
        let ids = Array(WorkspaceMetadataStore.shared.byWorkspaceId.keys)
        for wsId in ids where WorkspaceMetadataStore.shared.terminalAgentId(for: wsId) == nil {
            WorkspaceMetadataStore.shared.setTerminalAgentId(fallback, for: wsId)
            affected.append(wsId)
        }
        return affected
    }
}
