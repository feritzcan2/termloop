// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

enum TerminalAgentPresentationSource: String, Equatable {
    case live
    case pendingRestore
    case sticky
    case bound
}

struct TerminalAgentPresentationState: Equatable {
    let workspaceId: UUID
    let agentId: String?
    let displayState: TerminalAgentDisplayState
    let latestActivityAt: Date?
    let since: Date?
    let preview: String?
    let lastUserPromptAt: Date?
    let isPendingRestore: Bool
    let source: TerminalAgentPresentationSource
}

/// Pure slice of `WorkspaceMetadataStore.Metadata` that feeds presentation
/// compute. Kept as its own value type so the reducer is trivially unit-testable
/// without standing up the full metadata store.
struct TerminalAgentMetadataSnapshot: Equatable {
    let terminalAgentId: String?
    let persistedAgentSessionAgentId: String?
    let persistedAgentSessionUpdatedAt: Date?
    let awaitingInputSince: Int?
    let lastMessagePreview: String?
    let lastAttentionKindRaw: String?
    let lastUserPromptAt: Date?

    static let empty = TerminalAgentMetadataSnapshot(
        terminalAgentId: nil,
        persistedAgentSessionAgentId: nil,
        persistedAgentSessionUpdatedAt: nil,
        awaitingInputSince: nil,
        lastMessagePreview: nil,
        lastAttentionKindRaw: nil,
        lastUserPromptAt: nil
    )
}

/// Common presentation snapshot consumed by every agent-row consumer.
/// Panel-specific extras (git badge, PR badge, branch summary, elapsed label,
/// selection) are layered on top by each panel; those are UI concerns and
/// therefore not part of the truth contract.
struct AgentRowPresentationSnapshot: Equatable {
    let workspaceId: UUID
    let title: String
    let agentId: String?
    let agentLabel: String
    let stateText: String
    let displayState: TerminalAgentDisplayState
    let branchLabel: String?
    let preview: String?
    let since: Date?
    let lastUserPromptAt: Date?

    /// Panel-specific override builder. `nil` for `title` means "keep existing".
    /// Prevents silent drift when new fields are added to the snapshot.
    func with(
        title: String? = nil,
        branchLabel: String?,
        since: Date?
    ) -> AgentRowPresentationSnapshot {
        AgentRowPresentationSnapshot(
            workspaceId: workspaceId,
            title: title ?? self.title,
            agentId: agentId,
            agentLabel: agentLabel,
            stateText: stateText,
            displayState: displayState,
            branchLabel: branchLabel,
            preview: preview,
            since: since,
            lastUserPromptAt: lastUserPromptAt
        )
    }
}

enum TerminalAgentPresentationReducer {
    private static let logger = Logger(
        subsystem: "com.termloop.fork",
        category: "agent-lifecycle.reducer"
    )

    private static func lifecycleLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        let rendered = message()
        logger.debug("\(rendered, privacy: .public)")
        #endif
    }

    /// Pure reducer. No `Date()`, no PID liveness probe, no store reads —
    /// stale/liveness signals are pre-baked into `raw` by the reconcile
    /// timer.
    static func computePresentation(
        workspaceId: UUID,
        raw: TerminalAgentActivityState?,
        metadata: TerminalAgentMetadataSnapshot,
        pending: TerminalAgentActivityStore.PendingPlaceholderState?
    ) -> TerminalAgentPresentationState? {
        let result = resolve(
            workspaceId: workspaceId,
            raw: raw,
            metadata: metadata,
            pending: pending
        )
        #if DEBUG
        if let result {
            switch result.source {
            case .live:
                assert(raw != nil, "TerminalAgentPresentationReducer: .live requires raw activity")
            case .pendingRestore:
                assert(pending != nil, "TerminalAgentPresentationReducer: .pendingRestore requires pending placeholder")
            case .sticky:
                assert(
                    metadata.lastAttentionKindRaw != nil || metadata.awaitingInputSince != nil,
                    "TerminalAgentPresentationReducer: .sticky requires sticky metadata (kind or awaitingInputSince)"
                )
            case .bound:
                assert(
                    metadata.terminalAgentId != nil || metadata.persistedAgentSessionAgentId != nil,
                    "TerminalAgentPresentationReducer: .bound requires an agent binding in metadata"
                )
            }
            if result.source == .live, result.displayState == .running {
                assert(result.since != nil, "TerminalAgentPresentationReducer: live .running requires since")
            }
        }
        #endif
        return result
    }

    // MARK: - Core resolution

    private static func resolve(
        workspaceId: UUID,
        raw: TerminalAgentActivityState?,
        metadata: TerminalAgentMetadataSnapshot,
        pending: TerminalAgentActivityStore.PendingPlaceholderState?
    ) -> TerminalAgentPresentationState? {
        if let raw {
            let liveDisplay = mapDisplayState(
                phase: raw.phase,
                attentionKind: raw.attentionKind
            )
            // When raw falls back to .ready but sticky metadata is set, prefer
            // the sticky outcome so restored Completed/Error/Needs-input does
            // not flash back to plain ready on reconnect.
            if liveDisplay == .ready, let sticky = resolveSticky(metadata: metadata) {
                lifecycleLog(
                    "reducer.readyOverriddenBySticky workspace=\(workspaceId.uuidString) agent=\(raw.agentId) sticky=\(sticky.state.rawValue) rawUpdatedAt=\(raw.updatedAt.timeIntervalSince1970)"
                )
                return make(
                    workspaceId: workspaceId,
                    agentId: raw.agentId,
                    displayState: sticky.state,
                    latestActivityAt: sticky.latestActivityAt ?? raw.updatedAt,
                    since: sticky.latestActivityAt ?? raw.startedAt ?? raw.updatedAt,
                    metadata: metadata,
                    raw: raw,
                    isPendingRestore: false,
                    source: .sticky
                )
            }
            lifecycleLog(
                "reducer.live workspace=\(workspaceId.uuidString) agent=\(raw.agentId) display=\(liveDisplay.rawValue) rawPhase=\(raw.phase.rawValue) attention=\(raw.attentionKind?.rawValue ?? "nil")"
            )
            return make(
                workspaceId: workspaceId,
                agentId: raw.agentId,
                displayState: liveDisplay,
                latestActivityAt: raw.updatedAt,
                since: raw.startedAt ?? raw.updatedAt,
                metadata: metadata,
                raw: raw,
                isPendingRestore: false,
                source: .live
            )
        }

        if let pending {
            let display: TerminalAgentDisplayState = (pending == .running) ? .running : .ready
            lifecycleLog(
                "reducer.pending workspace=\(workspaceId.uuidString) agent=\(metadata.terminalAgentId ?? metadata.persistedAgentSessionAgentId ?? "nil") display=\(display.rawValue)"
            )
            return make(
                workspaceId: workspaceId,
                agentId: metadata.terminalAgentId ?? metadata.persistedAgentSessionAgentId,
                displayState: display,
                latestActivityAt: metadata.persistedAgentSessionUpdatedAt,
                since: metadata.persistedAgentSessionUpdatedAt,
                metadata: metadata,
                raw: nil,
                isPendingRestore: true,
                source: .pendingRestore
            )
        }

        if let sticky = resolveSticky(metadata: metadata) {
            lifecycleLog(
                "reducer.sticky workspace=\(workspaceId.uuidString) agent=\(metadata.terminalAgentId ?? metadata.persistedAgentSessionAgentId ?? "nil") display=\(sticky.state.rawValue) kind=\(metadata.lastAttentionKindRaw ?? "nil")"
            )
            return make(
                workspaceId: workspaceId,
                agentId: metadata.terminalAgentId ?? metadata.persistedAgentSessionAgentId,
                displayState: sticky.state,
                latestActivityAt: sticky.latestActivityAt,
                since: sticky.latestActivityAt,
                metadata: metadata,
                raw: nil,
                isPendingRestore: false,
                source: .sticky
            )
        }

        if let agentId = metadata.terminalAgentId ?? metadata.persistedAgentSessionAgentId {
            let baseline = metadata.lastUserPromptAt ?? metadata.persistedAgentSessionUpdatedAt
            lifecycleLog(
                "reducer.bound workspace=\(workspaceId.uuidString) agent=\(agentId) baseline=\(baseline?.timeIntervalSince1970.description ?? "nil")"
            )
            return make(
                workspaceId: workspaceId,
                agentId: agentId,
                displayState: .ready,
                latestActivityAt: baseline,
                since: baseline,
                metadata: metadata,
                raw: nil,
                isPendingRestore: false,
                source: .bound
            )
        }

        lifecycleLog("reducer.nil workspace=\(workspaceId.uuidString)")
        return nil
    }

    /// Builder that centralizes the preview precedence (raw wins when present,
    /// else metadata) and lastUserPromptAt propagation so each resolve branch
    /// only supplies what is unique.
    private static func make(
        workspaceId: UUID,
        agentId: String?,
        displayState: TerminalAgentDisplayState,
        latestActivityAt: Date?,
        since: Date?,
        metadata: TerminalAgentMetadataSnapshot,
        raw: TerminalAgentActivityState?,
        isPendingRestore: Bool,
        source: TerminalAgentPresentationSource
    ) -> TerminalAgentPresentationState {
        let preview: String? = {
            if source == .sticky {
                return metadata.lastMessagePreview ?? raw?.preview
            }
            return raw?.preview ?? metadata.lastMessagePreview
        }()
        return TerminalAgentPresentationState(
            workspaceId: workspaceId,
            agentId: agentId,
            displayState: displayState,
            latestActivityAt: latestActivityAt,
            since: since,
            preview: preview,
            lastUserPromptAt: metadata.lastUserPromptAt,
            isPendingRestore: isPendingRestore,
            source: source
        )
    }

    // MARK: - Pure phase → display mapping

    static func mapDisplayState(_ activity: TerminalAgentActivityState?) -> TerminalAgentDisplayState {
        guard let activity else { return .idle }
        return mapDisplayState(phase: activity.phase, attentionKind: activity.attentionKind)
    }

    static func mapDisplayState(
        phase: TerminalAgentActivityPhase,
        attentionKind: TerminalAgentAttentionKind?
    ) -> TerminalAgentDisplayState {
        switch phase {
        case .inactive:
            return .idle
        case .ready:
            return .ready
        case .running:
            return .running
        case .failed:
            return .error
        case .waiting:
            switch attentionKind {
            case .completion:
                return .completed
            case .error:
                return .error
            case .notification, .permission, .userInput, .none:
                return .needsInput
            }
        }
    }

    // MARK: - Sticky helper

    private struct StickyResolution {
        let state: TerminalAgentDisplayState
        let latestActivityAt: Date?
    }

    private static func resolveSticky(
        metadata: TerminalAgentMetadataSnapshot
    ) -> StickyResolution? {
        guard metadata.lastAttentionKindRaw != nil || metadata.awaitingInputSince != nil else {
            return nil
        }
        let kind = metadata.lastAttentionKindRaw
            .flatMap(TerminalAgentAttentionKind.init(rawValue:))
        let state: TerminalAgentDisplayState
        switch kind {
        case .completion:
            state = .completed
        case .error:
            state = .error
        case .notification, .permission, .userInput, .none:
            state = .needsInput
        }
        let activityAt: Date? = metadata.awaitingInputSince
            .map { Date(timeIntervalSince1970: TimeInterval($0)) }
        return StickyResolution(state: state, latestActivityAt: activityAt)
    }
}
