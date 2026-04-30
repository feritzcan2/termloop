// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import Foundation
import os

enum TerminalAgentActivityPhase: String, Codable, Equatable {
    case inactive
    /// Agent process started, REPL initialized, awaiting user's first turn.
    /// Distinct from `.running` (active work in progress) so the sidebar can
    /// signal "agent is alive" before any prompt has been submitted.
    case ready
    case running
    case waiting
    case failed
}

enum TerminalAgentAttentionKind: String, Codable, Equatable {
    case completion
    case notification
    case permission
    case userInput
    case error
}

struct TerminalAgentActivityState: Codable, Equatable {
    let workspaceId: UUID
    let agentId: String
    var phase: TerminalAgentActivityPhase
    var attentionKind: TerminalAgentAttentionKind?
    var preview: String?
    var waitingSince: Int?
    var sessionId: String?
    var cwd: String?
    var pid: pid_t?
    var startedAt: Date?
    var updatedAt: Date

    var isVisibleInActiveAgents: Bool {
        phase == .ready || phase == .running || phase == .waiting || phase == .failed
    }
}

@MainActor
final class TerminalAgentActivityStore: ObservableObject {
    enum PendingPlaceholderState {
        case ready
        case running
    }

    static let shared = TerminalAgentActivityStore()

    @Published private(set) var statesByWorkspaceId: [UUID: TerminalAgentActivityState] = [:]
    @Published private(set) var pendingPlaceholderByWorkspaceId: [UUID: PendingPlaceholderState] = [:]
    @Published private(set) var version: Int = 0

    /// Authoritative normalized presentation truth. Updated only via coalesced
    /// flush — consumers must read this instead of deriving UI state from the
    /// raw `statesByWorkspaceId`, metadata, or `workspace.statusEntries`.
    @Published private(set) var presentationByWorkspaceId: [UUID: TerminalAgentPresentationState] = [:]

    /// Bumped at most once per coalesced flush when at least one workspace's
    /// presentation actually changed. Snapshot panels subscribe to this to
    /// rebuild their parent snapshot.
    @Published private(set) var presentationVersion: Int = 0

    /// Per-workspace narrow signals. Subscribers filter by workspace id to avoid
    /// fan-out across the whole sidebar when `statesByWorkspaceId` mutates for
    /// a single agent. Fires in addition to the `@Published` dictionary; does
    /// not replace it.
    let workspaceStateDidChange = PassthroughSubject<UUID, Never>()
    let workspacePendingPlaceholderDidChange = PassthroughSubject<UUID, Never>()

    /// Per-workspace signal emitted once per coalesced flush for each workspace
    /// whose presentation actually changed. Live row consumers subscribe with
    /// a workspace-id filter to skip the panel-level rebuild.
    let workspacePresentationDidChange = PassthroughSubject<UUID, Never>()

    private var dirtyPresentationWorkspaceIds: Set<UUID> = []
    private var isPresentationFlushScheduled = false
    private var isPresentationFlushing = false
    private var cancellables: Set<AnyCancellable> = []

    // MARK: - Reconcile

    private static let logger = Logger(
        subsystem: "com.termloop.fork",
        category: "agent-activity-reconcile"
    )
    private static let lifecycleLogger = Logger(
        subsystem: "com.termloop.fork",
        category: "agent-lifecycle.store"
    )

    private static func lifecycleLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        let rendered = message()
        lifecycleLogger.debug("\(rendered, privacy: .public)")
        #endif
    }

    /// Foreground cadence. Background pauses the timer and a wake/active
    /// event triggers a single immediate pass — no missed-tick catch-up.
    private static let reconcileInterval: TimeInterval = 5

    /// How long a `.running` state can stay without a raw update before the
    /// reconciler considers it stale. Tuned to accommodate extended-thinking
    /// gaps; false-positive flips self-correct on the next `pre-tool-use`.
    private static let staleRunningThreshold: TimeInterval = 60

    /// Bound expensive Codex lifecycle fallback so stale-but-healthy sessions
    /// do not rescan the session store every reconcile tick.
    nonisolated private static let scannerProbeInterval: TimeInterval = 30

    private var reconcileTimer: Timer?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var isReconcileRunning = false
    private var lastScannerProbeAtByWorkspaceId: [UUID: Date] = [:]

    private init() {
        subscribeToMetadataInvalidations()
    }

    private func subscribeToMetadataInvalidations() {
        WorkspaceMetadataStore.shared.agentPresentationDidChange
            .sink { [weak self] workspaceId in
                MainActor.assumeIsolated {
                    self?.markPresentationDirty(workspaceId: workspaceId)
                }
            }
            .store(in: &cancellables)
    }

    func state(forWorkspaceId workspaceId: UUID) -> TerminalAgentActivityState? {
        statesByWorkspaceId[workspaceId]
    }

    func visibleStates() -> [TerminalAgentActivityState] {
        statesByWorkspaceId.values.filter(\.isVisibleInActiveAgents)
    }

    // MARK: - Presentation read API

    func presentation(forWorkspaceId workspaceId: UUID) -> TerminalAgentPresentationState? {
        presentationByWorkspaceId[workspaceId]
    }

    func displayState(forWorkspaceId workspaceId: UUID) -> TerminalAgentDisplayState {
        presentationByWorkspaceId[workspaceId]?.displayState ?? .idle
    }

    func latestActivityDate(forWorkspaceId workspaceId: UUID) -> Date? {
        presentationByWorkspaceId[workspaceId]?.latestActivityAt
    }

    func hasVisiblePresentation(forWorkspaceId workspaceId: UUID) -> Bool {
        guard let presentation = presentationByWorkspaceId[workspaceId] else {
            return false
        }
        return presentation.displayState.isVisibleActivity
    }

    #if DEBUG
    /// Test-only synchronous drain. Production reads rely on the scheduled
    /// flush; mutating `@Published` state during a SwiftUI body read is
    /// undefined behaviour, so never call this from UI code.
    func drainPresentationFlushForTesting() {
        flushPresentationIfNeeded()
    }
    #endif

    // MARK: - Dirty / coalesced flush

    func markPresentationDirty(workspaceId: UUID) {
        dirtyPresentationWorkspaceIds.insert(workspaceId)
        Self.lifecycleLog(
            "store.presentationDirty workspace=\(workspaceId.uuidString) dirtyCount=\(dirtyPresentationWorkspaceIds.count)"
        )
        schedulePresentationFlush()
    }

    private func schedulePresentationFlush() {
        if isPresentationFlushScheduled { return }
        isPresentationFlushScheduled = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.flushPresentationIfNeeded()
            }
        }
    }

    private func flushPresentationIfNeeded() {
        isPresentationFlushScheduled = false
        guard !isPresentationFlushing else { return }
        guard !dirtyPresentationWorkspaceIds.isEmpty else { return }
        isPresentationFlushing = true
        defer { isPresentationFlushing = false }

        let pending = dirtyPresentationWorkspaceIds
        dirtyPresentationWorkspaceIds.removeAll(keepingCapacity: true)
        var didChangeAny = false

        for workspaceId in pending {
            let raw = statesByWorkspaceId[workspaceId]
            let metadata = WorkspaceMetadataStore.shared.presentationSnapshot(forWorkspaceId: workspaceId)
            let pendingPlaceholder = pendingPlaceholderByWorkspaceId[workspaceId]
            let next = TerminalAgentPresentationReducer.computePresentation(
                workspaceId: workspaceId,
                raw: raw,
                metadata: metadata,
                pending: pendingPlaceholder
            )
            let previous = presentationByWorkspaceId[workspaceId]
            guard previous != next else { continue }
            Self.lifecycleLog(
                "store.presentationFlush workspace=\(workspaceId.uuidString) previous=\(previous.map { "\($0.displayState.rawValue)/\($0.source.rawValue)" } ?? "nil") next=\(next.map { "\($0.displayState.rawValue)/\($0.source.rawValue)" } ?? "nil") rawPhase=\(raw?.phase.rawValue ?? "nil") rawAttention=\(raw?.attentionKind?.rawValue ?? "nil")"
            )
            if let next {
                presentationByWorkspaceId[workspaceId] = next
            } else {
                presentationByWorkspaceId.removeValue(forKey: workspaceId)
            }
            workspacePresentationDidChange.send(workspaceId)
            didChangeAny = true
        }

        if didChangeAny {
            presentationVersion &+= 1
        }

        if !dirtyPresentationWorkspaceIds.isEmpty {
            schedulePresentationFlush()
        }
    }

    // MARK: - Stale-running reconcile

    /// Starts the foreground reconcile timer and installs lifecycle observers
    /// (app active/inactive, system wake). Idempotent.
    func startReconcileLoop() {
        installLifecycleObservers()
        startReconcileTimer()
    }

    /// Tears down the timer and removes lifecycle observers. Used by tests.
    func stopReconcileLoop() {
        stopReconcileTimer()
        for observer in lifecycleObservers {
            NotificationCenter.default.removeObserver(observer)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        lifecycleObservers.removeAll()
    }

    private func startReconcileTimer() {
        guard reconcileTimer == nil else { return }
        reconcileTimer = Timer.scheduledTimer(
            withTimeInterval: Self.reconcileInterval,
            repeats: true
        ) { [weak self] _ in
            Task { @MainActor in self?.scheduleReconcilePass() }
        }
    }

    private func stopReconcileTimer() {
        reconcileTimer?.invalidate()
        reconcileTimer = nil
    }

    private func installLifecycleObservers() {
        guard lifecycleObservers.isEmpty else { return }
        let nsCenter = NotificationCenter.default
        lifecycleObservers.append(
            nsCenter.addObserver(
                forName: NSApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.startReconcileTimer()
                    self?.scheduleReconcilePass()
                }
            }
        )
        lifecycleObservers.append(
            nsCenter.addObserver(
                forName: NSApplication.didResignActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.stopReconcileTimer() }
            }
        )
        lifecycleObservers.append(
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.scheduleReconcilePass() }
            }
        )
    }

    /// Snapshots running states on the main actor, then runs the stale check
    /// (Date arithmetic + `kill(pid, 0)`) off-main. Any stale workspace is
    /// patched back on the main actor via `clear(workspaceId:)`, which emits
    /// the presentation-dirty mark through the normal flush path.
    private func scheduleReconcilePass() {
        guard !isReconcileRunning else { return }
        let now = Date()
        struct Candidate {
            let workspaceId: UUID
            let agentId: String
            let phase: TerminalAgentActivityPhase
            let attentionKind: TerminalAgentAttentionKind?
            let pid: pid_t?
            let sessionId: String?
            let cwd: String?
            let updatedAt: Date
            let lastUserPromptAt: Date?
            let lastScannerProbeAt: Date?
        }
        let candidates: [Candidate] = statesByWorkspaceId.values.compactMap { state in
            guard state.phase != .inactive else { return nil }
            let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: state.workspaceId)
            return Candidate(
                workspaceId: state.workspaceId,
                agentId: state.agentId,
                phase: state.phase,
                attentionKind: state.attentionKind,
                pid: state.pid,
                sessionId: state.sessionId,
                cwd: state.cwd,
                updatedAt: state.updatedAt,
                lastUserPromptAt: metadata.lastUserPromptAt,
                lastScannerProbeAt: lastScannerProbeAtByWorkspaceId[state.workspaceId]
            )
        }
        guard !candidates.isEmpty else { return }
        isReconcileRunning = true
        let threshold = Self.staleRunningThreshold
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var probedWorkspaceIds: [UUID] = []
            let patches: [ReconcilePatch] = candidates.compactMap { candidate in
                if candidate.agentId == "codex",
                   let sessionId = candidate.sessionId,
                   Self.shouldProbeCodexLifecycle(
                    phase: candidate.phase,
                    lastProbeAt: candidate.lastScannerProbeAt,
                    now: now
                   ) {
                    probedWorkspaceIds.append(candidate.workspaceId)
                    if let snapshot = CodexSessionScanner.shared.lifecycleSnapshot(
                        sessionId: sessionId,
                        cwd: candidate.cwd
                    ),
                       let eventAt = snapshot.timestamp {
                        let isNewerThanRawUpdate = eventAt > candidate.updatedAt
                        let isAfterLastUserPrompt = candidate.lastUserPromptAt.map { eventAt >= $0 }
                            ?? isNewerThanRawUpdate
                        switch (candidate.phase, snapshot.activity) {
                        case (.running, .interrupted) where isAfterLastUserPrompt:
                            return .ready(
                                workspaceId: candidate.workspaceId,
                                agentId: candidate.agentId,
                                sessionId: candidate.sessionId,
                                cwd: candidate.cwd,
                                pid: candidate.pid
                            )
                        case (_, .completed) where isAfterLastUserPrompt
                            && !(candidate.phase == .waiting && candidate.attentionKind == .completion):
                            return .completed(
                                workspaceId: candidate.workspaceId,
                                agentId: candidate.agentId,
                                sessionId: candidate.sessionId,
                                cwd: candidate.cwd,
                                pid: candidate.pid
                            )
                        case (_, .running) where isNewerThanRawUpdate && candidate.phase != .running:
                            return .running(
                                workspaceId: candidate.workspaceId,
                                agentId: candidate.agentId,
                                sessionId: candidate.sessionId,
                                cwd: candidate.cwd,
                                pid: candidate.pid
                            )
                        default:
                            break
                        }
                    }
                }
                guard candidate.phase == .running else { return nil }
                let age = now.timeIntervalSince(candidate.updatedAt)
                guard age > threshold else { return nil }
                if let pid = candidate.pid, pid > 0, Self.isProcessAlive(pid: pid) {
                    return nil
                }
                return .clear(candidate.workspaceId)
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.applyReconcilePatches(
                        patches,
                        probedWorkspaceIds: probedWorkspaceIds,
                        probedAt: now
                    )
                }
            }
        }
    }

    /// `kill(pid, 0)` probe that treats `EPERM` as "alive" — the process
    /// exists but signalling is denied — matching the `sweepStaleAgentPIDs`
    /// semantics used elsewhere. Plain `kill == 0` would misclassify these
    /// as dead and cause false stale flips.
    nonisolated private static func isProcessAlive(pid: pid_t) -> Bool {
        errno = 0
        if kill(pid, 0) == 0 { return true }
        return errno != ESRCH
    }

    nonisolated private static func shouldProbeCodexLifecycle(
        phase: TerminalAgentActivityPhase,
        lastProbeAt: Date?,
        now: Date
    ) -> Bool {
        guard phase == .running else { return false }

        let timeSinceLastProbe = lastProbeAt.map { now.timeIntervalSince($0) } ?? .infinity
        // Codex process liveness is not turn liveness: the TUI can remain
        // alive after a `task_complete`. Probe JSONL lifecycle truth on a
        // bounded cadence; PID liveness is still used only for stale cleanup.
        return timeSinceLastProbe >= scannerProbeInterval
    }

    private enum ReconcilePatch {
        case clear(UUID)
        case running(workspaceId: UUID, agentId: String, sessionId: String?, cwd: String?, pid: pid_t?)
        case ready(workspaceId: UUID, agentId: String, sessionId: String?, cwd: String?, pid: pid_t?)
        case completed(workspaceId: UUID, agentId: String, sessionId: String?, cwd: String?, pid: pid_t?)
    }

    private func applyReconcilePatch(_ patch: ReconcilePatch) {
        switch patch {
        case .clear(let workspaceId):
            guard let state = statesByWorkspaceId[workspaceId], state.phase == .running else {
                return
            }
            Self.logger.info(
                "clearing stale running for workspace \(workspaceId.uuidString.prefix(8), privacy: .public) agent \(state.agentId, privacy: .public)"
            )
            clear(workspaceId: workspaceId)
        case let .running(workspaceId, agentId, sessionId, cwd, pid):
            guard let state = statesByWorkspaceId[workspaceId], state.phase != .running else {
                return
            }
            Self.logger.info(
                "reconciling codex activity -> running for workspace \(workspaceId.uuidString.prefix(8), privacy: .public)"
            )
            upsert(
                workspaceId: workspaceId,
                agentId: agentId,
                phase: .running,
                attentionKind: nil,
                preview: nil,
                waitingSince: nil,
                sessionId: sessionId,
                cwd: cwd,
                pid: pid
            )
        case let .completed(workspaceId, agentId, sessionId, cwd, pid):
            guard let state = statesByWorkspaceId[workspaceId],
                  !(state.phase == .waiting && state.attentionKind == .completion) else {
                return
            }
            Self.logger.info(
                "reconciling codex activity -> completed for workspace \(workspaceId.uuidString.prefix(8), privacy: .public)"
            )
            upsert(
                workspaceId: workspaceId,
                agentId: agentId,
                phase: .waiting,
                attentionKind: .completion,
                preview: state.preview,
                waitingSince: state.waitingSince,
                sessionId: sessionId,
                cwd: cwd,
                pid: pid
            )
        case let .ready(workspaceId, agentId, sessionId, cwd, pid):
            guard let state = statesByWorkspaceId[workspaceId], state.phase == .running else {
                return
            }
            Self.logger.info(
                "reconciling interrupted codex running -> ready for workspace \(workspaceId.uuidString.prefix(8), privacy: .public)"
            )
            upsert(
                workspaceId: workspaceId,
                agentId: agentId,
                phase: .ready,
                attentionKind: nil,
                preview: state.preview,
                waitingSince: nil,
                sessionId: sessionId,
                cwd: cwd,
                pid: pid
            )
        }
    }

    private func applyReconcilePatches(
        _ patches: [ReconcilePatch],
        probedWorkspaceIds: [UUID],
        probedAt: Date
    ) {
        defer { isReconcileRunning = false }
        for workspaceId in probedWorkspaceIds {
            lastScannerProbeAtByWorkspaceId[workspaceId] = probedAt
        }
        for patch in patches {
            applyReconcilePatch(patch)
        }
    }

    func isPendingRestore(workspaceId: UUID) -> Bool {
        pendingPlaceholderByWorkspaceId[workspaceId] != nil
    }

    func pendingPlaceholderState(workspaceId: UUID) -> PendingPlaceholderState? {
        pendingPlaceholderByWorkspaceId[workspaceId]
    }

    func markPendingRestore(
        workspaceId: UUID,
        state: PendingPlaceholderState = .ready
    ) {
        if pendingPlaceholderByWorkspaceId[workspaceId] == state {
            return
        }
        pendingPlaceholderByWorkspaceId[workspaceId] = state
        Self.lifecycleLog(
            "store.pendingRestore.set workspace=\(workspaceId.uuidString) state=\(String(describing: state))"
        )
        version &+= 1
        workspacePendingPlaceholderDidChange.send(workspaceId)
        markPresentationDirty(workspaceId: workspaceId)
    }

    func clearPendingRestore(workspaceId: UUID) {
        guard pendingPlaceholderByWorkspaceId.removeValue(forKey: workspaceId) != nil else { return }
        Self.lifecycleLog(
            "store.pendingRestore.clear workspace=\(workspaceId.uuidString)"
        )
        version &+= 1
        workspacePendingPlaceholderDidChange.send(workspaceId)
        markPresentationDirty(workspaceId: workspaceId)
    }

    func upsert(
        workspaceId: UUID,
        agentId: String,
        phase: TerminalAgentActivityPhase,
        attentionKind: TerminalAgentAttentionKind?,
        preview: String?,
        waitingSince: Int?,
        sessionId: String?,
        cwd: String?,
        pid: pid_t?
    ) {
        let current = statesByWorkspaceId[workspaceId] ?? TerminalAgentActivityState(
            workspaceId: workspaceId,
            agentId: agentId,
            phase: .inactive,
            attentionKind: nil,
            preview: nil,
            waitingSince: nil,
            sessionId: nil,
            cwd: nil,
            pid: nil,
            startedAt: nil,
            updatedAt: .distantPast
        )
        let normalizedPreview = preview?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? preview : nil
        let normalizedSessionId = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? sessionId : nil
        let normalizedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? cwd : nil
        let normalizedPid = pid.flatMap { $0 > 0 ? $0 : nil }
        if current.sessionId != normalizedSessionId {
            lastScannerProbeAtByWorkspaceId.removeValue(forKey: workspaceId)
        }
        let nextStartedAt: Date? = {
            if phase == .ready || phase == .running {
                return current.startedAt ?? Date()
            }
            if phase == .inactive {
                return nil
            }
            return current.startedAt
        }()
        let next = TerminalAgentActivityState(
            workspaceId: workspaceId,
            agentId: agentId,
            phase: phase,
            attentionKind: attentionKind,
            preview: normalizedPreview,
            waitingSince: waitingSince,
            sessionId: normalizedSessionId ?? current.sessionId,
            cwd: normalizedCwd ?? current.cwd,
            pid: normalizedPid ?? current.pid,
            startedAt: nextStartedAt,
            updatedAt: Date()
        )
        guard current != next else { return }
        Self.lifecycleLog(
            "store.upsert workspace=\(workspaceId.uuidString) agent=\(agentId) phase=\(phase.rawValue) attention=\(attentionKind?.rawValue ?? "nil") session=\(next.sessionId ?? "nil") pid=\(next.pid.map(String.init) ?? "nil") cwd=\(next.cwd ?? "nil") current=\(current.phase.rawValue)/\(current.attentionKind?.rawValue ?? "nil") next=\(next.phase.rawValue)/\(next.attentionKind?.rawValue ?? "nil")"
        )
        let hadPending = pendingPlaceholderByWorkspaceId[workspaceId] != nil
        statesByWorkspaceId[workspaceId] = next
        pendingPlaceholderByWorkspaceId.removeValue(forKey: workspaceId)
        version &+= 1
        workspaceStateDidChange.send(workspaceId)
        if hadPending {
            workspacePendingPlaceholderDidChange.send(workspaceId)
        }
        markPresentationDirty(workspaceId: workspaceId)
    }

    func clear(workspaceId: UUID) {
        let removedState = statesByWorkspaceId.removeValue(forKey: workspaceId) != nil
        let removedPending = pendingPlaceholderByWorkspaceId.removeValue(forKey: workspaceId) != nil
        lastScannerProbeAtByWorkspaceId.removeValue(forKey: workspaceId)
        guard removedState || removedPending else { return }
        Self.lifecycleLog(
            "store.clear workspace=\(workspaceId.uuidString) removedState=\(removedState ? 1 : 0) removedPending=\(removedPending ? 1 : 0)"
        )
        version &+= 1
        if removedState {
            workspaceStateDidChange.send(workspaceId)
        }
        if removedPending {
            workspacePendingPlaceholderDidChange.send(workspaceId)
        }
        markPresentationDirty(workspaceId: workspaceId)
    }

    /// User saw an attention state by activating the row; convert
    /// needs-input / completed back to plain ready so the row reflects that
    /// the attention has been acknowledged without tearing down the session.
    func acknowledgeViewedAttention(forWorkspaceId id: UUID) {
        guard let presentation = presentationByWorkspaceId[id],
              presentation.displayState == .needsInput || presentation.displayState == .completed else {
            return
        }

        let current = statesByWorkspaceId[id]
        let agentId = current?.agentId
            ?? presentation.agentId
            ?? WorkspaceMetadataStore.shared.persistedAgentSession(for: id)?.agentId
            ?? WorkspaceMetadataStore.shared.terminalAgentId(for: id)
        let pid = current?.pid

        Self.lifecycleLog(
            "store.attentionAck workspace=\(id.uuidString) display=\(presentation.displayState.rawValue) rawPhase=\(current?.phase.rawValue ?? "nil") rawAttention=\(current?.attentionKind?.rawValue ?? "nil")"
        )

        WorkspaceMetadataStore.shared.clearAttentionState(forWorkspaceId: id)

        if let current,
           current.phase == .waiting,
           current.attentionKind != .error {
            upsert(
                workspaceId: id,
                agentId: current.agentId,
                phase: .ready,
                attentionKind: nil,
                preview: current.preview,
                waitingSince: nil,
                sessionId: current.sessionId,
                cwd: current.cwd,
                pid: current.pid
            )
        } else {
            markPresentationDirty(workspaceId: id)
        }

        syncCompatibilityReadyStatus(
            workspaceId: id,
            agentId: agentId,
            pid: pid
        )
    }

    private func syncCompatibilityReadyStatus(
        workspaceId: UUID,
        agentId: String?,
        pid: pid_t?
    ) {
        guard let agentId,
              let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
            return
        }
        let statusKey = TerminalAgentStatusKeys.key(forAgentId: agentId)
        let readyPresentation = TerminalAgentDisplayFormatter.presentation(for: .ready)
        workspace.statusEntries[statusKey] = SidebarStatusEntry(
            key: statusKey,
            value: readyPresentation.label ?? "",
            icon: readyPresentation.icon,
            color: readyPresentation.colorHex
        )
        if let pid, pid > 0 {
            workspace.agentPIDs[statusKey] = pid
        }
    }

    func replaceForTesting(_ states: [UUID: TerminalAgentActivityState]) {
        let previousStateIds = Set(statesByWorkspaceId.keys)
        let previousPendingIds = Set(pendingPlaceholderByWorkspaceId.keys)
        statesByWorkspaceId = states
        pendingPlaceholderByWorkspaceId = [:]
        lastScannerProbeAtByWorkspaceId = [:]
        version &+= 1
        for id in previousStateIds.union(states.keys) {
            workspaceStateDidChange.send(id)
            markPresentationDirty(workspaceId: id)
        }
        for id in previousPendingIds {
            workspacePendingPlaceholderDidChange.send(id)
            markPresentationDirty(workspaceId: id)
        }
    }
}
