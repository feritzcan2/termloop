// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Classifies an TermLoop-spawned workspace whose presentation in the sidebar
/// differs from a normal user workspace. `nil` in metadata means normal.
enum AgentWorkspaceKind: Codable, Equatable {
    case abilityCreator
    case abilityRefiner(abilityId: String)
    case abilityDiscussion(abilityId: String)

    var abilityId: String? {
        switch self {
        case .abilityCreator:
            return nil
        case .abilityRefiner(let abilityId), .abilityDiscussion(let abilityId):
            return abilityId
        }
    }
}

/// Atomic (kind, spawnedAt) pair for an ability-agent workspace, surfaced
/// by `WorkspaceMetadataStore.abilitySession(forWorkspaceId:)`. Identifiable
/// so SwiftUI `ForEach` can key on the underlying workspace id.
struct AbilityAgentSession: Identifiable, Equatable {
    /// The workspace id — identity for `ForEach` and selection comparisons.
    let workspaceId: UUID
    let kind: AgentWorkspaceKind
    let spawnedAt: Date
    /// True when this session was spawned from a System Starter "Agent"
    /// button. System agent sessions are pinned in the Active Agents
    /// panel — no × / close button. Persists via
    /// `WorkspaceMetadataStore.Metadata.isSystemAgent`.
    let isSystem: Bool

    var id: UUID { workspaceId }
}
