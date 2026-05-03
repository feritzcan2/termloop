// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation

/// Persistent singleton tracking all active bridges. The bridges array is
/// loaded from disk on init and re-saved after every mutation so a bridge
/// (transcripts included) survives an app restart. Pairs with
/// `BridgeCoordinator.start(tabManager:)`, which validates the restored
/// bridges against actual tabs and closes orphaned hidden helpers.
///
/// File: `~/Library/Application Support/TermLoop/bridges-<bundleId>.json`
@MainActor
final class WorkspaceBridgeStore: ObservableObject {
    static let shared = WorkspaceBridgeStore()

    private static let maxMessagesPerBridge = 40

    enum FinalReplyRecordResult: Equatable {
        case recorded(bridgeId: UUID, messageId: UUID)
        case notFound
        case notAskAgent
        case notRunning
        case alreadyReplied
    }

    enum AskToRequestAppendResult: Equatable {
        case appended
        case notFound
        case notAskAgent
        case notRunning
        case requestAlreadyOpen
    }

    @Published private(set) var bridges: [WorkspaceBridge] = []
    /// Narrow subscription channel for views that only care about bridge
    /// membership / lifecycle. Transcript appends do NOT bump this — rows
    /// subscribe via `overviewTick` and read transcript via the inline
    /// transcript's own observation.
    @Published private(set) var overviewVersion: Int = 0

    private let fileURL: URL
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    init() {
        self.fileURL = Self.defaultFileURL()
        finishInit()
    }

    init(fileURL: URL) {
        self.fileURL = fileURL
        finishInit()
    }

    private func finishInit() {
        BridgeDebugTrace.log("store.init file=\(fileURL.path)")
        load()
        BridgeDebugTrace.log("store.init.done loaded=\(bridges.count)")
    }

    func bridge(id: UUID) -> WorkspaceBridge? {
        bridges.first { $0.id == id }
    }

    func bridge(containingAskToRequestId requestId: UUID) -> WorkspaceBridge? {
        bridges.first { $0.containsAskToRequest(id: requestId) }
    }

    func bridge(forWorkspaceId wsId: UUID) -> WorkspaceBridge? {
        let matches = bridges.filter {
            $0.leftWorkspaceId == wsId || $0.rightWorkspaceId == wsId
        }
        return matches.first(where: { $0.state == .running }) ?? matches.last
    }

    func activeBridge(forWorkspaceId wsId: UUID) -> WorkspaceBridge? {
        bridges.first {
            $0.state == .running
                && ($0.leftWorkspaceId == wsId || $0.rightWorkspaceId == wsId)
        }
    }

    /// Returns false if the bridge fails creation validation or if either
    /// workspace is already in another bridge. Delegates to
    /// `BridgeCreationValidator` as the single source of truth so the
    /// invariant can't be bypassed by a direct caller.
    @discardableResult
    func add(_ bridge: WorkspaceBridge) -> Bool {
        let result = BridgeCreationValidator.validate(
            intent: bridge.intent,
            source: bridge.leftWorkspaceId,
            target: bridge.rightWorkspaceId,
            metadata: { WorkspaceMetadataStore.shared.metadata(forWorkspaceId: $0) },
            existingBridgeFor: { self.activeBridge(forWorkspaceId: $0) }
        )
        guard case .ok = result else { return false }
        // Persist the agent id on both endpoints so the next launch's
        // restore finds it and the bridge stays eligible. No-op when the
        // metadata already has a terminalAgentId.
        let metaStore = WorkspaceMetadataStore.shared
        for (wsId, fallbackAgent) in Self.fallbackAgents(for: bridge, metaStore: metaStore) {
            if metaStore.metadata(forWorkspaceId: wsId).terminalAgentId == nil {
                metaStore.setTerminalAgentId(fallbackAgent, for: wsId)
            }
        }
        bridges.append(bridge)
        overviewVersion &+= 1
        // Stamp both endpoints so `rebindAfterRestore` can re-link the
        // bridge to current-session workspace UUIDs after a restart.
        metaStore.setBridgeMembership(
            BridgeMembership(bridgeId: bridge.id, role: .left),
            forWorkspaceId: bridge.leftWorkspaceId
        )
        metaStore.setBridgeMembership(
            BridgeMembership(bridgeId: bridge.id, role: .right),
            forWorkspaceId: bridge.rightWorkspaceId
        )
        BridgeDebugTrace.log("store.add ok id=\(bridge.id.uuidString.prefix(8)) intent=\(bridge.intent) total=\(bridges.count)")
        save()
        return true
    }

    func stop(id: UUID, reason: BridgeStopReason) {
        update(id: id, updateOverview: true) { $0.state = .stopped(reason) }
    }

    func setForwardMode(id: UUID, mode: BridgeForwardMode) {
        update(id: id, updateOverview: true) { $0.forwardMode = mode }
    }

    func appendMessage(bridgeId: UUID, sender: BridgeSender, text: String) {
        update(id: bridgeId) { bridge in
            bridge.messages.append(BridgeMessage(sender: sender, text: text))
            if bridge.messages.count > Self.maxMessagesPerBridge {
                bridge.messages.removeFirst(bridge.messages.count - Self.maxMessagesPerBridge)
            }
        }
    }

    /// Adds a new single-use Ask-To request to an existing askAgent bridge.
    /// Only one request may be open per helper conversation so the helper's
    /// `reply_to_request` has an unambiguous job to close.
    func appendAskToRequest(
        bridgeId: UUID,
        request: AskToRequest
    ) -> AskToRequestAppendResult {
        guard let idx = bridges.firstIndex(where: { $0.id == bridgeId }) else {
            return .notFound
        }
        guard bridges[idx].intent == .askAgent else {
            return .notAskAgent
        }
        guard bridges[idx].state == .running else {
            BridgeDebugTrace.log(
                "store.askTo.append reject bridge=\(bridgeId.uuidString.prefix(8)) request=\(request.id.uuidString.prefix(8)) reason=not-running"
            )
            return .notRunning
        }
        guard bridges[idx].openAskToRequest == nil else {
            BridgeDebugTrace.log(
                "store.askTo.append reject bridge=\(bridgeId.uuidString.prefix(8)) request=\(request.id.uuidString.prefix(8)) reason=request-already-open"
            )
            return .requestAlreadyOpen
        }

        bridges[idx].askToRequests.append(request)
        // Keep the legacy/latest kickoff mirror useful for debugging and
        // persistence viewers, but do not treat it as bridge identity.
        bridges[idx].kickoffMessage = request.kickoffMessage
        overviewVersion &+= 1
        save()
        BridgeDebugTrace.log(
            "store.askTo.append ok bridge=\(bridgeId.uuidString.prefix(8)) request=\(request.id.uuidString.prefix(8)) " +
            "openCount=\(bridges[idx].askToRequests.filter(\.isOpen).count) totalRequests=\(bridges[idx].askToRequests.count)"
        )
        return .appended
    }

    /// Records the one final helper reply for an Ask-To request and closes
    /// only that request id. The bridge remains `.running` so users can keep
    /// manually forwarding between visible agents or create a later follow-up
    /// request on the same helper conversation.
    func recordFinalReply(requestId: UUID, text: String) -> FinalReplyRecordResult {
        guard let idx = bridges.firstIndex(where: { bridge in
            bridge.containsAskToRequest(id: requestId)
        }) else {
            BridgeDebugTrace.log("store.reply record reject request=\(requestId.uuidString.prefix(8)) reason=not-found")
            return .notFound
        }
        guard bridges[idx].intent == .askAgent else {
            BridgeDebugTrace.log(
                "store.reply record reject bridge=\(bridges[idx].id.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) reason=not-ask-agent"
            )
            return .notAskAgent
        }
        guard bridges[idx].state == .running else {
            BridgeDebugTrace.log(
                "store.reply record reject bridge=\(bridges[idx].id.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) reason=not-running"
            )
            return .notRunning
        }

        if bridges[idx].askToRequests.isEmpty {
            bridges[idx].askToRequests = [
                AskToRequest(
                    id: bridges[idx].id,
                    message: bridges[idx].kickoffMessage,
                    kickoffMessage: bridges[idx].kickoffMessage,
                    finalReply: bridges[idx].finalReply,
                    createdAt: bridges[idx].createdAt
                )
            ]
        }
        guard let requestIdx = bridges[idx].askToRequests.firstIndex(where: { $0.id == requestId }) else {
            BridgeDebugTrace.log(
                "store.reply record reject bridge=\(bridges[idx].id.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) reason=request-missing"
            )
            return .notFound
        }
        guard bridges[idx].askToRequests[requestIdx].finalReply == nil else {
            BridgeDebugTrace.log(
                "store.reply record reject bridge=\(bridges[idx].id.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) reason=already-replied"
            )
            return .alreadyReplied
        }

        let message = BridgeMessage(sender: .right, text: text)
        bridges[idx].messages.append(message)
        if bridges[idx].messages.count > Self.maxMessagesPerBridge {
            bridges[idx].messages.removeFirst(bridges[idx].messages.count - Self.maxMessagesPerBridge)
        }
        let finalReply = BridgeFinalReply(
            messageId: message.id,
            text: text,
            timestamp: message.timestamp
        )
        bridges[idx].askToRequests[requestIdx].finalReply = finalReply
        bridges[idx].finalReply = finalReply
        // A final one-shot reply should disarm any pending auto forward; the
        // user can re-arm manually from the still-running cable.
        bridges[idx].forwardMode = .manual
        overviewVersion &+= 1
        save()
        BridgeDebugTrace.log(
            "store.reply record ok bridge=\(bridges[idx].id.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) " +
            "message=\(message.id.uuidString.prefix(8)) chars=\(text.count)"
        )
        return .recorded(bridgeId: bridges[idx].id, messageId: message.id)
    }

    /// Completely removes the bridge from the store and clears the
    /// `bridgeMembership` stamps from both endpoints.
    func dismiss(id: UUID) {
        guard let bridge = bridges.first(where: { $0.id == id }) else { return }
        let metaStore = WorkspaceMetadataStore.shared
        metaStore.setBridgeMembership(nil, forWorkspaceId: bridge.leftWorkspaceId)
        metaStore.setBridgeMembership(nil, forWorkspaceId: bridge.rightWorkspaceId)
        bridges.removeAll { $0.id == id }
        overviewVersion &+= 1
        save()
    }

    /// Re-links each persisted bridge to the current-session workspace UUIDs
    /// by scanning `WorkspaceMetadataStore` for matching `bridgeMembership`
    /// stamps. Workspace UUIDs are reminted by upstream session restore, but
    /// metadata stamps travel positionally (visible) or by preserved id
    /// (hidden), so the stamp is the stable identity. Bridges whose stamps
    /// can't both be found are dropped.
    func rebindAfterRestore(tabManager: TabManager) {
        let metaStore = WorkspaceMetadataStore.shared
        let knownIds = Set(tabManager.tabs.map(\.id))
        var sidesByBridgeId: [UUID: [BridgeSender: UUID]] = [:]
        for (wsId, meta) in metaStore.byWorkspaceId {
            guard let stamp = meta.bridgeMembership, knownIds.contains(wsId) else { continue }
            sidesByBridgeId[stamp.bridgeId, default: [:]][stamp.role] = wsId
        }
        BridgeDebugTrace.log("store.rebind start bridges=\(bridges.count) stamps=\(sidesByBridgeId.count) known=\(knownIds.count)")

        var rebuilt: [WorkspaceBridge] = []
        var changed = false
        for bridge in bridges {
            guard let sides = sidesByBridgeId[bridge.id],
                  let newLeft = sides[.left],
                  let newRight = sides[.right]
            else {
                BridgeDebugTrace.log("store.rebind drop id=\(bridge.id.uuidString.prefix(8)) reason=stamps-missing")
                changed = true
                continue
            }
            var updated = bridge
            if updated.leftWorkspaceId != newLeft || updated.rightWorkspaceId != newRight {
                BridgeDebugTrace.log("store.rebind id=\(bridge.id.uuidString.prefix(8)) L:\(bridge.leftWorkspaceId.uuidString.prefix(8))->\(newLeft.uuidString.prefix(8)) R:\(bridge.rightWorkspaceId.uuidString.prefix(8))->\(newRight.uuidString.prefix(8))")
                updated.leftWorkspaceId = newLeft
                updated.rightWorkspaceId = newRight
                changed = true
            }
            for (wsId, fallbackAgent) in Self.fallbackAgents(for: updated, metaStore: metaStore) {
                if metaStore.metadata(forWorkspaceId: wsId).terminalAgentId != fallbackAgent {
                    metaStore.setTerminalAgentId(fallbackAgent, for: wsId)
                }
            }
            rebuilt.append(updated)
        }
        if changed {
            bridges = rebuilt
            overviewVersion &+= 1
            save()
        }
    }

    private static func fallbackAgents(
        for bridge: WorkspaceBridge,
        metaStore: WorkspaceMetadataStore
    ) -> [(UUID, String)] {
        switch bridge.intent {
        case .relay:
            return [
                (bridge.leftWorkspaceId, TerminalAgent.claudeId),
                (bridge.rightWorkspaceId, TerminalAgent.claudeId)
            ]
        case .askAgent:
            let left = bridge.leftAgentId?.nilIfEmpty()
                ?? metaStore.metadata(forWorkspaceId: bridge.leftWorkspaceId).terminalAgentId
                ?? TerminalAgent.claudeId
            let right = bridge.rightAgentId?.nilIfEmpty() ?? "codex"
            return [
                (bridge.leftWorkspaceId, left),
                (bridge.rightWorkspaceId, right)
            ]
        }
    }

    private func update(
        id: UUID,
        updateOverview: Bool = false,
        _ mutate: (inout WorkspaceBridge) -> Void
    ) {
        guard let idx = bridges.firstIndex(where: { $0.id == id }) else { return }
        mutate(&bridges[idx])
        if updateOverview {
            overviewVersion &+= 1
        }
        save()
    }

    // MARK: - Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else {
            BridgeDebugTrace.log("store.load no-file")
            return
        }
        do {
            self.bridges = try decoder.decode([WorkspaceBridge].self, from: data)
            BridgeDebugTrace.log("store.load ok count=\(bridges.count) bytes=\(data.count)")
        } catch {
            BridgeDebugTrace.log("store.load decode-failed bytes=\(data.count) error=\(error)")
        }
    }

    private func save() {
        do {
            let data = try encoder.encode(bridges)
            let dir = fileURL.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: fileURL, options: [.atomic])
            BridgeDebugTrace.log("store.save ok count=\(bridges.count) bytes=\(data.count)")
        } catch {
            BridgeDebugTrace.log("store.save failed error=\(error)")
        }
    }

    private static func defaultFileURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        let dir = base.appendingPathComponent("TermLoop", isDirectory: true)
        let bundleId = Bundle.main.bundleIdentifier ?? "com.termloop.app"
        return dir.appendingPathComponent("bridges-\(bundleId).json", isDirectory: false)
    }
}

private extension String {
    func nilIfEmpty() -> String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
