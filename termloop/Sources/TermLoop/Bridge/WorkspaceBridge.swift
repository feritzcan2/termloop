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

/// The single final answer delivered for an Ask-To request. Stored on the
/// request, not on the bridge lifecycle: replying closes that one request,
/// while the bridge/conversation can stay available for manual forwards or a
/// later follow-up request.
struct BridgeFinalReply: Codable, Equatable, Hashable {
    let messageId: UUID
    let text: String
    let timestamp: Date
}

/// One single-use Ask-To request inside a long-lived askAgent bridge. A
/// bridge is the conversation/link between source and helper workspaces; each
/// request is a one-shot job that the helper must close with exactly one
/// `reply_to_request` call.
struct AskToRequest: Identifiable, Codable, Equatable, Hashable {
    let id: UUID
    var message: String
    var kickoffMessage: String
    var finalReply: BridgeFinalReply?
    let createdAt: Date

    init(
        id: UUID = UUID(),
        message: String,
        kickoffMessage: String,
        finalReply: BridgeFinalReply? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.message = message
        self.kickoffMessage = kickoffMessage
        self.finalReply = finalReply
        self.createdAt = createdAt
    }

    var isOpen: Bool { finalReply == nil }
}

/// Model for a bidirectional link between two workspaces running terminal
/// agents. `left` and `right` are arbitrary — both sides can speak.
/// `firstSpeaker` picks which side receives the kickoff message so the
/// coordinator knows where to start. After kickoff, all forwarding is
/// user-initiated via the cable's arrow buttons.
struct WorkspaceBridge: Identifiable, Equatable, Hashable {
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
    /// Legacy mirror for the most recent final Ask-To reply. New code should
    /// use `askToRequests`; this stays to keep old persisted bridge JSON and
    /// older UI reads from losing the last answer during migration.
    var finalReply: BridgeFinalReply?
    var askToRequests: [AskToRequest]
    var kickoffMessage: String
    var firstSpeaker: BridgeSender  // .left or .right
    /// True when the first turn was supplied through the agent launch command
    /// instead of pasted into an already-running TUI.
    var kickoffDeliveredAtLaunch: Bool?
    /// Launch-scoped bearer token for Ask-To final replies. This lets
    /// `reply_to_request` authenticate the helper even if the provider's MCP
    /// process reports a stale workspace id.
    var askToReplyToken: String?
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
        askToRequests: [AskToRequest] = [],
        kickoffMessage: String,
        firstSpeaker: BridgeSender,
        kickoffDeliveredAtLaunch: Bool? = nil,
        askToReplyToken: String? = nil,
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
        self.askToRequests = askToRequests
        self.kickoffMessage = kickoffMessage
        self.firstSpeaker = firstSpeaker
        self.kickoffDeliveredAtLaunch = kickoffDeliveredAtLaunch
        self.askToReplyToken = askToReplyToken
        self.forwardMode = forwardMode
        self.createdAt = createdAt
    }

    var effectiveForwardMode: BridgeForwardMode {
        forwardMode ?? .manual
    }

    var latestAskToRequest: AskToRequest? {
        askToRequests.max { $0.createdAt < $1.createdAt }
    }

    var openAskToRequest: AskToRequest? {
        askToRequests.first { $0.isOpen }
    }

    func askToRequest(id requestId: UUID) -> AskToRequest? {
        askToRequests.first { $0.id == requestId }
    }

    /// Back-compat: old Ask-To bridges used `bridge.id` as the request id.
    func containsAskToRequest(id requestId: UUID) -> Bool {
        askToRequest(id: requestId) != nil
            || (intent == .askAgent && id == requestId)
    }

    /// Helper-side Ask-To launches carry a request stamp and bridge-scoped
    /// bearer token in their MCP environment. This lets replies authenticate
    /// even when the MCP process reports a stale or missing workspace id.
    func acceptsAskToLaunchCredential(
        requestId: UUID?,
        replyToken: String?,
        callerAgentId: String?
    ) -> Bool {
        guard let requestId,
              containsAskToRequest(id: requestId) else {
            return false
        }
        guard let suppliedToken = replyToken?.trimmingCharacters(in: .whitespacesAndNewlines),
              !suppliedToken.isEmpty,
              let expectedToken = askToReplyToken?.trimmingCharacters(in: .whitespacesAndNewlines),
              suppliedToken == expectedToken else {
            return false
        }

        let callerAgent = callerAgentId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let bridgeAgent = rightAgentId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return callerAgent == nil
            || callerAgent?.isEmpty == true
            || bridgeAgent == nil
            || callerAgent == bridgeAgent
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

/// Restore-time identity for one persisted bridge endpoint. Ask-To helpers
/// additionally carry a session floor and the open request's launch credential
/// so a resumed MCP process remains bound to the same durable conversation.
struct WorkspaceBridgeAgentRestoreContext: Equatable {
    let bridgeId: UUID
    let role: BridgeSender
    let agentId: String
    let isAskToHelper: Bool
    let minimumSessionDate: Date?
    let launchEnvironment: [String: String]
}

/// Shared identity policy for Ask-To helpers. Helpers intentionally share the
/// source workspace's cwd, so cwd matching alone cannot distinguish their
/// transcript from older agent sessions in that checkout.
enum AskToHelperRestorePolicy {
    private static let sessionFloorSkewBuffer: TimeInterval = 1

    static func minimumSessionDate(for bridge: WorkspaceBridge) -> Date {
        bridge.createdAt.addingTimeInterval(-sessionFloorSkewBuffer)
    }

    static func accepts(
        sessionFileCreationDate: Date?,
        persistedUpdatedAt: Date?,
        minimumSessionDate: Date
    ) -> Bool {
        guard let identityDate = sessionFileCreationDate ?? persistedUpdatedAt else {
            return false
        }
        return identityDate >= minimumSessionDate
    }
}

extension WorkspaceBridge: Codable {
    enum CodingKeys: String, CodingKey {
        case id
        case leftWorkspaceId
        case rightWorkspaceId
        case intent
        case state
        case messages
        case rolePrompt
        case leftAgentId
        case rightAgentId
        case rightPrompt
        case rightWorkspaceTitleOverride
        case finalReply
        case askToRequests
        case kickoffMessage
        case firstSpeaker
        case kickoffDeliveredAtLaunch
        case askToReplyToken
        case forwardMode
        case createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        leftWorkspaceId = try c.decode(UUID.self, forKey: .leftWorkspaceId)
        rightWorkspaceId = try c.decode(UUID.self, forKey: .rightWorkspaceId)
        intent = try c.decodeIfPresent(BridgeIntent.self, forKey: .intent) ?? .relay
        state = try c.decodeIfPresent(BridgeState.self, forKey: .state) ?? .running
        messages = try c.decodeIfPresent([BridgeMessage].self, forKey: .messages) ?? []
        rolePrompt = try c.decodeIfPresent(String.self, forKey: .rolePrompt)
        leftAgentId = try c.decodeIfPresent(String.self, forKey: .leftAgentId)
        rightAgentId = try c.decodeIfPresent(String.self, forKey: .rightAgentId)
        rightPrompt = try c.decodeIfPresent(String.self, forKey: .rightPrompt)
        rightWorkspaceTitleOverride = try c.decodeIfPresent(String.self, forKey: .rightWorkspaceTitleOverride)
        finalReply = try c.decodeIfPresent(BridgeFinalReply.self, forKey: .finalReply)
        kickoffMessage = try c.decodeIfPresent(String.self, forKey: .kickoffMessage) ?? ""
        firstSpeaker = try c.decodeIfPresent(BridgeSender.self, forKey: .firstSpeaker) ?? .left
        kickoffDeliveredAtLaunch = try c.decodeIfPresent(Bool.self, forKey: .kickoffDeliveredAtLaunch)
        askToReplyToken = try c.decodeIfPresent(String.self, forKey: .askToReplyToken)
        forwardMode = try c.decodeIfPresent(BridgeForwardMode.self, forKey: .forwardMode)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()

        let decodedRequests = try c.decodeIfPresent([AskToRequest].self, forKey: .askToRequests) ?? []
        if intent == .askAgent, decodedRequests.isEmpty {
            askToRequests = [
                AskToRequest(
                    id: id,
                    message: kickoffMessage,
                    kickoffMessage: kickoffMessage,
                    finalReply: finalReply,
                    createdAt: createdAt
                )
            ]
        } else {
            askToRequests = decodedRequests
        }

        // Legacy builds used `.stopped(.replied)` to mean "the single request
        // has replied". In the split model that is request state, not bridge
        // lifecycle, so revive those links on decode and keep their controls.
        if intent == .askAgent,
           case .stopped(.replied) = state {
            state = .running
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(leftWorkspaceId, forKey: .leftWorkspaceId)
        try c.encode(rightWorkspaceId, forKey: .rightWorkspaceId)
        try c.encode(intent, forKey: .intent)
        try c.encode(state, forKey: .state)
        try c.encode(messages, forKey: .messages)
        try c.encodeIfPresent(rolePrompt, forKey: .rolePrompt)
        try c.encodeIfPresent(leftAgentId, forKey: .leftAgentId)
        try c.encodeIfPresent(rightAgentId, forKey: .rightAgentId)
        try c.encodeIfPresent(rightPrompt, forKey: .rightPrompt)
        try c.encodeIfPresent(rightWorkspaceTitleOverride, forKey: .rightWorkspaceTitleOverride)
        try c.encodeIfPresent(finalReply, forKey: .finalReply)
        try c.encode(askToRequests, forKey: .askToRequests)
        try c.encode(kickoffMessage, forKey: .kickoffMessage)
        try c.encode(firstSpeaker, forKey: .firstSpeaker)
        try c.encodeIfPresent(kickoffDeliveredAtLaunch, forKey: .kickoffDeliveredAtLaunch)
        try c.encodeIfPresent(askToReplyToken, forKey: .askToReplyToken)
        try c.encodeIfPresent(forwardMode, forKey: .forwardMode)
        try c.encode(createdAt, forKey: .createdAt)
    }
}
