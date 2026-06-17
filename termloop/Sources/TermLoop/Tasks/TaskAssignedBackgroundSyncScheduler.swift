// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
final class TaskAssignedBackgroundSyncScheduler {
    static let shared = TaskAssignedBackgroundSyncScheduler()

    private let tickSeconds: UInt64 = 30
    private let overlapSeconds: TimeInterval = 15 * 60
    private let fullReconcileInterval: TimeInterval = 60 * 60
    private var loopTask: Task<Void, Never>?
    private var runningProjectIds = Set<UUID>()
    private var nextDueByProjectId: [UUID: Date] = [:]
    private var autoAgentWorkspaceIds = Set<UUID>()

    private init() {}

    func start() {
        guard loopTask == nil else { return }
        NSLog("[TaskBackgroundSync] start")
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.runDueProjects(reason: "timer")
                try? await Task.sleep(nanoseconds: (self?.tickSeconds ?? 30) * 1_000_000_000)
            }
        }
    }

    func settingsDidChange(projectId: UUID) {
        nextDueByProjectId[projectId] = Date()
        Task { [weak self] in
            await self?.runProjectIfDue(projectId: projectId, reason: "settings", force: true)
        }
    }

    func projectDidActivate(_ projectId: UUID?) {
        guard let projectId else { return }
        nextDueByProjectId[projectId] = Date()
        Task { [weak self] in
            await self?.runProjectIfDue(projectId: projectId, reason: "projectDidActivate", force: true)
        }
    }

    private func runDueProjects(reason: String) async {
        for projectId in ProjectStore.shared.openProjectIds {
            await runProjectIfDue(projectId: projectId, reason: reason, force: false)
        }
    }

    private func runProjectIfDue(projectId: UUID, reason: String, force: Bool) async {
        guard !runningProjectIds.contains(projectId) else { return }
        guard let store = TaskBoardStoreProvider.shared.store(for: projectId) else { return }
        let settings = store.settingsSnapshot.remoteSync
        guard settings.isBackgroundSyncEnabled, settings.isBackgroundAssignedSyncEnabled else { return }
        guard force || Date() >= nextDue(for: projectId, settings: settings) else { return }

        runningProjectIds.insert(projectId)
        defer { runningProjectIds.remove(projectId) }

        await runPoll(store: store, settings: settings, reason: reason)
        scheduleNext(projectId: projectId, settings: store.settingsSnapshot.remoteSync)
    }

    private func runPoll(store: TaskBoardStore, settings: TaskRemoteSyncSettings, reason: String) async {
        let stateStore = TaskAutomationStateStoreProvider.store(projectRoot: store.projectRoot)
        let scopeKey = settings.backgroundAutomationScopeKey
        let state = stateStore.snapshot
        let isBaseline = !stateStore.hasCompletedBaseline(scopeKey: scopeKey)
        let isFullReconcile = !isBaseline && (reason == "settings" || shouldRunFullReconcile(state: state))
        let updatedSince: Date? = {
            guard !isBaseline, !isFullReconcile, settings.provider == .jira else { return nil }
            guard let watermark = settings.backgroundJiraWatermark else { return nil }
            return watermark.addingTimeInterval(-overlapSeconds)
        }()

        NSLog(
            "[TaskBackgroundSync] poll start project=\(store.projectId.uuidString) reason=\(reason) " +
            "baseline=\(isBaseline) full=\(isFullReconcile) updatedSince=\(updatedSince.map(String.init(describing:)) ?? "nil")"
        )
        recordActivity(
            store: store,
            level: .info,
            message: "Poll started. reason=\(reason), mode=\(isBaseline ? "baseline" : (isFullReconcile ? "full reconcile" : "incremental"))"
        )

        do {
            let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
            let summary = try await remoteSync.syncAssignedToMeAsync(
                reason: isFullReconcile ? "tasks.background.fullReconcile" : "tasks.background.incremental",
                updatedSince: updatedSince,
                paginate: isBaseline || isFullReconcile
            )

            if isBaseline {
                stateStore.ensureBaselineSeeded(
                    summary.snapshots,
                    scopeKey: scopeKey,
                    completed: !summary.reachedLimit,
                    now: summary.syncedAt
                )
                recordActivity(
                    store: store,
                    level: summary.reachedLimit ? .warning : .success,
                    message: summary.reachedLimit
                        ? "Baseline saw \(summary.snapshots.count) items but hit the request limit; automation stays paused."
                        : "Baseline completed with \(summary.snapshots.count) assigned items."
                )
            } else if isFullReconcile {
                stateStore.markFullReconcile(summary.snapshots, scopeKey: scopeKey, now: summary.syncedAt)
                let retrySnapshots = stateStore.claimNewSnapshots(
                    summary.snapshots,
                    scopeKey: scopeKey,
                    now: summary.syncedAt
                )
                let repairSnapshots = automationRepairSnapshots(
                    summary.snapshots,
                    excluding: retrySnapshots,
                    store: store,
                    settings: store.settingsSnapshot.remoteSync,
                    stateStore: stateStore
                )
                let automationSnapshots = retrySnapshots + repairSnapshots
                recordActivity(
                    store: store,
                    level: automationSnapshots.isEmpty ? .success : .info,
                    message: "Full reconcile checked \(summary.snapshots.count) items; retry candidates=\(retrySnapshots.count), repair candidates=\(repairSnapshots.count)."
                )
                await processNewSnapshots(automationSnapshots, store: store, settings: store.settingsSnapshot.remoteSync, stateStore: stateStore)
            } else {
                let newSnapshots = stateStore.claimNewSnapshots(summary.snapshots, scopeKey: scopeKey, now: summary.syncedAt)
                let repairSnapshots = automationRepairSnapshots(
                    summary.snapshots,
                    excluding: newSnapshots,
                    store: store,
                    settings: store.settingsSnapshot.remoteSync,
                    stateStore: stateStore
                )
                let automationSnapshots = newSnapshots + repairSnapshots
                recordActivity(
                    store: store,
                    level: automationSnapshots.isEmpty ? .success : .info,
                    message: "Incremental sync checked \(summary.snapshots.count) items; new assigned=\(newSnapshots.count), repair candidates=\(repairSnapshots.count)."
                )
                await processNewSnapshots(automationSnapshots, store: store, settings: store.settingsSnapshot.remoteSync, stateStore: stateStore)
            }

            updateBackgroundSettings(
                store: store,
                checkedAt: summary.syncedAt,
                message: backgroundMessage(summary: summary, baseline: isBaseline, fullReconcile: isFullReconcile),
                errorMessage: nil,
                snapshots: summary.snapshots,
                advanceWatermark: settings.provider == .jira && !summary.reachedLimit
            )
            NSLog(
                "[TaskBackgroundSync] poll complete project=\(store.projectId.uuidString) " +
                "count=\(summary.snapshots.count) created=\(summary.createdCount) updated=\(summary.updatedCount) " +
                "reachedLimit=\(summary.reachedLimit)"
            )
            recordActivity(
                store: store,
                level: .success,
                message: "Poll complete. fetched=\(summary.snapshots.count), added=\(summary.createdCount), updated=\(summary.updatedCount), limit=\(summary.reachedLimit ? "hit" : "ok")."
            )
        } catch {
            updateBackgroundSettings(
                store: store,
                checkedAt: Date(),
                message: "Background sync failed: \(error.localizedDescription)",
                errorMessage: error.localizedDescription,
                snapshots: [],
                advanceWatermark: false
            )
            NSLog("[TaskBackgroundSync] poll failed project=\(store.projectId.uuidString) error=\(error)")
            recordActivity(
                store: store,
                level: .error,
                message: "Poll failed: \(error.localizedDescription)"
            )
        }
    }

    private func processNewSnapshots(
        _ snapshots: [RemoteWorkItemSnapshot],
        store: TaskBoardStore,
        settings: TaskRemoteSyncSettings,
        stateStore: TaskAutomationStateStore
    ) async {
        guard !snapshots.isEmpty else { return }
        NSLog("[TaskAutomation] new assigned count=\(snapshots.count) project=\(store.projectId.uuidString)")
        for snapshot in snapshots {
            let storageKey = snapshot.reference.storageKey
            stateStore.markTaskCreated(storageKey: storageKey)
            recordActivity(
                store: store,
                level: .info,
                message: "New assigned task claimed.",
                remoteKey: snapshot.reference.key
            )

            guard settings.isAutoCreateWorktreeEnabled || settings.isAutoExecuteEnabled else {
                recordActivity(
                    store: store,
                    level: .warning,
                    message: "Automation toggles are off; task was synced only.",
                    remoteKey: snapshot.reference.key
                )
                continue
            }
            guard let localTask = task(for: snapshot, store: store) else {
                stateStore.markFailed(storageKey: storageKey, message: "Local task was not found after sync.")
                recordActivity(
                    store: store,
                    level: .error,
                    message: "Local task was not found after sync.",
                    remoteKey: snapshot.reference.key
                )
                continue
            }

            if settings.isAutoCreateWorktreeEnabled {
                do {
                    let lifecycle = TaskLifecycleCoordinator.makeForProject(store: store)
                    if localTask.workspaceId == nil {
                        NSLog("[TaskAutomation] auto worktree start task=\(localTask.id.uuidString) remote=\(snapshot.reference.key)")
                        recordActivity(
                            store: store,
                            level: .info,
                            message: "Creating worktree from project HEAD.",
                            remoteKey: snapshot.reference.key
                        )
                        try await lifecycle.bindWorktree(taskId: localTask.id, allowDirty: true)
                    }
                    stateStore.markWorktreeStarted(storageKey: storageKey)
                    recordActivity(
                        store: store,
                        level: .success,
                        message: "Worktree ready.",
                        remoteKey: snapshot.reference.key
                    )
                } catch {
                    stateStore.markFailed(storageKey: storageKey, message: "Auto worktree failed: \(error.localizedDescription)")
                    NSLog("[TaskAutomation] auto worktree failed remote=\(snapshot.reference.key) error=\(error)")
                    recordActivity(
                        store: store,
                        level: .error,
                        message: "Auto worktree failed: \(error.localizedDescription)",
                        remoteKey: snapshot.reference.key
                    )
                    continue
                }
            }

            guard settings.isAutoExecuteEnabled else {
                recordActivity(
                    store: store,
                    level: .info,
                    message: "Auto-execute is off; stopping after worktree.",
                    remoteKey: snapshot.reference.key
                )
                continue
            }
            guard hasAutoAgentCapacity(settings: settings) else {
                NSLog("[TaskAutomation] auto execute skipped concurrency remote=\(snapshot.reference.key)")
                recordActivity(
                    store: store,
                    level: .warning,
                    message: "Auto-execute skipped; global auto-agent capacity is full (\(settings.autoExecuteMaxConcurrentAgents)).",
                    remoteKey: snapshot.reference.key
                )
                continue
            }

            do {
                let refreshedTask = task(for: snapshot, store: store) ?? localTask
                let taskFilePath = try ensureTaskFilePath(task: refreshedTask, store: store)
                recordActivity(
                    store: store,
                    level: .info,
                    message: "Launching agent.",
                    remoteKey: snapshot.reference.key
                )
                let workspaceId = try await TaskAgentLaunchCoordinator.ensureWorktreeAndLaunch(
                    store: store,
                    request: TaskAgentLaunchRequest(
                        taskId: refreshedTask.id,
                        agentId: settings.autoExecuteAgentId,
                        templateId: settings.autoExecuteTemplateId,
                        permissionMode: settings.resolvedAutoExecutePermissionMode,
                        variableValues: [
                            "task_title": refreshedTask.title,
                            "task_file_path": taskFilePath,
                            "remote_key": snapshot.reference.key,
                            "remote_url": snapshot.reference.url ?? "",
                            "remote_status": snapshot.statusLabel ?? ""
                        ],
                        allowDirty: true,
                        reasonTag: "tasks.background.autoExecute"
                    )
                )
                autoAgentWorkspaceIds.insert(workspaceId)
                stateStore.markAgentStarted(storageKey: storageKey, workspaceId: workspaceId)
                recordActivity(
                    store: store,
                    level: .success,
                    message: "Agent launched in workspace \(workspaceId.uuidString.prefix(8)).",
                    remoteKey: snapshot.reference.key
                )
            } catch {
                stateStore.markFailed(storageKey: storageKey, message: "Auto execute failed: \(error.localizedDescription)")
                NSLog("[TaskAutomation] auto execute failed remote=\(snapshot.reference.key) error=\(error)")
                recordActivity(
                    store: store,
                    level: .error,
                    message: "Auto-execute failed: \(error.localizedDescription)",
                    remoteKey: snapshot.reference.key
                )
            }
        }
    }

    private func automationRepairSnapshots(
        _ snapshots: [RemoteWorkItemSnapshot],
        excluding claimedSnapshots: [RemoteWorkItemSnapshot],
        store: TaskBoardStore,
        settings: TaskRemoteSyncSettings,
        stateStore: TaskAutomationStateStore
    ) -> [RemoteWorkItemSnapshot] {
        guard settings.isAutoCreateWorktreeEnabled || settings.isAutoExecuteEnabled else { return [] }
        let claimedKeys = Set(claimedSnapshots.map { $0.reference.storageKey })
        let remoteStates = stateStore.snapshot.remotes
        return snapshots.filter { snapshot in
            let storageKey = snapshot.reference.storageKey
            guard !claimedKeys.contains(storageKey),
                  let remoteState = remoteStates[storageKey],
                  remoteState.taskCreatedAt != nil || remoteState.worktreeStartedAt != nil || remoteState.agentStartedAt != nil,
                  let localTask = task(for: snapshot, store: store) else {
                return false
            }
            let missingWorkspace = localTask.workspaceId == nil
            let missingPath = localTask.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
            return settings.isAutoCreateWorktreeEnabled && (missingWorkspace || missingPath)
        }
    }

    private func hasAutoAgentCapacity(settings: TaskRemoteSyncSettings) -> Bool {
        autoAgentWorkspaceIds = activeAutoAgentWorkspaceIds()
        return autoAgentWorkspaceIds.count < settings.autoExecuteMaxConcurrentAgents
    }

    private func activeAutoAgentWorkspaceIds() -> Set<UUID> {
        var workspaceIds = autoAgentWorkspaceIds
        for projectId in ProjectStore.shared.openProjectIds {
            guard let store = TaskBoardStoreProvider.shared.store(for: projectId) else { continue }
            let stateStore = TaskAutomationStateStoreProvider.store(projectRoot: store.projectRoot)
            for remoteState in stateStore.snapshot.remotes.values {
                guard remoteState.agentStartedAt != nil,
                      let workspaceId = remoteState.agentWorkspaceId else {
                    continue
                }
                workspaceIds.insert(workspaceId)
            }
        }
        return workspaceIds.filter { TaskAgentLaunchCoordinator.hasActiveAgent(workspaceId: $0) }
    }

    private func task(for snapshot: RemoteWorkItemSnapshot, store: TaskBoardStore) -> TaskRecord? {
        store.fileSnapshot().tasks.first { task in
            task.archivedAt == nil && task.remoteWorkItem?.representsSameRemoteItem(as: snapshot.reference) == true
        }
    }

    private func ensureTaskFilePath(task: TaskRecord, store: TaskBoardStore) throws -> String {
        if let path = task.taskFilePath?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty {
            return path
        }
        let lifecycle = TaskLifecycleCoordinator.makeForProject(store: store)
        return try lifecycle.ensureTaskSpecFile(taskId: task.id)
    }

    private func shouldRunFullReconcile(state: TaskAutomationStateFile) -> Bool {
        guard let last = state.lastFullReconcileAt else { return true }
        return Date().timeIntervalSince(last) >= fullReconcileInterval
    }

    private func backgroundMessage(
        summary: TaskAssignedSyncSummary,
        baseline: Bool,
        fullReconcile: Bool
    ) -> String {
        if baseline {
            if summary.reachedLimit {
                return "Background sync baseline recorded \(summary.snapshots.count) assigned work items, but limit was reached. Automation remains paused until a complete baseline finishes."
            }
            return "Background sync baseline recorded \(summary.snapshots.count) assigned work items."
        }
        if fullReconcile {
            return "Background full reconcile checked \(summary.snapshots.count) assigned work items."
        }
        let suffix = summary.reachedLimit
            ? " Limit reached; watermark was not advanced."
            : ""
        return "Background sync checked \(summary.snapshots.count) assigned work items. Added \(summary.createdCount), updated \(summary.updatedCount).\(suffix)"
    }

    private func updateBackgroundSettings(
        store: TaskBoardStore,
        checkedAt: Date,
        message: String,
        errorMessage: String?,
        snapshots: [RemoteWorkItemSnapshot],
        advanceWatermark: Bool
    ) {
        do {
            try store.updateSettings { settings in
                settings.remoteSync.backgroundLastCheckedAt = checkedAt
                settings.remoteSync.backgroundLastMessage = message
                let trimmedError = errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                settings.remoteSync.backgroundLastError = trimmedError.isEmpty ? nil : trimmedError
                if advanceWatermark,
                   let watermark = jiraWatermark(from: snapshots, checkedAt: checkedAt) {
                    settings.remoteSync.backgroundJiraWatermark = watermark
                }
            }
        } catch {
            NSLog("[TaskBackgroundSync] settings update failed project=\(store.projectId.uuidString) error=\(error)")
        }
    }

    private func recordActivity(
        store: TaskBoardStore,
        level: TaskBackgroundSyncActivityLevel,
        message: String,
        remoteKey: String? = nil
    ) {
        do {
            try store.updateSettings { settings in
                settings.remoteSync.backgroundActivityLog.insert(
                    TaskBackgroundSyncActivityEntry(
                        level: level,
                        message: message,
                        remoteKey: remoteKey
                    ),
                    at: 0
                )
                settings.remoteSync.backgroundActivityLog = TaskRemoteSyncSettings.trimmedBackgroundActivityLog(
                    settings.remoteSync.backgroundActivityLog
                )
            }
        } catch {
            NSLog("[TaskBackgroundSync] activity append failed project=\(store.projectId.uuidString) error=\(error)")
        }
    }

    private func jiraWatermark(from snapshots: [RemoteWorkItemSnapshot], checkedAt: Date) -> Date? {
        if let maxUpdated = snapshots.compactMap(\.providerUpdatedAt).max() {
            return maxUpdated
        }
        return checkedAt
    }

    private func nextDue(for projectId: UUID, settings: TaskRemoteSyncSettings) -> Date {
        if let cached = nextDueByProjectId[projectId] {
            return cached
        }
        let base = settings.backgroundLastCheckedAt ?? Date.distantPast
        let due = base.addingTimeInterval(settings.backgroundPollIntervalSeconds + jitter(for: settings))
        nextDueByProjectId[projectId] = due
        return due
    }

    private func scheduleNext(projectId: UUID, settings: TaskRemoteSyncSettings) {
        nextDueByProjectId[projectId] = Date().addingTimeInterval(settings.backgroundPollIntervalSeconds + jitter(for: settings))
    }

    private func jitter(for settings: TaskRemoteSyncSettings) -> TimeInterval {
        let spread = max(5, settings.backgroundPollIntervalSeconds * 0.20)
        return TimeInterval.random(in: 0...spread)
    }
}
