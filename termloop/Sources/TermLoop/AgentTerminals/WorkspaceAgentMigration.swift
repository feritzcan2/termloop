// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Backfills `WorkspaceMetadataStore.terminalAgentId` only for restored
/// workspaces that already have agent evidence. A normal task/worktree checkout
/// with no agent history must stay agentless across restart.
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
        for wsId in ids {
            let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: wsId)
            guard metadata.terminalAgentId == nil,
                  hasAgentEvidence(metadata) else { continue }
            WorkspaceMetadataStore.shared.setTerminalAgentId(fallback, for: wsId)
            affected.append(wsId)
        }
        return affected
    }

    private static func hasAgentEvidence(_ metadata: WorkspaceMetadataStore.Metadata) -> Bool {
        metadata.persistedAgentSession != nil
            || metadata.agentKind != nil
            || metadata.agentSpawnedAt != nil
            || metadata.lastUserPromptAt != nil
            || metadata.awaitingInputSince != nil
            || metadata.lastMessagePreview != nil
            || metadata.lastAttentionKindRaw != nil
    }
}
