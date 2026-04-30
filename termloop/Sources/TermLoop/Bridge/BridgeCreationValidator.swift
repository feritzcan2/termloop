// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

// termloop/Sources/TermLoop/Bridge/BridgeCreationValidator.swift
import Foundation

/// Central validator for bridge creation invariants. Called by:
///   - drop target (Task 11) — to reject an Option-drag early
///   - link picker (Task 10) — to filter the submenu candidates
///   - kickoff sheet submit (Task 9) — to disable the Start button
///   - WorkspaceBridgeStore.add() (Task 3) — final enforcement, so the
///     invariant can't be bypassed even by a direct caller
///
/// Pure + injection-based: closures read metadata + existing bridges so
/// it's test-friendly and has no singleton dependency.
enum BridgeCreationError: Equatable {
    case sameWorkspace
    case differentProjects
    case unsupportedAgent
    case alreadyBridged
}

enum BridgeCreationResult: Equatable {
    case ok
    case error(BridgeCreationError)
}

enum BridgeCreationValidator {
    struct ValidationMetadata: Equatable {
        let projectId: UUID?
        let terminalAgentId: String?

        init(projectId: UUID?, terminalAgentId: String?) {
            self.projectId = projectId
            self.terminalAgentId = terminalAgentId
        }

        init(_ metadata: WorkspaceMetadataStore.Metadata) {
            self.projectId = metadata.projectId
            self.terminalAgentId = metadata.terminalAgentId
        }
    }

    private static let askAgentParticipants: Set<String> = [
        TerminalAgent.claudeId,
        "codex",
        "gemini"
    ]

    static func validate(
        intent: BridgeIntent = .relay,
        source: UUID,
        target: UUID,
        metadata: (UUID) -> WorkspaceMetadataStore.Metadata,
        existingBridgeFor: (UUID) -> WorkspaceBridge?
    ) -> BridgeCreationResult {
        return validate(
            intent: intent,
            source: source,
            target: target,
            metadataSnapshot: { ValidationMetadata(metadata($0)) },
            existingBridgeFor: existingBridgeFor
        )
    }

    static func validate(
        intent: BridgeIntent = .relay,
        source: UUID,
        target: UUID,
        metadataSnapshot: (UUID) -> ValidationMetadata,
        existingBridgeFor: (UUID) -> WorkspaceBridge?
    ) -> BridgeCreationResult {
        return validate(
            intent: intent,
            source: source,
            target: target,
            metadataSnapshot: metadataSnapshot,
            isAlreadyBridged: { existingBridgeFor($0) != nil }
        )
    }

    static func validate(
        intent: BridgeIntent = .relay,
        source: UUID,
        target: UUID,
        metadataSnapshot: (UUID) -> ValidationMetadata,
        isAlreadyBridged: (UUID) -> Bool
    ) -> BridgeCreationResult {
        if source == target { return .error(.sameWorkspace) }
        let sMeta = metadataSnapshot(source)
        let tMeta = metadataSnapshot(target)
        // projectId is UUID?; both must be non-nil and equal.
        guard let sProj = sMeta.projectId, let tProj = tMeta.projectId,
              sProj == tProj else {
            return .error(.differentProjects)
        }
        // nil means "agent not persisted yet" — can happen for pre-migration
        // workspaces, or workspaces restored from a sidecar that didn't
        // carry terminalAgentId. Default to Claude (the v1 scope) rather
        // than locking the user out. When the bridge is created the
        // metadata write in store.add() will persist the real value.
        let sAgent = sMeta.terminalAgentId ?? TerminalAgent.claudeId
        let tAgent = tMeta.terminalAgentId ?? TerminalAgent.claudeId
        let supportsAgents: Bool = {
            switch intent {
            case .relay:
                return sAgent == TerminalAgent.claudeId && tAgent == TerminalAgent.claudeId
            case .askAgent:
                return askAgentParticipants.contains(sAgent)
                    && askAgentParticipants.contains(tAgent)
            }
        }()
        if !supportsAgents {
            return .error(.unsupportedAgent)
        }
        if isAlreadyBridged(source) { return .error(.alreadyBridged) }
        if isAlreadyBridged(target) { return .error(.alreadyBridged) }
        return .ok
    }

    /// Convenience shim using the app-wide singletons. UI callers use
    /// this; tests use the injection-based `validate(...)` above.
    @MainActor
    static func validateLive(
        intent: BridgeIntent = .relay,
        source: UUID,
        target: UUID
    ) -> BridgeCreationResult {
        let metadataStore = WorkspaceMetadataStore.shared
        return validate(
            intent: intent,
            source: source,
            target: target,
            metadataSnapshot: {
                ValidationMetadata(
                    projectId: metadataStore.projectId(forWorkspaceId: $0),
                    terminalAgentId: metadataStore.terminalAgentId(for: $0)
                )
            },
            existingBridgeFor: { WorkspaceBridgeStore.shared.bridge(forWorkspaceId: $0) }
        )
    }
}
