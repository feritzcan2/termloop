// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum TaskAutomationFailureStage: String, Codable, Equatable, Sendable {
    case taskSync
    case worktree
    case agentLaunch
}

struct TaskAutomationRemoteState: Codable, Equatable, Sendable {
    var storageKey: String
    var firstSeenAt: Date
    var lastSeenAt: Date
    var providerUpdatedAt: Date?
    var taskCreatedAt: Date?
    var worktreeStartedAt: Date?
    var agentStartedAt: Date?
    var agentWorkspaceId: UUID?
    var terminalObservedAt: Date?
    var failedAt: Date?
    var failureMessage: String?
    var failureCount: Int?
    var failureStage: TaskAutomationFailureStage?
    var failureCountsByStage: [String: Int]?

    init(storageKey: String, seenAt: Date, providerUpdatedAt: Date?) {
        self.storageKey = storageKey
        self.firstSeenAt = seenAt
        self.lastSeenAt = seenAt
        self.providerUpdatedAt = providerUpdatedAt
    }
}

struct TaskAutomationFailureSummary: Identifiable, Equatable, Sendable {
    var id: String { storageKey }
    let storageKey: String
    let remoteKey: String
    let failedAt: Date
    let message: String
    let failureCount: Int
    let stage: TaskAutomationFailureStage?
}

struct TaskAutomationStateFile: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    var schemaVersion: Int = currentSchemaVersion
    var activeScopeKey: String?
    var baselineCompletedAt: Date?
    var lastFullReconcileAt: Date?
    var remotes: [String: TaskAutomationRemoteState] = [:]
    var updatedAt: Date = Date()
}

private actor TaskAutomationStateDiskWriter {
    func save(file: TaskAutomationStateFile, to url: URL, projectRoot: URL) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: nil
            )
            let tmp = url.deletingLastPathComponent()
                .appendingPathComponent(".\(url.lastPathComponent).tmp-\(UUID().uuidString)")
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(file)
            try data.write(to: tmp, options: .atomic)
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: url)
            }
        } catch {
            NSLog("[TaskAutomationState] save failed project=\(projectRoot.path) error=\(error)")
        }
    }
}

@MainActor
final class TaskAutomationStateStore {
    let projectRoot: URL
    private static let maxFailureRetries = 3
    private static let failureRetryInterval: TimeInterval = 15 * 60
    private let diskWriter = TaskAutomationStateDiskWriter()
    private var file = TaskAutomationStateFile()
    private var loaded = false

    init(projectRoot: URL) {
        self.projectRoot = projectRoot
    }

    var snapshot: TaskAutomationStateFile {
        ensureLoaded()
        return file
    }

    var unresolvedFailures: [TaskAutomationFailureSummary] {
        ensureLoaded()
        return file.remotes.values.compactMap { state in
            guard let failedAt = state.failedAt,
                  let message = state.failureMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !message.isEmpty else {
                return nil
            }
            return TaskAutomationFailureSummary(
                storageKey: state.storageKey,
                remoteKey: Self.remoteKey(from: state.storageKey),
                failedAt: failedAt,
                message: message,
                failureCount: state.failureCount ?? 1,
                stage: state.failureStage
            )
        }
        .sorted { $0.failedAt > $1.failedAt }
    }

    func hasCompletedBaseline(scopeKey: String) -> Bool {
        ensureLoaded()
        return file.activeScopeKey == scopeKey && file.baselineCompletedAt != nil
    }

    func ensureBaselineSeeded(
        _ snapshots: [RemoteWorkItemSnapshot],
        scopeKey: String,
        completed: Bool,
        now: Date = Date()
    ) {
        ensureLoaded()
        var changed = activateScopeIfNeeded(scopeKey, now: now)
        for snapshot in snapshots {
            let key = snapshot.reference.storageKey
            if var existing = file.remotes[key] {
                existing.lastSeenAt = now
                existing.providerUpdatedAt = snapshot.providerUpdatedAt ?? existing.providerUpdatedAt
                file.remotes[key] = existing
            } else {
                file.remotes[key] = TaskAutomationRemoteState(
                    storageKey: key,
                    seenAt: now,
                    providerUpdatedAt: snapshot.providerUpdatedAt
                )
                changed = true
            }
        }
        if completed, file.baselineCompletedAt == nil {
            file.baselineCompletedAt = now
            file.lastFullReconcileAt = now
            changed = true
        }
        if changed {
            save()
        }
    }

    func markFullReconcile(_ snapshots: [RemoteWorkItemSnapshot], scopeKey: String, now: Date = Date()) {
        ensureLoaded()
        let scopeChanged = activateScopeIfNeeded(scopeKey, now: now)
        guard !scopeChanged, file.baselineCompletedAt != nil else {
            save()
            return
        }
        for snapshot in snapshots {
            upsertSeen(snapshot, now: now)
        }
        file.lastFullReconcileAt = now
        save()
    }

    func observeWithoutClaiming(
        _ snapshots: [RemoteWorkItemSnapshot],
        scopeKey: String,
        now: Date = Date()
    ) {
        ensureLoaded()
        guard file.activeScopeKey == scopeKey,
              file.baselineCompletedAt != nil,
              !snapshots.isEmpty else {
            return
        }
        for snapshot in snapshots {
            let storageKey = snapshot.reference.storageKey
            upsertSeen(snapshot, now: now)
            if var state = file.remotes[storageKey],
               state.taskCreatedAt == nil,
               state.worktreeStartedAt == nil,
               state.agentStartedAt == nil {
                state.terminalObservedAt = now
                file.remotes[storageKey] = state
            }
        }
        save()
    }

    func claimNewSnapshots(
        _ snapshots: [RemoteWorkItemSnapshot],
        scopeKey: String,
        now: Date = Date()
    ) -> [RemoteWorkItemSnapshot] {
        ensureLoaded()
        guard file.activeScopeKey == scopeKey else {
            ensureBaselineSeeded(snapshots, scopeKey: scopeKey, completed: false, now: now)
            return []
        }
        guard file.baselineCompletedAt != nil else {
            ensureBaselineSeeded(snapshots, scopeKey: scopeKey, completed: false, now: now)
            return []
        }
        var claimed: [RemoteWorkItemSnapshot] = []
        for snapshot in snapshots {
            let key = snapshot.reference.storageKey
            if file.remotes[key] == nil {
                file.remotes[key] = TaskAutomationRemoteState(
                    storageKey: key,
                    seenAt: now,
                    providerUpdatedAt: snapshot.providerUpdatedAt
                )
                claimed.append(snapshot)
            } else if let existing = file.remotes[key], shouldClaimReopenedTerminalState(existing) {
                upsertSeen(snapshot, now: now)
                if var reopened = file.remotes[key] {
                    reopened.terminalObservedAt = nil
                    file.remotes[key] = reopened
                }
                claimed.append(snapshot)
            } else if let existing = file.remotes[key], shouldRetry(existing, now: now) {
                upsertSeen(snapshot, now: now)
                claimed.append(snapshot)
            } else {
                upsertSeen(snapshot, now: now)
            }
        }
        if !snapshots.isEmpty {
            save()
        }
        return claimed
    }

    func markTaskCreated(storageKey: String, now: Date = Date()) {
        mutateRemote(storageKey, now: now) { state in
            state.taskCreatedAt = state.taskCreatedAt ?? now
            state.terminalObservedAt = nil
            if state.failureStage == .taskSync {
                Self.clearFailure(&state)
            }
        }
    }

    func markWorktreeStarted(storageKey: String, now: Date = Date()) {
        mutateRemote(storageKey, now: now) { state in
            state.worktreeStartedAt = state.worktreeStartedAt ?? now
            if state.failureStage == .worktree {
                Self.clearFailure(&state)
            }
        }
    }

    func markAgentStarted(storageKey: String, workspaceId: UUID, now: Date = Date()) {
        mutateRemote(storageKey, now: now) { state in
            state.agentStartedAt = state.agentStartedAt ?? now
            state.agentWorkspaceId = workspaceId
            Self.clearFailure(&state)
        }
    }

    func hasAgentStarted(storageKey: String) -> Bool {
        ensureLoaded()
        return file.remotes[storageKey]?.agentStartedAt != nil
    }

    func canAttemptRepair(storageKey: String, now: Date = Date()) -> Bool {
        ensureLoaded()
        guard let state = file.remotes[storageKey],
              state.agentStartedAt == nil else {
            return false
        }
        return failureAllowsRetry(state, now: now)
    }

    func markFailed(
        storageKey: String,
        stage: TaskAutomationFailureStage,
        message: String,
        now: Date = Date()
    ) {
        mutateRemote(storageKey, now: now) { state in
            state.failedAt = now
            state.failureMessage = message
            var counts = state.failureCountsByStage ?? [:]
            let priorCount = counts[stage.rawValue]
                ?? (state.failureStage == stage ? state.failureCount : nil)
                ?? 0
            let nextCount = priorCount + 1
            counts[stage.rawValue] = nextCount
            state.failureCount = nextCount
            state.failureStage = stage
            state.failureCountsByStage = counts
        }
    }

    func resolveCompleted(storageKeys: Set<String>, now: Date = Date()) {
        ensureLoaded()
        var changed = false
        for storageKey in storageKeys {
            guard var state = file.remotes[storageKey],
                  state.failedAt != nil || state.failureMessage != nil || state.failureCount != nil else {
                continue
            }
            state.lastSeenAt = now
            Self.clearFailure(&state)
            file.remotes[storageKey] = state
            changed = true
        }
        if changed { save() }
    }

    func pruneFailuresNotSeenInFullReconcile(
        observedStorageKeys: Set<String>
    ) {
        ensureLoaded()
        let keysToRemove = file.remotes.compactMap { storageKey, state -> String? in
            guard !observedStorageKeys.contains(storageKey),
                  state.failedAt != nil else {
                return nil
            }
            return storageKey
        }
        guard !keysToRemove.isEmpty else { return }
        for storageKey in keysToRemove {
            file.remotes.removeValue(forKey: storageKey)
        }
        save()
    }

    private func activateScopeIfNeeded(_ scopeKey: String, now: Date) -> Bool {
        guard file.activeScopeKey != scopeKey else { return false }
        NSLog("[TaskAutomationState] scope changed project=\(projectRoot.path) scope=\(scopeKey)")
        file.activeScopeKey = scopeKey
        file.baselineCompletedAt = nil
        file.lastFullReconcileAt = nil
        file.remotes = [:]
        file.updatedAt = now
        return true
    }

    private func upsertSeen(_ snapshot: RemoteWorkItemSnapshot, now: Date) {
        let key = snapshot.reference.storageKey
        if var existing = file.remotes[key] {
            existing.lastSeenAt = now
            existing.providerUpdatedAt = snapshot.providerUpdatedAt ?? existing.providerUpdatedAt
            file.remotes[key] = existing
        } else {
            file.remotes[key] = TaskAutomationRemoteState(
                storageKey: key,
                seenAt: now,
                providerUpdatedAt: snapshot.providerUpdatedAt
            )
        }
    }

    private func shouldRetry(_ state: TaskAutomationRemoteState, now: Date) -> Bool {
        guard state.agentStartedAt == nil else {
            return false
        }
        guard state.worktreeStartedAt != nil || state.failedAt != nil else {
            return false
        }
        return failureAllowsRetry(state, now: now)
    }

    private func shouldClaimReopenedTerminalState(_ state: TaskAutomationRemoteState) -> Bool {
        state.terminalObservedAt != nil
            && state.taskCreatedAt == nil
            && state.worktreeStartedAt == nil
            && state.agentStartedAt == nil
    }

    private func failureAllowsRetry(_ state: TaskAutomationRemoteState, now: Date) -> Bool {
        guard let failedAt = state.failedAt else { return true }
        let stageFailureCount = state.failureStage.flatMap {
            state.failureCountsByStage?[$0.rawValue]
        } ?? state.failureCount ?? 0
        guard stageFailureCount < Self.maxFailureRetries else { return false }
        return now.timeIntervalSince(failedAt) >= Self.failureRetryInterval
    }

    private static func clearFailure(_ state: inout TaskAutomationRemoteState) {
        state.failedAt = nil
        state.failureMessage = nil
        state.failureCount = nil
        state.failureStage = nil
        state.failureCountsByStage = nil
    }

    private static func remoteKey(from storageKey: String) -> String {
        let pieces = storageKey.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard pieces.count == 3 else { return storageKey }
        return String(pieces[2])
    }

    private func mutateRemote(
        _ storageKey: String,
        now: Date,
        _ block: (inout TaskAutomationRemoteState) -> Void
    ) {
        ensureLoaded()
        var state = file.remotes[storageKey] ?? TaskAutomationRemoteState(
            storageKey: storageKey,
            seenAt: now,
            providerUpdatedAt: nil
        )
        state.lastSeenAt = now
        block(&state)
        file.remotes[storageKey] = state
        save()
    }

    private func ensureLoaded() {
        guard !loaded else { return }
        loaded = true
        let url = stateFileURL()
        guard FileManager.default.fileExists(atPath: url.path) else {
            file = TaskAutomationStateFile()
            return
        }
        do {
            let data = try Data(contentsOf: url)
            file = try JSONDecoder.tasks.decode(TaskAutomationStateFile.self, from: data)
        } catch {
            NSLog("[TaskAutomationState] load failed path=\(url.path) error=\(error)")
            file = TaskAutomationStateFile()
        }
    }

    private func save() {
        file.updatedAt = Date()
        let snapshot = file
        let url = stateFileURL()
        let projectRoot = projectRoot
        Task {
            await diskWriter.save(file: snapshot, to: url, projectRoot: projectRoot)
        }
    }

    private func stateFileURL() -> URL {
        projectRoot.appendingPathComponent(".termloop/task-automation-state.json")
    }
}

@MainActor
enum TaskAutomationStateStoreProvider {
    private static var stores: [String: TaskAutomationStateStore] = [:]

    static func store(projectRoot: URL) -> TaskAutomationStateStore {
        let key = projectRoot.resolvingSymlinksInPath().path
        if let existing = stores[key] { return existing }
        let created = TaskAutomationStateStore(projectRoot: projectRoot)
        stores[key] = created
        return created
    }
}
