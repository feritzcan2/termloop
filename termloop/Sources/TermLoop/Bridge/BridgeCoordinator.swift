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

    private weak var tabManager: TabManager?
    private let store: WorkspaceBridgeStore
    private let extractor: BridgeMessageExtractor
    private var started: Bool = false
    private var tabsRestoreSubscription: AnyCancellable?
    /// One subscription per running auto-mode bridge. Watches
    /// `TerminalAgentActivityStore.workspacePresentationDidChange` and forwards
    /// the source side's latest assistant message on a `running → settled`
    /// edge. Removed when the bridge stops, is dismissed, or flips to manual.
    private var autoForwardCancellables: [UUID: AnyCancellable] = [:]
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

    /// Binds the TabManager and schedules the post-restore reconcile pass.
    /// `bootstrapSidebar` fires from `Root.body.onAppear`, which runs before
    /// workspaces have finished their async restore — so we wait for the
    /// first non-empty `tabs` publish before validating persisted bridges or
    /// closing orphaned hidden helpers. Without this, an empty `tabs` set
    /// during early bootstrap would mark every persisted bridge as orphaned
    /// and wipe the JSON file. Idempotent.
    func start(tabManager: TabManager) {
        if started { return }
        started = true
        self.tabManager = tabManager
        BridgeDebugTrace.log("coord.start tabs=\(tabManager.tabs.count) bridges=\(store.bridges.count)")
        if !tabManager.tabs.isEmpty {
            reconcileAfterRestore(tabManager: tabManager)
            return
        }
        tabsRestoreSubscription = tabManager.$tabs
            .filter { !$0.isEmpty }
            .first()
            .sink { [weak self] tabs in
                BridgeDebugTrace.log("coord.start.deferred-fire tabs=\(tabs.count)")
                self?.reconcileAfterRestore(tabManager: tabManager)
                self?.tabsRestoreSubscription = nil
            }
        BridgeDebugTrace.log("coord.start.deferred-wait (tabs empty)")
    }

    private func reconcileAfterRestore(tabManager: TabManager) {
        BridgeDebugTrace.log("coord.reconcile tabs=\(tabManager.tabs.count) bridges=\(store.bridges.count)")
        store.rebindAfterRestore(tabManager: tabManager)
        cleanupOrphanedHiddenHelpers(tabManager: tabManager)
        for bridge in store.bridges where bridge.state == .running
            && bridge.effectiveForwardMode == .auto {
            attachAutoForwardSubscription(for: bridge)
        }
    }

    /// Closes hidden helper workspaces that are not referenced by any active
    /// bridge. Without a bridge cable they are unreachable from the sidebar
    /// (hideFromWorkspaceTree filters them out) and would otherwise pile up
    /// after a restart that lost the bridge link.
    private func cleanupOrphanedHiddenHelpers(tabManager: TabManager) {
        let metaStore = WorkspaceMetadataStore.shared
        let bridgedRightIds = Set(store.bridges.map(\.rightWorkspaceId))
        let orphans = tabManager.tabs.filter { ws in
            metaStore.isHiddenFromWorkspaceTree(workspaceId: ws.id)
                && !bridgedRightIds.contains(ws.id)
        }
        guard !orphans.isEmpty else { return }
        #if DEBUG
        dlog("bridge.cleanup orphans=\(orphans.count)")
        #endif
        for orphan in orphans {
            tabManager.closeWorkspace(orphan)
        }
    }

    // MARK: - Bridge lifecycle

    /// Extra wait when the kickoff is going to a fresh helper workspace —
    /// PTY surface comes up ~instantly, but Codex/Gemini's boot splash
    /// hasn't drawn its prompt yet. Without this the kickoff text dumps
    /// into the splash and gets fragmented (half the message ends up
    /// somewhere, half lost). 5s covers cold launches, background-throttled
    /// processes, and slower Codex/Gemini boot times. Still a heuristic —
    /// a real readiness signal (prompt-character detection on screen text)
    /// would replace this; tracked as a follow-up.
    private let freshHelperBootDelay: TimeInterval = 5

    /// Pastes rolePrompt + rightPrompt + kickoffMessage. No subscription, no
    /// baseline seeding — subsequent forwarding is manual via
    /// `forwardLatestMessage`.
    func kickoff(bridgeId: UUID) {
        guard let bridge = store.bridge(id: bridgeId),
              let tabManager
        else {
            BridgeDebugTrace.log("coord.kickoff guard-fail id=\(bridgeId.uuidString.prefix(8))")
            return
        }
        BridgeDebugTrace.log("coord.kickoff id=\(bridgeId.uuidString.prefix(8)) intent=\(bridge.intent) first=\(bridge.firstSpeaker)")
        #if DEBUG
        dlog("bridge.kickoff id=\(bridgeId.uuidString.prefix(8)) intent=\(bridge.intent) first=\(bridge.firstSpeaker) kickoffLen=\(bridge.kickoffMessage.count)")
        #endif
        let send = { (text: String, wsId: UUID) in
            self.sendBridgeInput(text, toWorkspaceId: wsId, tabManager: tabManager, bridgeId: bridgeId)
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
        // Sheet path (firstSpeaker .left) sends to the warm source agent —
        // immediate is fine. MCP path (firstSpeaker .right) sends straight
        // into the freshly-spawned helper; wait for its CLI boot splash to
        // clear before pasting.
        let kickoffIsToFreshHelper = bridge.intent == .askAgent
            && bridge.firstSpeaker == .right
        if kickoffIsToFreshHelper {
            DispatchQueue.main.asyncAfter(deadline: .now() + freshHelperBootDelay) { [bridgeId] in
                guard self.store.bridge(id: bridgeId)?.state == .running else { return }
                send(bridge.kickoffMessage, targetId)
            }
        } else {
            send(bridge.kickoffMessage, targetId)
        }
        if bridge.effectiveForwardMode == .auto {
            attachAutoForwardSubscription(for: bridge)
        }
    }

    func stop(bridgeId: UUID) {
        detachAutoForwardSubscription(bridgeId: bridgeId)
        cleanupHelperWorkspaceIfNeeded(bridgeId: bridgeId, force: false)
    }

    func dismiss(bridgeId: UUID) {
        // cleanupHelperWorkspaceIfNeeded reads the bridge from the store, so
        // remove the cancellable first, do the helper close, then mutate the
        // store, and only then prune orphaned display-state entries — at
        // that point `store.bridges` reflects the post-dismiss truth.
        autoForwardCancellables.removeValue(forKey: bridgeId)
        cleanupHelperWorkspaceIfNeeded(bridgeId: bridgeId, force: true)
        store.dismiss(id: bridgeId)
        pruneOrphanedDisplayStates()
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
        dismiss(bridgeId: bridgeId)
        if let tabManager,
           let workspace = tabManager.tabs.first(where: { $0.id == rightWsId }) {
            tabManager.closeWorkspaceFromSidebarPopover(workspace)
        }
    }

    func workspaceDidClose(workspaceId: UUID) {
        guard let bridge = store.bridge(forWorkspaceId: workspaceId) else { return }
        if case .stopped = bridge.state { return }
        store.stop(id: bridge.id, reason: .workspaceClosed)
        stop(bridgeId: bridge.id)
    }

    // MARK: - Manual forward

    /// Idempotent against double-clicks: dedupes against the last forwarded
    /// message and no-ops when the source has nothing new.
    func forwardLatestMessage(from sender: BridgeSender, in bridge: WorkspaceBridge) {
        guard let tabManager,
              let sourceWsId = bridge.workspaceId(for: sender),
              let target = bridge.opposite(of: sender),
              let targetWsId = bridge.workspaceId(for: target),
              let current = store.bridge(id: bridge.id),
              current.state == .running
        else { return }

        let agent = WorkspaceMetadataStore.shared
            .metadata(forWorkspaceId: sourceWsId).terminalAgentId
            ?? TerminalAgent.claudeId
        let session = WorkspaceMetadataStore.shared
            .claudeSession(workspaceId: sourceWsId.uuidString)
        let persisted = Self.freshPersistedSession(forWorkspaceId: sourceWsId, bridge: current)
        let cwd = tabManager.tabs.first(where: { $0.id == sourceWsId })?.currentDirectory ?? ""

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
        sendBridgeInput(snapshot.text, toWorkspaceId: targetWsId, tabManager: tabManager, bridgeId: current.id)
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

    @discardableResult
    private func sendBridgeInput(
        _ text: String,
        toWorkspaceId wsId: UUID,
        tabManager: TabManager,
        bridgeId: UUID? = nil
    ) -> Bool {
        #if DEBUG
        dlog("bridge.send start ws=\(wsId.uuidString.prefix(8)) bid=\(bridgeId?.uuidString.prefix(8) ?? "nil") chars=\(text.count)")
        #endif
        guard let ws = tabManager.tabs.first(where: { $0.id == wsId }),
              let panel = sendableTerminalPanel(in: ws) else {
            #if DEBUG
            dlog("bridge.send no-panel ws=\(wsId.uuidString.prefix(8))")
            #endif
            return false
        }
        sendInputWhenReady(text, to: panel, bridgeId: bridgeId, attempt: 0)
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
        bridgeId: UUID?,
        attempt: Int
    ) {
        if panel.surface.surface != nil {
            submitToClaudeTUI(text, on: panel)
            return
        }

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
                self.submitToClaudeTUI(text, on: panel)
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
                dlog("bridge.send retry attempt=\(nextAttempt)/\(self.sendMaxAttempts) panel=\(panel.id.uuidString.prefix(8))")
                #endif
                self.sendInputWhenReady(text, to: panel, bridgeId: bridgeId, attempt: nextAttempt)
                return
            }
            #if DEBUG
            dlog("bridge.send giveup panel=\(panel.id.uuidString.prefix(8)) chars=\(text.count)")
            #endif
            if let bridgeId, self.store.bridge(id: bridgeId)?.state == .running {
                self.store.stop(id: bridgeId, reason: .sendTimeout)
                self.stop(bridgeId: bridgeId)
            }
        }
    }

    /// Claude Code's TUI interprets Enter as "newline" when the input already
    /// contains newlines (multi-line mode). To submit a multi-line message, we
    /// paste the body via `sendText` (raw bytes, no key interpretation), then
    /// fire a single kVK_Return via `sendInput("\n")` for the actual submit.
    /// Trailing whitespace is trimmed so the final Return lands on a non-blank
    /// line and Claude accepts it.
    private func submitToClaudeTUI(_ raw: String, on panel: TerminalPanel) {
        let body = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        panel.sendText(body)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak panel] in
            panel?.sendInput("\n")
        }
    }

    // MARK: - Helper cleanup

    private func cleanupHelperWorkspaceIfNeeded(bridgeId: UUID, force: Bool) {
        guard let tabManager,
              let bridge = store.bridge(id: bridgeId),
              bridge.intent == .askAgent,
              let helper = tabManager.tabs.first(where: { $0.id == bridge.rightWorkspaceId })
        else { return }

        // Keep hidden askAgent helpers alive after natural stops (.manual) so
        // the bridge row stays clickable — the user can revisit the helper
        // terminal to forward further messages or inspect state. Only force=true
        // (explicit × dismiss) and lifecycle-terminal reasons close the helper.
        let shouldClose: Bool = {
            if force { return true }
            guard case let .stopped(reason) = bridge.state else { return false }
            switch reason {
            case .workspaceClosed, .sendTimeout:
                return true
            case .manual:
                return false
            }
        }()
        guard shouldClose else { return }

        if tabManager.tabs.count == 1 {
            _ = tabManager.addWorkspace(
                title: nil,
                workingDirectory: nil,
                select: true,
                eagerLoadTerminal: false
            )
        }
        tabManager.closeWorkspace(helper)
    }
}
