// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct TaskAutomationRemoteState: Codable, Equatable, Sendable {
    var storageKey: String
    var firstSeenAt: Date
    var lastSeenAt: Date
    var providerUpdatedAt: Date?
    var taskCreatedAt: Date?
    var worktreeStartedAt: Date?
    var agentStartedAt: Date?
    var agentWorkspaceId: UUID?
    var failedAt: Date?
    var failureMessage: String?
    var failureCount: Int?

    init(storageKey: String, seenAt: Date, providerUpdatedAt: Date?) {
        self.storageKey = storageKey
        self.firstSeenAt = seenAt
        self.lastSeenAt = seenAt
        self.providerUpdatedAt = providerUpdatedAt
    }
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
            state.failureMessage = nil
            state.failedAt = nil
        }
    }

    func markWorktreeStarted(storageKey: String, now: Date = Date()) {
        mutateRemote(storageKey, now: now) { state in
            state.worktreeStartedAt = state.worktreeStartedAt ?? now
            state.failureMessage = nil
            state.failedAt = nil
        }
    }

    func markAgentStarted(storageKey: String, workspaceId: UUID, now: Date = Date()) {
        mutateRemote(storageKey, now: now) { state in
            state.agentStartedAt = state.agentStartedAt ?? now
            state.agentWorkspaceId = workspaceId
            state.failureMessage = nil
            state.failedAt = nil
        }
    }

    func hasAgentStarted(storageKey: String) -> Bool {
        ensureLoaded()
        return file.remotes[storageKey]?.agentStartedAt != nil
    }

    func markFailed(storageKey: String, message: String, now: Date = Date()) {
        mutateRemote(storageKey, now: now) { state in
            state.failedAt = now
            state.failureMessage = message
            state.failureCount = (state.failureCount ?? 0) + 1
        }
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
        if state.worktreeStartedAt != nil, state.failedAt == nil {
            return true
        }
        guard let failedAt = state.failedAt,
              (state.failureCount ?? 0) < Self.maxFailureRetries else {
            return false
        }
        return now.timeIntervalSince(failedAt) >= Self.failureRetryInterval
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
