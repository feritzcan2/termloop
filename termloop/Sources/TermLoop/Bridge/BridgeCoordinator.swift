// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

// termloop/Sources/TermLoop/Bridge/BridgeCoordinator.swift
import Bonsplit
import Combine
import Foundation

/// Owns bridge transport: kicks off the first message and forwards a side's
/// latest assistant message to the opposite side on demand. There is **no**
/// auto-forward — the coordinator never subscribes to turn-completion events
/// and never polls. The user drives every forward via the cable's arrow
/// buttons. @MainActor because it reads/writes TabManager and
/// WorkspaceBridgeStore (both @MainActor).
@MainActor
final class BridgeCoordinator {
    static let shared = BridgeCoordinator()

    enum FinalReplyDeliveryResult: Equatable {
        case delivered(messageId: UUID)
        case notFound
        case notAskAgent
        case notRunning
        case alreadyReplied
        case wrongCaller(expectedWorkspaceId: UUID, actualWorkspaceId: UUID)
        case sourceWorkspaceUnavailable
    }

    private struct HelperReadyWait {
        var activityCancellable: AnyCancellable?
        var pollWorkItem: DispatchWorkItem?
        var timeoutWorkItem: DispatchWorkItem?

        func cancel() {
            activityCancellable?.cancel()
            pollWorkItem?.cancel()
            timeoutWorkItem?.cancel()
        }
    }

    private final class WeakTabManagerBox {
        weak var value: TabManager?

        init(_ value: TabManager) {
            self.value = value
        }
    }

    /// Tolerance for filtering pre-bridge sessions in the shared cwd. The
    /// askAgent helper inherits the source workspace's cwd, so the cwd-fallback
    /// in the scanner could otherwise pick up the user's own pre-existing
    /// session as the helper's response. One second absorbs ordering skew
    /// between bridge.createdAt and the helper's first session-file write.
    private static let sessionFloorSkewBuffer: TimeInterval = 1

    private static func sessionFloor(for bridge: WorkspaceBridge, wsId: UUID) -> Date? {
        guard bridge.intent == .askAgent, wsId == bridge.rightWorkspaceId else { return nil }
        return bridge.createdAt.addingTimeInterval(-sessionFloorSkewBuffer)
    }

    /// For ask-agent helper workspaces, returns the persisted-agent-session
    /// only if it was stamped after the bridge was created. The launch path's
    /// autobind heuristic stamps a `persistedAgentSession` synchronously around
    /// workspace creation, often pointing at the wrong session for a fresh
    /// helper (a sibling workspace's recent codex/claude session in the shared
    /// cwd). Stale stamps are treated as nil so the scanner falls back to
    /// cwd-mode and picks up the helper's real session as soon as the agent
    /// process actually emits one.
    ///
    /// Source workspaces are exempt — their session was legitimately
    /// established before the bridge and is what we want to scan.
    private static func freshPersistedSession(
        forWorkspaceId wsId: UUID,
        bridge: WorkspaceBridge
    ) -> PersistedAgentSession? {
        guard let persisted = WorkspaceMetadataStore.shared
            .persistedAgentSession(for: wsId) else { return nil }
        let isAskHelper = bridge.intent == .askAgent
            && wsId == bridge.rightWorkspaceId
        guard isAskHelper else { return persisted }
        guard let updatedAt = persisted.updatedAt,
              updatedAt >= bridge.createdAt.addingTimeInterval(-sessionFloorSkewBuffer)
        else { return nil }
        return persisted
    }

    private let store: WorkspaceBridgeStore
    private let extractor: BridgeMessageExtractor
    /// Every window has its own TabManager. Keeping a registry avoids routing a
    /// second-window helper through whichever sidebar happened to appear first.
    private var tabManagers: [ObjectIdentifier: WeakTabManagerBox] = [:]
    /// Completion can be reported before SwiftUI has registered the first
    /// window (notably for explicit-open and snapshot-less launches). Remember
    /// the barrier so every later manager registration receives a final pass.
    private var startupRestoreDidFinish = false
    /// One subscription per running auto-mode bridge. Watches
    /// `TerminalAgentActivityStore.workspacePresentationDidChange` and forwards
    /// the source side's latest assistant message on a `running → settled`
    /// edge. Removed when the bridge stops, is dismissed, or flips to manual.
    private var autoForwardCancellables: [UUID: AnyCancellable] = [:]
    /// Pending first-turn sends for freshly launched Ask-To helpers. These
    /// wait for the helper agent to report ready (or show a prompt marker)
    /// instead of blindly pasting into the boot splash.
    private var helperReadyWaits: [UUID: HelperReadyWait] = [:]
    /// Last seen display state per workspace, used by the auto subscription
    /// to detect a `running → settled` edge instead of firing on every level
    /// signal. Workspace ids may be referenced by multiple bridges (relay /
    /// chained ask-to), so entries are only pruned when no remaining bridge
    /// owns the workspace.
    private var lastSeenDisplayState: [UUID: TerminalAgentDisplayState] = [:]

    init(
        store: WorkspaceBridgeStore = .shared,
        extractor: BridgeMessageExtractor = .shared
    ) {
        self.store = store
        self.extractor = extractor
    }

    /// Registers a window manager. This entry point is intentionally
    /// non-destructive: sidebar onAppear can run against the bootstrap tab
    /// before restored workspace metadata has been applied.
    func start(tabManager: TabManager) {
        register(tabManager)
        BridgeDebugTrace.log(
            "coord.start register tabs=\(tabManager.tabs.count) bridges=\(store.bridges.count)"
        )
        if startupRestoreDidFinish {
            reconcileAfterRestore(
                tabManagers: liveTabManagers(),
                dropUnresolved: true
            )
        }
    }

    /// Called after one window's positional metadata has been restored, before
    /// agent auto-restore. Complete endpoint pairs are rebound immediately;
    /// unresolved bridges are retained until the app-wide final pass.
    func workspaceMetadataDidRestore(tabManager: TabManager) {
        register(tabManager)
        reconcileAfterRestore(
            tabManagers: liveTabManagers(),
            dropUnresolved: false
        )
        // Ask-To helpers are process-scoped, not durable workspaces. Closing
        // them here, before TerminalAgentLifecycle.restoreWorkspaces, prevents
        // stale same-cwd session ids from resuming the wrong agent and avoids a
        // spawn-then-kill race at the app-wide final barrier.
        _ = cleanupRestoredAskToHelpers(tabManager: tabManager)
    }

    /// Called once all startup windows have restored. At this point unresolved
    /// bridge records are genuinely stale and hidden helpers without a live
    /// owner can be torn down safely.
    func startupSessionRestoreDidFinish() {
        startupRestoreDidFinish = true
        let managers = liveTabManagers()
        guard !managers.isEmpty else { return }
        reconcileAfterRestore(tabManagers: managers, dropUnresolved: true)
    }

    private func register(_ tabManager: TabManager) {
        tabManagers[ObjectIdentifier(tabManager)] = WeakTabManagerBox(tabManager)
        tabManagers = tabManagers.filter { $0.value.value != nil }
    }

    private func liveTabManagers() -> [TabManager] {
        tabManagers = tabManagers.filter { $0.value.value != nil }
        return tabManagers.values.compactMap(\.value)
    }

    private func tabManager(containing workspaceId: UUID) -> TabManager? {
        if let resolved = AppDelegate.shared?.tabManagerFor(tabId: workspaceId) {
            register(resolved)
            return resolved
        }
        return liveTabManagers().first {
            $0.tabs.contains(where: { $0.id == workspaceId })
        }
    }

    private func tabManager(for bridge: WorkspaceBridge) -> TabManager? {
        tabManager(containing: bridge.rightWorkspaceId)
            ?? tabManager(containing: bridge.leftWorkspaceId)
    }

    private func reconcileAfterRestore(
        tabManagers: [TabManager],
        dropUnresolved: Bool
    ) {
        let knownWorkspaceIds = Set(tabManagers.flatMap { $0.tabs.map(\.id) })
        BridgeDebugTrace.log(
            "coord.reconcile managers=\(tabManagers.count) tabs=\(knownWorkspaceIds.count) " +
            "bridges=\(store.bridges.count) final=\(dropUnresolved ? 1 : 0)"
        )
        let previousEndpoints = Dictionary(uniqueKeysWithValues: store.bridges.map {
            ($0.id, Set([$0.leftWorkspaceId, $0.rightWorkspaceId]))
        })
        _ = store.rebindAfterRestore(
            knownWorkspaceIds: knownWorkspaceIds,
            dropUnresolved: dropUnresolved
        )
        let currentBridgeIds = Set(store.bridges.map(\.id))
        for (bridgeId, oldEndpoints) in previousEndpoints {
            let newEndpoints = store.bridge(id: bridgeId).map {
                Set([$0.leftWorkspaceId, $0.rightWorkspaceId])
            }
            guard newEndpoints != oldEndpoints else { continue }
            autoForwardCancellables.removeValue(forKey: bridgeId)
            for workspaceId in oldEndpoints {
                lastSeenDisplayState.removeValue(forKey: workspaceId)
            }
        }
        let staleAutoForwardIds = autoForwardCancellables.keys.filter {
            !currentBridgeIds.contains($0)
        }
        for bridgeId in staleAutoForwardIds {
            autoForwardCancellables.removeValue(forKey: bridgeId)
        }
        for tabManager in tabManagers {
            _ = cleanupOrphanedHiddenHelpers(
                tabManager: tabManager,
                allowUnreboundMembership: !dropUnresolved
            )
            _ = repairHiddenHelperSelection(tabManager: tabManager)
        }
        for bridge in store.bridges where bridge.state == .running
            && bridge.effectiveForwardMode == .auto
            && knownWorkspaceIds.contains(bridge.leftWorkspaceId)
            && knownWorkspaceIds.contains(bridge.rightWorkspaceId) {
            attachAutoForwardSubscription(for: bridge)
        }
        pruneOrphanedDisplayStates()
        if dropUnresolved {
            _ = cleanupDetachedHiddenHelperMetadata(knownWorkspaceIds: knownWorkspaceIds)
        }
    }

    /// Restored Ask-To endpoints are deliberately transient. This is separate
    /// from generic orphan cleanup because a fully rebound, otherwise-valid
    /// helper must also be removed before any persisted agent resume occurs.
    @discardableResult
    private func cleanupRestoredAskToHelpers(tabManager: TabManager) -> Bool {
        let metaStore = WorkspaceMetadataStore.shared
        let helpers = tabManager.tabs.filter { workspace in
            guard let membership = metaStore
                .metadata(forWorkspaceId: workspace.id)
                .bridgeMembership,
                  membership.role == .right,
                  let bridge = store.bridge(id: membership.bridgeId) else {
                return false
            }
            return bridge.intent == .askAgent
        }
        guard !helpers.isEmpty else { return false }
        if helpers.count == tabManager.tabs.count {
            _ = tabManager.addWorkspace(
                select: true,
                eagerLoadTerminal: false,
                projectId: ProjectStore.shared.activeProjectId
            )
        }
        for helper in helpers {
            tabManager.closeWorkspace(helper)
            _ = metaStore.removeMetadataForId(helper.id)
        }
        return true
    }

    /// Ask-To helper metadata can outlive its reminted workspace id after a
    /// failed restore. Remove only `hideFromWorkspaceTree` records here;
    /// `isHidden` records belong to the user's durable Hidden-workspace list.
    @discardableResult
    private func cleanupDetachedHiddenHelperMetadata(
        knownWorkspaceIds: Set<UUID>
    ) -> Bool {
        let metaStore = WorkspaceMetadataStore.shared
        let staleIds: [UUID] = metaStore.byWorkspaceId.compactMap { entry in
            let (workspaceId, metadata) = entry
            guard metadata.hideFromWorkspaceTree == true,
                  !knownWorkspaceIds.contains(workspaceId) else { return nil }
            return workspaceId
        }
        for workspaceId in staleIds {
            _ = metaStore.removeMetadataForId(workspaceId)
        }
        return !staleIds.isEmpty
    }

    /// Closes hidden helper workspaces that are not referenced by any active
    /// bridge. Without a bridge cable they are unreachable from the sidebar
    /// (hideFromWorkspaceTree filters them out) and would otherwise pile up
    /// after a restart that lost the bridge link.
    @discardableResult
    private func cleanupOrphanedHiddenHelpers(
        tabManager: TabManager,
        allowUnreboundMembership: Bool = false
    ) -> Bool {
        let metaStore = WorkspaceMetadataStore.shared
        let orphans = tabManager.tabs.filter { ws in
            guard metaStore.isHiddenFromWorkspaceTree(workspaceId: ws.id) else { return false }
            let metadata = metaStore.metadata(forWorkspaceId: ws.id)
            guard let membership = metadata.bridgeMembership,
                  let bridge = store.bridge(id: membership.bridgeId),
                  bridge.intent == .askAgent,
                  bridge.state == .running else {
                return true
            }
            if allowUnreboundMembership { return false }
            return bridge.workspaceId(for: membership.role) != ws.id
        }
        guard !orphans.isEmpty else { return false }
        #if DEBUG
        dlog("bridge.cleanup orphans=\(orphans.count)")
        #endif
        if orphans.count == tabManager.tabs.count {
            _ = tabManager.addWorkspace(
                select: true,
                eagerLoadTerminal: false,
                projectId: ProjectStore.shared.activeProjectId
            )
        }
        for orphan in orphans {
            tabManager.closeWorkspace(orphan)
            _ = metaStore.removeMetadataForId(orphan.id)
        }
        return true
    }

    @discardableResult
    private func repairHiddenHelperSelection(tabManager: TabManager) -> Bool {
        let metaStore = WorkspaceMetadataStore.shared
        guard let selectedId = tabManager.selectedTabId,
              metaStore.isHiddenFromWorkspaceTree(workspaceId: selectedId) else {
            return false
        }

        let selectedWorkspace = tabManager.tabs.first(where: { $0.id == selectedId })
        let selectedMetadata = metaStore.metadata(forWorkspaceId: selectedId)
        let bridgeSourceId = selectedMetadata.bridgeMembership
            .flatMap { store.bridge(id: $0.bridgeId) }
            .map(\.leftWorkspaceId)
        let replacement = bridgeSourceId.flatMap { sourceId in
            tabManager.tabs.first {
                $0.id == sourceId && !metaStore.isHiddenFromWorkspaceTree(workspaceId: $0.id)
            }
        } ?? tabManager.tabs.first {
            $0.projectId == selectedWorkspace?.projectId
                && !metaStore.isHiddenFromWorkspaceTree(workspaceId: $0.id)
        } ?? tabManager.tabs.first {
            !metaStore.isHiddenFromWorkspaceTree(workspaceId: $0.id)
        }
        guard let replacement else { return false }
        tabManager.selectedTabId = replacement.id
        return true
    }

    // MARK: - Bridge lifecycle

    /// Fresh helpers need two gates: the terminal surface must exist and the
    /// agent TUI must have finished its boot splash. Prefer the activity hook,
    /// fall back to prompt-marker detection, and only time out as a last resort.
    private let freshHelperReadyTimeout: TimeInterval = 25
    private let freshHelperPromptPollInterval: TimeInterval = 0.35
    private let freshHelperReadySettleDelay: TimeInterval = 0.25

    /// Pastes rolePrompt + rightPrompt + kickoffMessage. No subscription, no
    /// baseline seeding — subsequent forwarding is manual via
    /// `forwardLatestMessage`.
    func kickoff(bridgeId: UUID) {
        guard let bridge = store.bridge(id: bridgeId) else {
            BridgeDebugTrace.log("coord.kickoff guard-fail id=\(bridgeId.uuidString.prefix(8))")
            return
        }
        BridgeDebugTrace.log("coord.kickoff id=\(bridgeId.uuidString.prefix(8)) intent=\(bridge.intent) first=\(bridge.firstSpeaker)")
        #if DEBUG
        dlog("bridge.kickoff id=\(bridgeId.uuidString.prefix(8)) intent=\(bridge.intent) first=\(bridge.firstSpeaker) kickoffLen=\(bridge.kickoffMessage.count)")
        #endif
        let send: (String, UUID) -> Void = { (text: String, wsId: UUID) in
            guard let manager = self.tabManager(containing: wsId) else { return }
            _ = self.sendBridgeInput(text, toWorkspaceId: wsId, tabManager: manager, bridgeId: bridgeId)
        }
        if let role = bridge.rolePrompt?.trimmingCharacters(in: .whitespacesAndNewlines),
           !role.isEmpty {
            send(role, bridge.leftWorkspaceId)
            send(role, bridge.rightWorkspaceId)
        }
        if let rightPrompt = bridge.rightPrompt?.trimmingCharacters(in: .whitespacesAndNewlines),
           !rightPrompt.isEmpty {
            send(rightPrompt, bridge.rightWorkspaceId)
        }
        guard let targetId = bridge.workspaceId(for: bridge.firstSpeaker) else { return }
        if bridge.kickoffDeliveredAtLaunch == true {
            BridgeDebugTrace.log("coord.kickoff skip-launch-delivered id=\(bridgeId.uuidString.prefix(8))")
            if bridge.effectiveForwardMode == .auto {
                attachAutoForwardSubscription(for: bridge)
            }
            return
        }
        // Sheet path (firstSpeaker .left) sends to the warm source agent —
        // immediate is fine. MCP path (firstSpeaker .right) sends straight
        // into the freshly-spawned helper; wait for its CLI boot splash to
        // clear before pasting.
        let kickoffIsToFreshHelper = bridge.intent == .askAgent
            && bridge.firstSpeaker == .right
        if kickoffIsToFreshHelper {
            guard let helperTabManager = tabManager(containing: targetId) else {
                BridgeDebugTrace.log("coord.kickoff helper-manager-missing id=\(bridgeId.uuidString.prefix(8))")
                return
            }
            sendFreshHelperKickoffWhenReady(
                bridge: bridge,
                targetWorkspaceId: targetId,
                text: bridge.kickoffMessage,
                tabManager: helperTabManager
            )
        } else {
            send(bridge.kickoffMessage, targetId)
        }
        if bridge.effectiveForwardMode == .auto {
            attachAutoForwardSubscription(for: bridge)
        }
    }

    func stop(bridgeId: UUID) {
        guard let bridge = store.bridge(id: bridgeId) else { return }
        // Ask-To helpers are transient processes. A stopped Ask-To bridge cannot
        // accept follow-ups, so keeping its hidden endpoint alive only creates
        // an unreachable session. Treat Stop as full Ask-To teardown.
        if bridge.intent == .askAgent {
            dismiss(bridgeId: bridgeId)
            return
        }
        if bridge.state == .running {
            store.stop(id: bridgeId, reason: .manual)
        }
        cancelPendingHelperReadySend(bridgeId: bridgeId)
        detachAutoForwardSubscription(bridgeId: bridgeId)
    }

    func dismiss(bridgeId: UUID) {
        guard let bridge = store.bridge(id: bridgeId) else { return }
        let affectedManager = tabManager(for: bridge)
        cancelPendingHelperReadySend(bridgeId: bridgeId)
        autoForwardCancellables.removeValue(forKey: bridgeId)
        if affectedManager?.selectedTabId == bridge.rightWorkspaceId,
           affectedManager?.tabs.contains(where: { $0.id == bridge.leftWorkspaceId }) == true {
            affectedManager?.selectedTabId = bridge.leftWorkspaceId
        }
        // Remove ownership before closing the helper so the synchronous
        // workspaceDidClose hook cannot re-enter teardown through this bridge.
        store.dismiss(id: bridgeId)
        cleanupHelperWorkspaceIfNeeded(bridge: bridge, force: true)
        if let affectedManager {
            _ = cleanupOrphanedHiddenHelpers(tabManager: affectedManager)
            _ = repairHiddenHelperSelection(tabManager: affectedManager)
        }
        pruneOrphanedDisplayStates()
        DispatchQueue.main.async {
            TermLoopHooks.saveCriticalAgentRestoreStateSync()
        }
    }

    /// User toggled the cable's mode menu. Updates the persisted bridge and
    /// reconciles the auto-forward subscription (attach if going to .auto on
    /// a running bridge, detach otherwise).
    func setForwardMode(bridgeId: UUID, mode: BridgeForwardMode) {
        store.setForwardMode(id: bridgeId, mode: mode)
        guard let bridge = store.bridge(id: bridgeId) else { return }
        if mode == .auto, bridge.state == .running {
            attachAutoForwardSubscription(for: bridge)
        } else {
            detachAutoForwardSubscription(bridgeId: bridgeId)
        }
    }

    /// Sends a newly appended Ask-To request to the existing helper side of a
    /// long-lived askAgent bridge. Used by MCP follow-ups where the bridge
    /// stays alive but each request id remains single-use.
    func sendAskToRequest(bridgeId: UUID, requestId: UUID) {
        guard let bridge = store.bridge(id: bridgeId),
              bridge.intent == .askAgent,
              bridge.state == .running,
              let request = bridge.askToRequest(id: requestId),
              let helperTabManager = tabManager(containing: bridge.rightWorkspaceId)
        else {
            BridgeDebugTrace.log("coord.askTo.send guard-fail bridge=\(bridgeId.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8))")
            return
        }
        sendFreshHelperKickoffWhenReady(
            bridge: bridge,
            targetWorkspaceId: bridge.rightWorkspaceId,
            text: request.kickoffMessage,
            tabManager: helperTabManager
        )
    }

    // MARK: - Auto forward

    private func attachAutoForwardSubscription(for bridge: WorkspaceBridge) {
        guard autoForwardCancellables[bridge.id] == nil else { return }
        let bridgeId = bridge.id
        let endpointIds: Set<UUID> = [bridge.leftWorkspaceId, bridge.rightWorkspaceId]
        let activityStore = TerminalAgentActivityStore.shared
        autoForwardCancellables[bridgeId] = activityStore.workspacePresentationDidChange
            .filter { endpointIds.contains($0) }
            .sink { [weak self] wsId in
                self?.handleAutoForwardSignal(workspaceId: wsId, bridgeId: bridgeId)
            }
        for wsId in endpointIds {
            lastSeenDisplayState[wsId] = activityStore
                .presentation(forWorkspaceId: wsId)?.displayState ?? .idle
        }
    }

    private func detachAutoForwardSubscription(bridgeId: UUID) {
        autoForwardCancellables.removeValue(forKey: bridgeId)
        pruneOrphanedDisplayStates()
    }

    private func pruneOrphanedDisplayStates() {
        let stillReferenced: Set<UUID> = store.bridges.reduce(into: []) { acc, b in
            acc.insert(b.leftWorkspaceId)
            acc.insert(b.rightWorkspaceId)
        }
        lastSeenDisplayState = lastSeenDisplayState.filter { stillReferenced.contains($0.key) }
    }

    private func handleAutoForwardSignal(workspaceId: UUID, bridgeId: UUID) {
        guard let bridge = store.bridge(id: bridgeId),
              bridge.state == .running,
              bridge.effectiveForwardMode == .auto
        else {
            detachAutoForwardSubscription(bridgeId: bridgeId)
            return
        }
        let isLeft = workspaceId == bridge.leftWorkspaceId
        let isRight = workspaceId == bridge.rightWorkspaceId
        guard isLeft || isRight else { return }

        let current = TerminalAgentActivityStore.shared
            .presentation(forWorkspaceId: workspaceId)?.displayState ?? .idle
        let previous = lastSeenDisplayState[workspaceId] ?? .idle
        lastSeenDisplayState[workspaceId] = current

        guard previous == .running, current.isSettled else { return }

        let sender: BridgeSender = isLeft ? .left : .right
        #if DEBUG
        dlog("bridge.forward.auto trigger sender=\(sender) ws=\(workspaceId.uuidString.prefix(8)) bid=\(bridgeId.uuidString.prefix(8)) edge=\(previous)->\(current)")
        #endif
        // Auto is a one-shot arm. Flip to .manual first — that path detaches
        // the subscription synchronously, so the cancellable owning this
        // very closure is released before forwardLatestMessage runs and any
        // downstream presentation flush from the forward can't re-enter
        // this sink.
        setForwardMode(bridgeId: bridgeId, mode: .manual)
        forwardLatestMessage(from: sender, in: bridge)
    }

    /// Full teardown entry point for the bridge-row dismiss × button. Dismisses
    /// the bridge (helper close) and then routes a normal sidebar-popover close
    /// on the right workspace so the running-agent guard in
    /// `TermLoopHooks.workspaceWillClose` still fires. askAgent hidden helpers
    /// are already closed by `dismiss`; the second lookup is a no-op for those.
    func dismissAndCloseRight(bridgeId: UUID) {
        guard let bridge = store.bridge(id: bridgeId) else { return }
        let rightWsId = bridge.rightWorkspaceId
        let rightTabManager = tabManager(containing: rightWsId)
        dismiss(bridgeId: bridgeId)
        if let rightTabManager,
           let workspace = rightTabManager.tabs.first(where: { $0.id == rightWsId }) {
            rightTabManager.closeWorkspaceFromSidebarPopover(workspace)
        }
    }

    func workspaceDidClose(workspaceId: UUID) {
        guard let bridge = store.bridge(forWorkspaceId: workspaceId) else { return }
        if bridge.intent == .askAgent {
            if workspaceId == bridge.rightWorkspaceId,
               case .stopped(.sendTimeout) = bridge.state {
                return
            }
            dismiss(bridgeId: bridge.id)
            return
        }
        if case .stopped = bridge.state { return }
        store.stop(id: bridge.id, reason: .workspaceClosed)
        stop(bridgeId: bridge.id)
    }

    // MARK: - Manual forward

    /// Idempotent against double-clicks: dedupes against the last forwarded
    /// message and no-ops when the source has nothing new.
    func forwardLatestMessage(from sender: BridgeSender, in bridge: WorkspaceBridge) {
        guard let sourceWsId = bridge.workspaceId(for: sender),
              let target = bridge.opposite(of: sender),
              let targetWsId = bridge.workspaceId(for: target),
              let current = store.bridge(id: bridge.id),
              current.state == .running,
              let sourceTabManager = tabManager(containing: sourceWsId),
              let targetTabManager = tabManager(containing: targetWsId)
        else { return }

        let agent = WorkspaceMetadataStore.shared
            .metadata(forWorkspaceId: sourceWsId).terminalAgentId
            ?? TerminalAgent.claudeId
        let session = WorkspaceMetadataStore.shared
            .claudeSession(workspaceId: sourceWsId.uuidString)
        let persisted = Self.freshPersistedSession(forWorkspaceId: sourceWsId, bridge: current)
        let cwd = sourceTabManager.tabs.first(where: { $0.id == sourceWsId })?.currentDirectory ?? ""

        guard let snapshot = extractor.assistantMessageSnapshot(
            agentId: agent,
            sessionId: session?.sessionId ?? persisted?.sessionId,
            cwd: session?.cwd ?? persisted?.cwd ?? cwd,
            newerThan: Self.sessionFloor(for: current, wsId: sourceWsId)
        ), !snapshot.text.isEmpty else {
            #if DEBUG
            dlog("bridge.forward.manual empty sender=\(sender) ws=\(sourceWsId.uuidString.prefix(8))")
            #endif
            return
        }

        if let last = current.messages.last,
           last.sender == sender, last.text == snapshot.text {
            #if DEBUG
            dlog("bridge.forward.manual dup sender=\(sender) len=\(snapshot.text.count)")
            #endif
            return
        }

        store.appendMessage(bridgeId: current.id, sender: sender, text: snapshot.text)
        sendBridgeInput(
            snapshot.text,
            toWorkspaceId: targetWsId,
            tabManager: targetTabManager,
            bridgeId: current.id
        )
    }

    /// Delivers the helper's single final Ask-To reply back to the source
    /// workspace and closes the request id. The server validates that the
    /// caller is the helper side so arbitrary workspaces cannot answer a
    /// request by guessing its UUID.
    func deliverFinalReply(
        requestId: UUID,
        callerWorkspaceId: UUID,
        askToRequestId: UUID? = nil,
        askToReplyToken: String? = nil,
        callerAgentId: String? = nil,
        text: String
    ) -> FinalReplyDeliveryResult {
        guard let bridge = store.bridge(containingAskToRequestId: requestId) else {
            return .notFound
        }
        guard bridge.intent == .askAgent else {
            return .notAskAgent
        }
        let normalizedCallerAgentId = callerAgentId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedBridgeAgentId = bridge.rightAgentId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAskToReplyToken = askToReplyToken?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hasMatchingLaunchCredential = bridge.acceptsAskToLaunchCredential(
            requestId: askToRequestId,
            replyToken: askToReplyToken,
            callerAgentId: callerAgentId
        )
        let callerIsHelper = callerWorkspaceId == bridge.rightWorkspaceId
            || hasMatchingLaunchCredential
        guard callerIsHelper else {
            BridgeDebugTrace.log(
                "reply.reject wrong-caller request=\(requestId.uuidString.prefix(8)) " +
                "expected=\(bridge.rightWorkspaceId.uuidString.prefix(8)) actual=\(callerWorkspaceId.uuidString.prefix(8)) " +
                "askStamp=\(askToRequestId?.uuidString.prefix(8) ?? "nil") " +
                "hasToken=\(normalizedAskToReplyToken?.isEmpty == false ? 1 : 0) " +
                "callerAgent=\(normalizedCallerAgentId ?? "nil") bridgeAgent=\(normalizedBridgeAgentId ?? "nil")"
            )
            return .wrongCaller(
                expectedWorkspaceId: bridge.rightWorkspaceId,
                actualWorkspaceId: callerWorkspaceId
            )
        }
        if callerWorkspaceId != bridge.rightWorkspaceId {
            BridgeDebugTrace.log(
                "reply.accept launch-stamp request=\(requestId.uuidString.prefix(8)) " +
                "expected=\(bridge.rightWorkspaceId.uuidString.prefix(8)) actual=\(callerWorkspaceId.uuidString.prefix(8))"
            )
        }
        guard let sourceTabManager = tabManager(containing: bridge.leftWorkspaceId),
              sourceTabManager.tabs.contains(where: { $0.id == bridge.leftWorkspaceId })
        else {
            return .sourceWorkspaceUnavailable
        }

        let recordResult = store.recordFinalReply(requestId: requestId, text: text)
        switch recordResult {
        case .recorded(let bridgeId, let messageId):
            detachAutoForwardSubscription(bridgeId: bridgeId)
            _ = sendBridgeInput(
                Self.finalReplyInput(text),
                toWorkspaceId: bridge.leftWorkspaceId,
                tabManager: sourceTabManager,
                bridgeId: bridgeId
            )
            BridgeDebugTrace.log(
                "reply.delivered bridge=\(bridgeId.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) " +
                "message=\(messageId.uuidString.prefix(8)) source=\(bridge.leftWorkspaceId.uuidString.prefix(8)) " +
                "helper=\(bridge.rightWorkspaceId.uuidString.prefix(8)) chars=\(text.count)"
            )
            return .delivered(messageId: messageId)
        case .notFound:
            return .notFound
        case .notAskAgent:
            return .notAskAgent
        case .notRunning:
            return .notRunning
        case .alreadyReplied:
            return .alreadyReplied
        }
    }

    private static func finalReplyInput(_ text: String) -> String {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return "" }
        return "TermLoop Ask-To final reply:\n\n\(body)"
    }

    // MARK: - Fresh helper readiness

    private func sendFreshHelperKickoffWhenReady(
        bridge: WorkspaceBridge,
        targetWorkspaceId: UUID,
        text: String,
        tabManager: TabManager
    ) {
        let bridgeId = bridge.id
        let agentId = bridge.rightAgentId
        cancelPendingHelperReadySend(bridgeId: bridgeId)
        helperReadyWaits[bridgeId] = HelperReadyWait()
        BridgeDebugTrace.log(
            "bridge.input.wait start id=\(bridgeId.uuidString.prefix(8)) ws=\(targetWorkspaceId.uuidString.prefix(8)) agent=\(agentId ?? "nil")"
        )

        let finish: (String) -> Void = { [weak self, weak tabManager] reason in
            guard let self,
                  let tabManager,
                  self.helperReadyWaits[bridgeId] != nil
            else { return }
            self.cancelPendingHelperReadySend(bridgeId: bridgeId)
            BridgeDebugTrace.log(
                "bridge.input.wait ready id=\(bridgeId.uuidString.prefix(8)) reason=\(reason)"
            )
            DispatchQueue.main.asyncAfter(deadline: .now() + self.freshHelperReadySettleDelay) { [weak self, weak tabManager] in
                guard let self,
                      let tabManager,
                      self.store.bridge(id: bridgeId)?.state == .running
                else { return }
                _ = self.sendBridgeInput(
                    text,
                    toWorkspaceId: targetWorkspaceId,
                    tabManager: tabManager,
                    bridgeId: bridgeId
                )
            }
        }

        if helperAgentLooksReadyForInput(
            workspaceId: targetWorkspaceId,
            expectedAgentId: agentId,
            tabManager: tabManager
        ) {
            finish("initial")
            return
        }

        setHelperReadyActivityCancellable(
            TerminalAgentActivityStore.shared
            .workspacePresentationDidChange
            .filter { $0 == targetWorkspaceId }
            .sink { [weak self, weak tabManager] _ in
                guard let self,
                      let tabManager,
                      self.helperAgentLooksReadyForInput(
                          workspaceId: targetWorkspaceId,
                          expectedAgentId: agentId,
                          tabManager: tabManager
                      )
                else { return }
                finish("activity")
            },
            bridgeId: bridgeId
        )

        scheduleHelperPromptPoll(
            bridgeId: bridgeId,
            workspaceId: targetWorkspaceId,
            agentId: agentId,
            tabManager: tabManager,
            onReady: finish
        )

        let timeoutWorkItem = DispatchWorkItem { [weak self] in
            guard let self,
                  self.helperReadyWaits[bridgeId] != nil
            else { return }
            BridgeDebugTrace.log(
                "bridge.input.wait timeout id=\(bridgeId.uuidString.prefix(8)) seconds=\(self.freshHelperReadyTimeout)"
            )
            finish("timeout")
        }
        setHelperReadyTimeoutWorkItem(timeoutWorkItem, bridgeId: bridgeId)
        DispatchQueue.main.asyncAfter(
            deadline: .now() + freshHelperReadyTimeout,
            execute: timeoutWorkItem
        )
    }

    private func scheduleHelperPromptPoll(
        bridgeId: UUID,
        workspaceId: UUID,
        agentId: String?,
        tabManager: TabManager,
        onReady: @escaping (String) -> Void
    ) {
        let workItem = DispatchWorkItem { [weak self, weak tabManager] in
            guard let self,
                  let tabManager,
                  self.helperReadyWaits[bridgeId] != nil
            else { return }
            if self.helperPromptLooksReadyForInput(
                workspaceId: workspaceId,
                agentId: agentId,
                tabManager: tabManager
            ) {
                onReady("prompt")
                return
            }
            self.scheduleHelperPromptPoll(
                bridgeId: bridgeId,
                workspaceId: workspaceId,
                agentId: agentId,
                tabManager: tabManager,
                onReady: onReady
            )
        }
        setHelperReadyPollWorkItem(workItem, bridgeId: bridgeId)
        DispatchQueue.main.asyncAfter(
            deadline: .now() + freshHelperPromptPollInterval,
            execute: workItem
        )
    }

    private func cancelPendingHelperReadySend(bridgeId: UUID) {
        helperReadyWaits.removeValue(forKey: bridgeId)?.cancel()
    }

    private func setHelperReadyActivityCancellable(
        _ cancellable: AnyCancellable,
        bridgeId: UUID
    ) {
        updateHelperReadyWait(bridgeId: bridgeId) {
            $0.activityCancellable = cancellable
        }
    }

    private func setHelperReadyPollWorkItem(
        _ workItem: DispatchWorkItem,
        bridgeId: UUID
    ) {
        updateHelperReadyWait(bridgeId: bridgeId) {
            $0.pollWorkItem?.cancel()
            $0.pollWorkItem = workItem
        }
    }

    private func setHelperReadyTimeoutWorkItem(
        _ workItem: DispatchWorkItem,
        bridgeId: UUID
    ) {
        updateHelperReadyWait(bridgeId: bridgeId) {
            $0.timeoutWorkItem?.cancel()
            $0.timeoutWorkItem = workItem
        }
    }

    private func updateHelperReadyWait(
        bridgeId: UUID,
        _ update: (inout HelperReadyWait) -> Void
    ) {
        guard var wait = helperReadyWaits[bridgeId] else { return }
        update(&wait)
        helperReadyWaits[bridgeId] = wait
    }

    private func helperAgentLooksReadyForInput(
        workspaceId: UUID,
        expectedAgentId: String?,
        tabManager: TabManager
    ) -> Bool {
        if helperActivityLooksReadyForInput(
            workspaceId: workspaceId,
            expectedAgentId: expectedAgentId
        ) {
            return true
        }
        return helperPromptLooksReadyForInput(
            workspaceId: workspaceId,
            agentId: expectedAgentId,
            tabManager: tabManager
        )
    }

    private func helperActivityLooksReadyForInput(
        workspaceId: UUID,
        expectedAgentId: String?
    ) -> Bool {
        guard let presentation = TerminalAgentActivityStore.shared
            .presentation(forWorkspaceId: workspaceId)
        else { return false }
        if let expectedAgentId,
           let actualAgentId = presentation.agentId,
           actualAgentId != expectedAgentId {
            return false
        }
        switch presentation.displayState {
        case .ready, .needsInput:
            return true
        case .idle, .running, .completed, .error:
            return false
        }
    }

    private func helperPromptLooksReadyForInput(
        workspaceId: UUID,
        agentId: String?,
        tabManager: TabManager
    ) -> Bool {
        guard let workspace = tabManager.tabs.first(where: { $0.id == workspaceId }),
              let panel = sendableTerminalPanel(in: workspace),
              let text = visibleTerminalText(in: panel)
        else { return false }
        return terminalTextLooksReadyForInput(text, agentId: agentId)
    }

    private func visibleTerminalText(in panel: TerminalPanel) -> String? {
        guard let surface = panel.surface.surface else { return nil }
        let topLeft = ghostty_point_s(
            tag: GHOSTTY_POINT_VIEWPORT,
            coord: GHOSTTY_POINT_COORD_TOP_LEFT,
            x: 0,
            y: 0
        )
        let bottomRight = ghostty_point_s(
            tag: GHOSTTY_POINT_VIEWPORT,
            coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
            x: 0,
            y: 0
        )
        let selection = ghostty_selection_s(
            top_left: topLeft,
            bottom_right: bottomRight,
            rectangle: false
        )
        var text = ghostty_text_s()
        guard ghostty_surface_read_text(surface, selection, &text) else {
            return nil
        }
        defer {
            ghostty_surface_free_text(surface, &text)
        }
        guard let ptr = text.text, text.text_len > 0 else {
            return ""
        }
        return String(decoding: Data(bytes: ptr, count: Int(text.text_len)), as: UTF8.self)
    }

    private func terminalTextLooksReadyForInput(_ text: String, agentId: String?) -> Bool {
        let tailLines = text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .suffix(10)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !tailLines.isEmpty else { return false }

        let normalizedAgent = agentId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return tailLines.contains { line in
            switch normalizedAgent {
            case .some(let value) where value == TerminalAgent.claudeId:
                return line.hasPrefix("❯")
            case .some("codex"):
                return line.hasPrefix("›")
            case .some("gemini"):
                return line == ">" || line.hasPrefix("> ")
            default:
                return line.hasPrefix("❯")
                    || line.hasPrefix("›")
                    || line == ">"
                    || line.hasPrefix("> ")
            }
        }
    }

    // MARK: - Send

    /// Window each surface-readiness wait gets before retrying. Helper CLIs
    /// (Codex / Claude TUI) can take well over 3s to finish their boot splash
    /// on slower machines, so the old 3s silent drop was the primary cause of
    /// ask-to flakiness. Two attempts × 12s = ~24s total budget, after which
    /// the bridge is stopped loudly with `.sendTimeout` so the user sees why.
    private let sendReadyTimeout: TimeInterval = 12.0
    private let sendMaxAttempts: Int = 2
    /// Settle delay applied only after we had to wait for
    /// `terminalSurfaceDidBecomeReady` (a fresh helper). PTY-ready reports
    /// surface availability, not agent-TUI readiness — pasting into the boot
    /// splash gets dropped. Warm surfaces (source workspace) skip this.
    private let sendSettleAfterReady: TimeInterval = 0.8
    private let submitInitialEnterDelay: TimeInterval = 0.2
    private let submitRetryEnterDelay: TimeInterval = 1.0

    private func shortId(_ id: UUID) -> String {
        String(id.uuidString.prefix(8))
    }

    private func shortId(_ id: UUID?) -> String {
        guard let id else { return "nil" }
        return shortId(id)
    }

    @discardableResult
    private func sendBridgeInput(
        _ text: String,
        toWorkspaceId wsId: UUID,
        tabManager: TabManager,
        bridgeId: UUID? = nil
    ) -> Bool {
        #if DEBUG
        dlog("bridge.send start ws=\(shortId(wsId)) bid=\(shortId(bridgeId)) chars=\(text.count)")
        #endif
        BridgeDebugTrace.log(
            "bridge.send start ws=\(shortId(wsId)) bid=\(shortId(bridgeId)) chars=\(text.count)"
        )
        guard let ws = tabManager.tabs.first(where: { $0.id == wsId }),
              let panel = sendableTerminalPanel(in: ws) else {
            #if DEBUG
            dlog("bridge.send no-panel ws=\(shortId(wsId))")
            #endif
            BridgeDebugTrace.log(
                "bridge.send no-panel ws=\(shortId(wsId)) bid=\(shortId(bridgeId))"
            )
            return false
        }
        sendInputWhenReady(text, to: panel, workspaceId: wsId, bridgeId: bridgeId, attempt: 0)
        return true
    }

    private func sendableTerminalPanel(in workspace: Workspace) -> TerminalPanel? {
        func selectedTerminalPanel(in paneId: PaneID) -> TerminalPanel? {
            guard let selectedTab = workspace.bonsplitController.selectedTab(inPane: paneId),
                  let panelId = workspace.panelIdFromSurfaceId(selectedTab.id),
                  let terminalPanel = workspace.panels[panelId] as? TerminalPanel else {
                return nil
            }
            return terminalPanel
        }

        func isSelectedTerminalPanel(_ terminalPanel: TerminalPanel) -> Bool {
            guard let surfaceId = workspace.surfaceIdFromPanelId(terminalPanel.id) else {
                return false
            }
            return workspace.bonsplitController.allPaneIds.contains { paneId in
                workspace.bonsplitController.selectedTab(inPane: paneId)?.id == surfaceId
            }
        }

        if let focusedPane = workspace.bonsplitController.focusedPaneId,
           let terminalPanel = selectedTerminalPanel(in: focusedPane) {
            return terminalPanel
        }

        if let rememberedTerminal = workspace.lastRememberedTerminalPanelForConfigInheritance(),
           isSelectedTerminalPanel(rememberedTerminal) {
            return rememberedTerminal
        }

        for paneId in workspace.bonsplitController.allPaneIds {
            if let terminalPanel = selectedTerminalPanel(in: paneId) {
                return terminalPanel
            }
        }

        return nil
    }

    private func sendInputWhenReady(
        _ text: String,
        to panel: TerminalPanel,
        workspaceId: UUID,
        bridgeId: UUID?,
        attempt: Int
    ) {
        if panel.surface.surface != nil {
            BridgeDebugTrace.log(
                "bridge.send surface-ready panel=\(shortId(panel.id)) ws=\(shortId(workspaceId)) bid=\(shortId(bridgeId)) attempt=\(attempt)"
            )
            submitToAgentTUI(text, on: panel, workspaceId: workspaceId, bridgeId: bridgeId)
            return
        }

        BridgeDebugTrace.log(
            "bridge.send surface-wait panel=\(shortId(panel.id)) ws=\(shortId(workspaceId)) bid=\(shortId(bridgeId)) attempt=\(attempt)"
        )
        panel.surface.requestBackgroundSurfaceStartIfNeeded()

        var resolved = false
        var observer: NSObjectProtocol?
        let settleAfterReady = sendSettleAfterReady

        observer = NotificationCenter.default.addObserver(
            forName: .terminalSurfaceDidBecomeReady,
            object: panel.surface,
            queue: .main
        ) { [weak panel] _ in
            guard !resolved, let panel else { return }
            resolved = true
            if let observer {
                NotificationCenter.default.removeObserver(observer)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + settleAfterReady) { [weak panel] in
                guard let panel else { return }
                BridgeDebugTrace.log(
                    "bridge.send surface-ready-after-wait panel=\(self.shortId(panel.id)) ws=\(self.shortId(workspaceId)) bid=\(self.shortId(bridgeId)) attempt=\(attempt)"
                )
                self.submitToAgentTUI(text, on: panel, workspaceId: workspaceId, bridgeId: bridgeId)
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + sendReadyTimeout) { [weak self, weak panel] in
            guard !resolved else { return }
            resolved = true
            if let observer {
                NotificationCenter.default.removeObserver(observer)
            }
            guard let self, let panel else { return }
            let nextAttempt = attempt + 1
            if nextAttempt < self.sendMaxAttempts {
                #if DEBUG
                dlog("bridge.send retry attempt=\(nextAttempt)/\(self.sendMaxAttempts) panel=\(self.shortId(panel.id))")
                #endif
                BridgeDebugTrace.log(
                    "bridge.send retry panel=\(self.shortId(panel.id)) ws=\(self.shortId(workspaceId)) bid=\(self.shortId(bridgeId)) attempt=\(nextAttempt)"
                )
                self.sendInputWhenReady(
                    text,
                    to: panel,
                    workspaceId: workspaceId,
                    bridgeId: bridgeId,
                    attempt: nextAttempt
                )
                return
            }
            #if DEBUG
            dlog("bridge.send giveup panel=\(self.shortId(panel.id)) chars=\(text.count)")
            #endif
            BridgeDebugTrace.log(
                "bridge.send giveup panel=\(self.shortId(panel.id)) ws=\(self.shortId(workspaceId)) bid=\(self.shortId(bridgeId)) chars=\(text.count)"
            )
            if let bridgeId, self.store.bridge(id: bridgeId)?.state == .running {
                self.handleSendTimeout(bridgeId: bridgeId)
            }
        }
    }

    /// Preserve the stopped record long enough for the cable to explain why
    /// delivery failed, while still tearing down the hidden helper process.
    private func handleSendTimeout(bridgeId: UUID) {
        guard store.bridge(id: bridgeId) != nil else { return }
        store.stop(id: bridgeId, reason: .sendTimeout)
        cancelPendingHelperReadySend(bridgeId: bridgeId)
        detachAutoForwardSubscription(bridgeId: bridgeId)
        guard let stoppedBridge = store.bridge(id: bridgeId) else { return }
        cleanupHelperWorkspaceIfNeeded(bridge: stoppedBridge, force: true)
        pruneOrphanedDisplayStates()
        DispatchQueue.main.async {
            TermLoopHooks.saveCriticalAgentRestoreStateSync()
        }
    }

    /// Agent TUIs can interpret Enter as "newline" when the input already
    /// contains newlines (multi-line mode). To submit a multi-line message, we
    /// paste the body via `sendText` (raw bytes, no key interpretation), then
    /// fire Return via `sendInput("\r")` for the actual submit.
    /// Trailing whitespace is trimmed so the final Return lands on a non-blank
    /// line and Claude accepts it.
    private func submitToAgentTUI(
        _ raw: String,
        on panel: TerminalPanel,
        workspaceId: UUID,
        bridgeId: UUID?
    ) {
        let body = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        BridgeDebugTrace.log(
            "bridge.submit.paste panel=\(shortId(panel.id)) ws=\(shortId(workspaceId)) bid=\(shortId(bridgeId)) chars=\(body.count)"
        )
        panel.sendText(body)
        DispatchQueue.main.asyncAfter(deadline: .now() + submitInitialEnterDelay) { [weak self, weak panel] in
            guard let self, let panel else { return }
            self.sendSubmitEnter(on: panel, bridgeId: bridgeId, reason: "initial")
            self.scheduleSubmitRetryIfStillNeedsInput(
                on: panel,
                workspaceId: workspaceId,
                bridgeId: bridgeId
            )
        }
    }

    private func scheduleSubmitRetryIfStillNeedsInput(
        on panel: TerminalPanel,
        workspaceId: UUID,
        bridgeId: UUID?
    ) {
        DispatchQueue.main.asyncAfter(deadline: .now() + submitRetryEnterDelay) { [weak self, weak panel] in
            guard let self, let panel else { return }
            let state = TerminalAgentActivityStore.shared
                .presentation(forWorkspaceId: workspaceId)?
                .displayState
            guard state == .needsInput else {
                BridgeDebugTrace.log(
                    "bridge.submit.no-retry panel=\(self.shortId(panel.id)) ws=\(self.shortId(workspaceId)) bid=\(self.shortId(bridgeId)) state=\(state?.rawValue ?? "nil")"
                )
                return
            }
            self.sendSubmitEnter(on: panel, bridgeId: bridgeId, reason: "needs-input-retry")
        }
    }

    private func sendSubmitEnter(
        on panel: TerminalPanel,
        bridgeId: UUID?,
        reason: String
    ) {
        BridgeDebugTrace.log(
            "bridge.submit.enter panel=\(shortId(panel.id)) bid=\(shortId(bridgeId)) reason=\(reason)"
        )
        panel.sendInput("\r")
    }

    // MARK: - Helper cleanup

    private func cleanupHelperWorkspaceIfNeeded(
        bridge: WorkspaceBridge,
        force: Bool
    ) {
        guard bridge.intent == .askAgent,
              let helperTabManager = tabManager(containing: bridge.rightWorkspaceId),
              let helper = helperTabManager.tabs.first(where: { $0.id == bridge.rightWorkspaceId })
        else { return }

        let shouldClose = force || {
            if case .stopped = bridge.state { return true }
            return false
        }()
        guard shouldClose else { return }

        // If the user explicitly opened the helper, move selection back to its
        // source before teardown. This prevents closeWorkspace's index fallback
        // from landing on an unrelated project.
        if helperTabManager.selectedTabId == helper.id,
           helperTabManager.tabs.contains(where: { $0.id == bridge.leftWorkspaceId }) {
            helperTabManager.selectedTabId = bridge.leftWorkspaceId
        }
        if helperTabManager.tabs.count == 1 {
            _ = helperTabManager.addWorkspace(
                title: nil,
                workingDirectory: nil,
                select: true,
                eagerLoadTerminal: false,
                projectId: ProjectStore.shared.activeProjectId
            )
        }
        helperTabManager.closeWorkspace(helper)
        _ = WorkspaceMetadataStore.shared.removeMetadataForId(helper.id)
    }
}
