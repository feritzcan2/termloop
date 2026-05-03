// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

// termloop/Sources/TermLoop/Bridge/WorkspaceBridge.swift
import Foundation

/// High-level bridge purpose. Relay is the original workspace-to-workspace
/// kickoff mode; askAgent is the Claude → helper-agent consult flow that
/// reuses the same transport.
enum BridgeIntent: String, Codable, Equatable, Hashable {
    case relay
    case askAgent
}

/// How the cable decides to ship a side's latest assistant message to the
/// other side after kickoff. `.manual` (the default) waits for the user to
/// click an arrow on the cable. `.auto` is a one-shot arm: the next
/// `running → settled` edge on either side triggers a forward, after which
/// the bridge reverts to `.manual`. This avoids the "every Claude turn,
/// including local user chat, leaks to the helper" failure mode of a
/// persistent auto-forward.
enum BridgeForwardMode: String, Codable, Equatable, Hashable {
    case auto
    case manual
}

/// Reason a bridge stopped — surfaced in the sidebar cable badge.
enum BridgeStopReason: String, Codable, Equatable, Hashable {
    case manual
    case replied
    case workspaceClosed
    case sendTimeout
}

/// Which side of a bridge sent a message.
enum BridgeSender: String, Codable, Equatable, Hashable {
    case left
    case right
}

/// Sticky stamp written to `WorkspaceMetadataStore.Metadata` when a workspace
/// joins a bridge. Travels with the workspace through restart-time UUID
/// reminting (positional metadata restore + hidden sidecar restore both copy
/// full Metadata to the new workspace). Bridge restore scans these to rebind
/// `leftWorkspaceId` / `rightWorkspaceId` to the current runtime UUIDs.
struct BridgeMembership: Codable, Equatable, Hashable {
    let bridgeId: UUID
    let role: BridgeSender
}

/// Lifecycle state of a bridge. Either alive (running) or stopped. There is
/// no `.paused` state — manual forwarding has nothing to pause.
enum BridgeState: Codable, Equatable, Hashable {
    case running
    case stopped(BridgeStopReason)
}

/// One forwarded message kept in memory until the bridge is dismissed.
struct BridgeMessage: Identifiable, Codable, Equatable, Hashable {
    let id: UUID
    let sender: BridgeSender
    let text: String
    let timestamp: Date

    init(id: UUID = UUID(), sender: BridgeSender, text: String, timestamp: Date = Date()) {
        self.id = id
        self.sender = sender
        self.text = text
        self.timestamp = timestamp
    }
}

/// The single final answer delivered for an Ask-To request. `requestId` is
/// the bridge id; this marker is what makes `reply_to_request` one-shot.
struct BridgeFinalReply: Codable, Equatable, Hashable {
    let messageId: UUID
    let text: String
    let timestamp: Date
}

/// Model for a bidirectional link between two workspaces running terminal
/// agents. `left` and `right` are arbitrary — both sides can speak.
/// `firstSpeaker` picks which side receives the kickoff message so the
/// coordinator knows where to start. After kickoff, all forwarding is
/// user-initiated via the cable's arrow buttons.
struct WorkspaceBridge: Identifiable, Codable, Equatable, Hashable {
    let id: UUID
    /// Mutable so `WorkspaceBridgeStore.rebindAfterRestore` can update them to
    /// the current runtime UUIDs after a restart (workspace UUIDs are not
    /// round-tripped by upstream session save).
    var leftWorkspaceId: UUID
    var rightWorkspaceId: UUID
    var intent: BridgeIntent
    var state: BridgeState
    var messages: [BridgeMessage]
    var rolePrompt: String?
    var leftAgentId: String?
    var rightAgentId: String?
    var rightPrompt: String?
    var rightWorkspaceTitleOverride: String?
    var finalReply: BridgeFinalReply?
    var kickoffMessage: String
    var firstSpeaker: BridgeSender  // .left or .right
    /// True when the first turn was supplied through the agent launch command
    /// instead of pasted into an already-running TUI.
    var kickoffDeliveredAtLaunch: Bool?
    /// Optional for backward-compat with persisted bridges from before the
    /// auto/manual mode was introduced. Read via `effectiveForwardMode`,
    /// which falls back to `.manual`. Bridges saved by an interim build
    /// that defaulted nil → `.auto` will silently flip to `.manual` on
    /// next load, which matches the new "manual unless armed" semantics.
    var forwardMode: BridgeForwardMode?
    let createdAt: Date

    init(
        id: UUID = UUID(),
        leftWorkspaceId: UUID,
        rightWorkspaceId: UUID,
        intent: BridgeIntent = .relay,
        state: BridgeState = .running,
        messages: [BridgeMessage] = [],
        rolePrompt: String? = nil,
        leftAgentId: String? = nil,
        rightAgentId: String? = nil,
        rightPrompt: String? = nil,
        rightWorkspaceTitleOverride: String? = nil,
        finalReply: BridgeFinalReply? = nil,
        kickoffMessage: String,
        firstSpeaker: BridgeSender,
        kickoffDeliveredAtLaunch: Bool? = nil,
        forwardMode: BridgeForwardMode? = .manual,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.leftWorkspaceId = leftWorkspaceId
        self.rightWorkspaceId = rightWorkspaceId
        self.intent = intent
        self.state = state
        self.messages = messages
        self.rolePrompt = rolePrompt
        self.leftAgentId = leftAgentId
        self.rightAgentId = rightAgentId
        self.rightPrompt = rightPrompt
        self.rightWorkspaceTitleOverride = rightWorkspaceTitleOverride
        self.finalReply = finalReply
        self.kickoffMessage = kickoffMessage
        self.firstSpeaker = firstSpeaker
        self.kickoffDeliveredAtLaunch = kickoffDeliveredAtLaunch
        self.forwardMode = forwardMode
        self.createdAt = createdAt
    }

    var effectiveForwardMode: BridgeForwardMode {
        forwardMode ?? .manual
    }

    /// Workspace id on the given side.
    func workspaceId(for sender: BridgeSender) -> UUID? {
        switch sender {
        case .left: return leftWorkspaceId
        case .right: return rightWorkspaceId
        }
    }

    /// The opposite side of `sender`.
    func opposite(of sender: BridgeSender) -> BridgeSender? {
        switch sender {
        case .left: return .right
        case .right: return .left
        }
    }
}
