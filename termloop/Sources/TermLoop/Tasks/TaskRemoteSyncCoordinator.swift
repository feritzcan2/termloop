// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

public struct TaskRemoteJiraAccountOption: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let site: String
    public let email: String?
    public let displayName: String?
    public let isCurrent: Bool

    public init(site: String, email: String?, displayName: String?, isCurrent: Bool) {
        let normalizedSite = Self.normalizedSite(site) ?? site.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedEmail = email?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.site = normalizedSite
        self.email = normalizedEmail
        self.displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.isCurrent = isCurrent
        self.id = [normalizedSite, normalizedEmail ?? ""].joined(separator: "|")
    }

    public var displayLabel: String {
        let emailPart = email.map { " · \($0)" } ?? ""
        let currentPart = isCurrent ? " ✓" : ""
        return "\(site)\(emailPart)\(currentPart)"
    }

    private static func normalizedSite(_ value: String) -> String? {
        var site = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: site), let host = url.host {
            site = host
        }
        site = site
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return site.nilIfEmpty
    }
}

public struct TaskRemoteContainerOption: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let key: String
    public let name: String

    public init(key: String, name: String) {
        self.id = key
        self.key = key
        self.name = name
    }

    public var displayLabel: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? key : "\(key) — \(name)"
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

public struct TaskRemoteStatusOption: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let label: String

    public init(_ label: String) {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        self.label = trimmed
        self.id = trimmed.lowercased()
    }
}

public struct TaskRemoteCLIStatus: Equatable, Sendable {
    public let provider: RemoteWorkItemProviderId
    public let executable: String
    public let isChecking: Bool
    public let isAvailable: Bool
    public let summary: String
    public let detail: String?
    public let checkedAt: Date?

    public init(
        provider: RemoteWorkItemProviderId,
        executable: String,
        isChecking: Bool = false,
        isAvailable: Bool = false,
        summary: String,
        detail: String? = nil,
        checkedAt: Date? = nil
    ) {
        self.provider = provider
        self.executable = executable
        self.isChecking = isChecking
        self.isAvailable = isAvailable
        self.summary = summary
        self.detail = detail
        self.checkedAt = checkedAt
    }
}

private struct TaskRemoteMetadataCacheEntry<Value: Codable>: Codable {
    var value: Value
    var updatedAt: Date
}

private struct TaskRemoteMetadataCacheFile: Codable {
    var jiraAccounts: TaskRemoteMetadataCacheEntry<[TaskRemoteJiraAccountOption]>?
    var containers: [String: TaskRemoteMetadataCacheEntry<[TaskRemoteContainerOption]>] = [:]
    var statuses: [String: TaskRemoteMetadataCacheEntry<[String]>] = [:]
}

@MainActor
public final class TaskRemoteSyncCoordinator: ObservableObject {
    @Published public private(set) var isSyncing: Bool = false
    @Published public private(set) var isLoadingJiraAccounts: Bool = false
    @Published public private(set) var isLoadingContainers: Bool = false
    @Published public private(set) var isLoadingStatuses: Bool = false
    @Published public private(set) var jiraAccountOptions: [TaskRemoteJiraAccountOption] = []
    @Published public private(set) var containerOptions: [TaskRemoteContainerOption] = []
    @Published public private(set) var remoteStatusOptions: [TaskRemoteStatusOption] = []
    @Published public private(set) var cliStatuses: [RemoteWorkItemProviderId: TaskRemoteCLIStatus] = [:]
    @Published public private(set) var lastMessage: String?

    private let store: TaskBoardStore
    private var syncTask: Task<Void, Never>?
    private var cliStatusTask: Task<Void, Never>?
    private var syncColumnsAfterLoadingStatuses = false

    public init(store: TaskBoardStore) {
        self.store = store
    }

    deinit {
        syncTask?.cancel()
        cliStatusTask?.cancel()
    }

    public var settings: TaskRemoteSyncSettings {
        store.settingsSnapshot.remoteSync
    }

    public var boardSettings: TaskBoardSettings {
        store.settingsSnapshot
    }

    public var enabledColumnCount: Int {
        boardSettings.columns.filter(\.isEnabled).count
    }

    public var settingsVisibleColumns: [TaskColumnSettings] {
        boardSettings.columns.filter { column in
            column.isEnabled || store.columnHasActiveTasks(column.columnId)
        }
    }

    public func columnSettings(_ columnId: TaskColumnId) -> TaskColumnSettings {
        store.columnSettings(for: columnId)
    }

    public func columnHasActiveTasks(_ columnId: TaskColumnId) -> Bool {
        store.columnHasActiveTasks(columnId)
    }

    public func prepareRemoteSettings() {
        hydrateRemoteMetadataFromCache()
        loadCLIStatusesIfNeeded()
        if jiraAccountOptions.isEmpty {
            let localOptions = Self.parseJiraAccountsConfig()
            if !localOptions.isEmpty {
                jiraAccountOptions = localOptions
                applyDefaultJiraAccountIfNeeded(localOptions)
                persistJiraAccountsToCache(localOptions)
            }
        }
        syncIfEnabledOnAppear()
    }

    public func cliStatus(for provider: RemoteWorkItemProviderId) -> TaskRemoteCLIStatus {
        cliStatuses[provider] ?? TaskRemoteCLIStatus(
            provider: provider,
            executable: Self.cliExecutable(for: provider),
            summary: String(localized: "tasks.settings.remote.cli.notChecked",
                            defaultValue: "Not checked",
                            table: "TermLoop")
        )
    }

    public func setProvider(_ provider: RemoteWorkItemProviderId) {
        let oldProvider = settings.provider
        guard oldProvider != provider else { return }
        do {
            try store.updateSettings { settings in
                if let currentContainer = settings.remoteSync.container?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty {
                    settings.remoteSync.providerContainers[oldProvider] = currentContainer
                }
                settings.remoteSync.provider = provider
                settings.remoteSync.container = settings.remoteSync.providerContainers[provider]
                settings.remoteSync.lastError = nil
            }
            objectWillChange.send()
            hydrateRemoteMetadataFromCache()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func setSyncAssignedToMe(_ enabled: Bool) {
        do {
            try store.updateSettings { settings in
                settings.remoteSync.syncAssignedToMe = enabled
                if enabled {
                    settings.remoteSync.lastError = nil
                }
            }
            objectWillChange.send()
        } catch {
            lastMessage = String(describing: error)
        }
        if enabled {
            syncAssignedToMe(reason: "tasks.settings.toggle")
        }
    }

    public func setContainer(_ value: String) {
        do {
            try store.updateSettings { settings in
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                let container = trimmed.isEmpty ? nil : trimmed
                settings.remoteSync.container = container
                if let container {
                    settings.remoteSync.providerContainers[settings.remoteSync.provider] = container
                } else {
                    settings.remoteSync.providerContainers.removeValue(forKey: settings.remoteSync.provider)
                }
                settings.remoteSync.lastError = nil
            }
            objectWillChange.send()
            hydrateRemoteMetadataFromCache()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func setJiraSite(_ value: String) {
        do {
            try store.updateSettings { settings in
                settings.remoteSync.jiraSite = Self.normalizedJiraSite(value)
                settings.remoteSync.lastError = nil
            }
            objectWillChange.send()
            hydrateRemoteMetadataFromCache()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func setJiraEmail(_ value: String) {
        do {
            try store.updateSettings { settings in
                settings.remoteSync.jiraEmail = value
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty
                settings.remoteSync.lastError = nil
            }
            objectWillChange.send()
            hydrateRemoteMetadataFromCache()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func selectJiraAccount(_ optionId: String) {
        guard let option = jiraAccountOptions.first(where: { $0.id == optionId }) else { return }
        do {
            try store.updateSettings { settings in
                settings.remoteSync.jiraSite = option.site
                settings.remoteSync.jiraEmail = option.email
                settings.remoteSync.lastError = nil
            }
            objectWillChange.send()
            hydrateRemoteMetadataFromCache()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func setSyncColumnMovesToRemote(_ enabled: Bool) {
        do {
            try store.updateSettings { settings in
                settings.remoteSync.syncColumnMovesToRemote = enabled
            }
            objectWillChange.send()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func setColumnTitle(_ columnId: TaskColumnId, title: String) {
        do {
            try store.updateSettings { settings in
                settings.columns = updateColumn(settings.columns, columnId: columnId) { column in
                    column.title = title
                }
            }
            objectWillChange.send()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func setColumnRemoteStatus(_ columnId: TaskColumnId, status: String) {
        do {
            try store.updateSettings { settings in
                settings.columns = updateColumn(settings.columns, columnId: columnId) { column in
                    let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
                    column.remoteStatusLabel = trimmed.isEmpty ? nil : trimmed
                }
            }
            objectWillChange.send()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func addColumn(title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let columnId = TaskColumnId.fromRemoteStatus(trimmed)
        do {
            try store.updateSettings { settings in
                var columns = TaskBoardSettings.normalizedColumns(settings.columns)
                if let idx = columns.firstIndex(where: { $0.columnId == columnId }) {
                    columns[idx].title = trimmed
                    columns[idx].isEnabled = true
                } else {
                    columns.append(TaskColumnSettings(
                        columnId: columnId,
                        title: trimmed,
                        isEnabled: true,
                        remoteStatusLabel: nil
                    ))
                }
                settings.columns = TaskBoardSettings.normalizedColumns(columns)
            }
            objectWillChange.send()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func deleteColumn(_ columnId: TaskColumnId) {
        guard columnId != .backlog else { return }
        do {
            try store.updateSettings { settings in
                settings.columns = settings.columns.map { column in
                    guard column.columnId == columnId else { return column }
                    var copy = column
                    copy.isEnabled = false
                    return copy
                }
            }
            objectWillChange.send()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func syncRemoteStatusesToColumns() {
        let statuses = remoteStatusOptions.map(\.label).filter { !$0.isEmpty }
        guard !statuses.isEmpty else {
            syncColumnsAfterLoadingStatuses = true
            loadRemoteStatusOptions()
            return
        }
        applyRemoteStatusesToColumns(statuses)
    }

    public func syncIfEnabledOnAppear() {
        guard settings.syncAssignedToMe else { return }
        if let last = settings.lastSyncedAt, Date().timeIntervalSince(last) < 600 {
            return
        }
        syncAssignedToMe(reason: "tasks.settings.appear")
    }

    public func loadJiraAccountOptionsIfNeeded() {
        guard jiraAccountOptions.isEmpty else { return }
        if let cached = readMetadataCache().jiraAccounts?.value, !cached.isEmpty {
            jiraAccountOptions = cached
            return
        }
        let localOptions = Self.parseJiraAccountsConfig()
        if !localOptions.isEmpty {
            jiraAccountOptions = localOptions
            persistJiraAccountsToCache(localOptions)
        }
    }

    public func loadJiraAccountOptions() {
        guard !isLoadingJiraAccounts else { return }
        isLoadingJiraAccounts = true
        Task(priority: .utility) { [weak self] in
            let options = await Self.discoverJiraAccounts()
            await MainActor.run {
                self?.jiraAccountOptions = options
                self?.isLoadingJiraAccounts = false
                self?.applyDefaultJiraAccountIfNeeded(options)
                self?.persistJiraAccountsToCache(options)
            }
        }
    }

    public func loadContainerOptionsIfNeeded() {
        guard containerOptions.isEmpty else { return }
        hydrateRemoteMetadataFromCache()
    }

    public func loadRemoteStatusOptionsIfNeeded() {
        guard remoteStatusOptions.isEmpty else { return }
        hydrateRemoteMetadataFromCache()
    }

    public func loadContainerOptions() {
        guard !isLoadingContainers else { return }
        isLoadingContainers = true
        let syncSettings = settings
        Task(priority: .utility) { [weak self] in
            do {
                let options = try await Self.fetchContainerOptions(settings: syncSettings)
                await MainActor.run {
                    self?.containerOptions = options
                    self?.isLoadingContainers = false
                    self?.persistContainerOptionsToCache(options, settings: syncSettings)
                }
            } catch {
                await MainActor.run {
                    self?.containerOptions = []
                    self?.isLoadingContainers = false
                    self?.lastMessage = Self.humanError(error)
                }
            }
        }
    }

    public func loadRemoteStatusOptions() {
        guard !isLoadingStatuses else { return }
        isLoadingStatuses = true
        let syncSettings = settings
        Task(priority: .utility) { [weak self] in
            do {
                let labels = try await Self.fetchRemoteStatusLabels(settings: syncSettings)
                await MainActor.run {
                    self?.remoteStatusOptions = labels.map(TaskRemoteStatusOption.init)
                    self?.isLoadingStatuses = false
                    self?.persistStatusLabelsToCache(labels, settings: syncSettings)
                    self?.syncPendingColumnsIfNeeded(labels)
                }
            } catch {
                await MainActor.run {
                    let labels = Self.defaultStatusLabels(for: syncSettings.provider)
                    self?.remoteStatusOptions = labels.map(TaskRemoteStatusOption.init)
                    self?.isLoadingStatuses = false
                    self?.lastMessage = Self.humanError(error)
                    self?.syncPendingColumnsIfNeeded(labels)
                }
            }
        }
    }

    public func syncAssignedToMe(reason: String = "tasks.settings.syncNow") {
        guard !isSyncing else { return }
        let syncSettings = settings
        let request = RemoteWorkItemListRequest(
            provider: syncSettings.provider,
            container: syncSettings.container,
            limit: syncSettings.limit
        )

        isSyncing = true
        lastMessage = nil
        syncTask?.cancel()
        syncTask = Task(priority: .utility) { [weak self] in
            do {
                let service = Self.makeRemoteWorkItemService(settings: syncSettings)
                let snapshots = try await service.listAssignedToMe(request)
                try Task.checkCancellation()
                await MainActor.run {
                    self?.applyAssignedSnapshots(snapshots, reason: reason)
                }
            } catch {
                await MainActor.run {
                    self?.finishSync(error: error)
                }
            }
        }
    }

    public func link(taskId: UUID, rawInput: String) {
        let input = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return }
        guard let reference = RemoteWorkItemParser.parse(input) else {
            lastMessage = String(localized: "tasks.remoteSync.link.invalid",
                                 defaultValue: "Could not parse work item link.",
                                 table: "TermLoop")
            return
        }

        isSyncing = true
        lastMessage = nil
        let syncSettings = settings
        syncTask?.cancel()
        syncTask = Task(priority: .utility) { [weak self] in
            do {
                let service = Self.makeRemoteWorkItemService(settings: syncSettings)
                let snapshot = try await service.fetch(reference)
                try Task.checkCancellation()
                await MainActor.run {
                    self?.applyLinkedSnapshot(snapshot, taskId: taskId)
                }
            } catch {
                await MainActor.run {
                    self?.finishSync(error: error)
                }
            }
        }
    }

    public func refresh(taskId: UUID) {
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }),
              let reference = task.remoteWorkItem else {
            return
        }
        isSyncing = true
        lastMessage = nil
        let syncSettings = settings
        syncTask?.cancel()
        syncTask = Task(priority: .utility) { [weak self] in
            do {
                let service = Self.makeRemoteWorkItemService(settings: syncSettings)
                let snapshot = try await service.fetch(reference)
                try Task.checkCancellation()
                await MainActor.run {
                    self?.applyLinkedSnapshot(snapshot, taskId: taskId)
                }
            } catch {
                await MainActor.run {
                    self?.finishSync(error: error)
                }
            }
        }
    }

    public func maybePromptRemoteStatusSync(taskId: UUID, to columnId: TaskColumnId) {
        let syncSettings = store.settingsSnapshot
        guard syncSettings.remoteSync.syncColumnMovesToRemote else { return }
        guard let targetStatus = syncSettings.columns
            .first(where: { $0.columnId == columnId })?
            .remoteStatusLabel?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !targetStatus.isEmpty else {
            return
        }
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }),
              let reference = task.remoteWorkItem else {
            return
        }

        isSyncing = true
        lastMessage = nil
        let remoteSettings = syncSettings.remoteSync
        Task(priority: .utility) { [weak self] in
            do {
                let service = Self.makeRemoteWorkItemService(settings: remoteSettings)
                let options = try await service.availableStatuses(reference)
                guard let option = Self.matchingStatusOption(
                    in: options,
                    targetStatus: targetStatus
                ) else {
                    await MainActor.run {
                        self?.isSyncing = false
                    }
                    return
                }
                let shouldSync = await MainActor.run {
                    Self.confirmRemoteStatusSync(
                        reference: reference,
                        targetStatus: option.label
                    )
                }
                guard shouldSync else {
                    await MainActor.run {
                        self?.isSyncing = false
                    }
                    return
                }
                let snapshot = try await service.updateStatus(
                    reference,
                    to: option,
                    projectRoot: nil
                )
                try Task.checkCancellation()
                await MainActor.run {
                    self?.applyLinkedSnapshot(snapshot, taskId: taskId)
                }
            } catch {
                await MainActor.run {
                    self?.finishSync(error: error)
                }
            }
        }
    }

    private func applyDefaultJiraAccountIfNeeded(_ options: [TaskRemoteJiraAccountOption]) {
        guard let option = options.first(where: \.isCurrent) ?? options.first else { return }
        let current = settings
        guard current.jiraSite?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty == nil,
              current.jiraEmail?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty == nil else {
            return
        }
        do {
            try store.updateSettings { settings in
                settings.remoteSync.jiraSite = option.site
                settings.remoteSync.jiraEmail = option.email
                settings.remoteSync.lastError = nil
            }
            objectWillChange.send()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    private func applyAssignedSnapshots(_ snapshots: [RemoteWorkItemSnapshot], reason: String) {
        let now = Date()
        var materializeInputs: [(taskId: UUID, snapshot: RemoteWorkItemSnapshot)] = []

        let changed = store.mutate { file in
            var didChange = false
            let oldSettings = file.settings.remoteSync
            var rankCursor = file.tasks
                .filter { $0.columnId == .backlog && $0.archivedAt == nil }
                .map(\.rank)
                .sorted()
                .last ?? TaskRanking.initial()

            for snapshot in snapshots {
                let storageKey = snapshot.reference.storageKey
                if let idx = file.tasks.firstIndex(where: { task in
                    task.archivedAt == nil && task.remoteWorkItem?.storageKey == storageKey
                }) {
                    let old = file.tasks[idx]
                    update(&file.tasks[idx], with: snapshot, syncedAt: now)
                    didChange = didChange || file.tasks[idx] != old
                    materializeInputs.append((file.tasks[idx].id, snapshot))
                } else {
                    let rank: String
                    if file.tasks.contains(where: { $0.columnId == .backlog && $0.archivedAt == nil }) {
                        rank = TaskRanking.after(rankCursor)
                    } else {
                        rank = rankCursor
                    }
                    rankCursor = rank
                    let task = TaskRecord(
                        projectId: store.projectId,
                        title: snapshot.title,
                        brief: nil,
                        remoteWorkItem: snapshot.reference,
                        remoteStatusLabel: snapshot.statusLabel,
                        lastRemoteSyncAt: now,
                        columnId: .backlog,
                        rank: rank
                    )
                    file.tasks.append(task)
                    materializeInputs.append((task.id, snapshot))
                    didChange = true
                }
            }

            if didChange {
                _ = TaskBoardStore.rebalanceColumnIfNeeded(.backlog, in: &file)
            }
            file.settings.remoteSync.lastSyncedAt = now
            file.settings.remoteSync.lastError = nil
            return didChange || file.settings.remoteSync != oldSettings
        }

        materialize(materializeInputs)
        if changed || !materializeInputs.isEmpty {
            do { try store.saveNow() } catch { lastMessage = String(describing: error) }
        }
        finishSync(message: String(
            localized: "tasks.remoteSync.synced",
            defaultValue: "Synced \(snapshots.count) assigned work items.",
            table: "TermLoop"
        ))
        NSLog("[Tasks] assigned-to-me sync applied count=\(snapshots.count) reason=\(reason)")
    }

    private func applyLinkedSnapshot(_ snapshot: RemoteWorkItemSnapshot, taskId: UUID) {
        let now = Date()
        var shouldMaterialize = false
        do {
            store.mutate { file in
                guard let idx = file.tasks.firstIndex(where: { $0.id == taskId }) else { return false }
                let old = file.tasks[idx]
                update(&file.tasks[idx], with: snapshot, syncedAt: now)
                shouldMaterialize = true
                return file.tasks[idx] != old
            }
            if shouldMaterialize {
                materialize([(taskId, snapshot)])
            }
            try store.saveNow()
            finishSync(message: String(localized: "tasks.remoteSync.linked",
                                       defaultValue: "Linked work item.",
                                       table: "TermLoop"))
        } catch {
            finishSync(error: error)
        }
    }

    private func update(_ task: inout TaskRecord, with snapshot: RemoteWorkItemSnapshot, syncedAt: Date) {
        task.title = snapshot.title
        task.remoteWorkItem = snapshot.reference
        task.remoteStatusLabel = snapshot.statusLabel
        task.lastRemoteSyncAt = syncedAt
        task.updatedAt = syncedAt
    }

    private func materialize(_ inputs: [(taskId: UUID, snapshot: RemoteWorkItemSnapshot)]) {
        guard !inputs.isEmpty else { return }
        var pathsById: [UUID: String] = [:]
        for input in inputs {
            do {
                pathsById[input.taskId] = try TaskMarkdownFileWriter.writeRemoteSnapshot(
                    input.snapshot,
                    taskId: input.taskId,
                    projectRoot: store.projectRoot
                )
            } catch {
                lastMessage = String(describing: error)
            }
        }
        guard !pathsById.isEmpty else { return }
        _ = store.mutate { file in
            var changed = false
            for idx in file.tasks.indices {
                guard let path = pathsById[file.tasks[idx].id],
                      file.tasks[idx].taskFilePath != path else { continue }
                file.tasks[idx].taskFilePath = path
                file.tasks[idx].updatedAt = Date()
                changed = true
            }
            return changed
        }
    }

    private func finishSync(message: String) {
        isSyncing = false
        lastMessage = message
    }

    private func finishSync(error: Error) {
        isSyncing = false
        let message = String(describing: error)
        lastMessage = message
        do {
            try store.updateSettings { settings in
                settings.remoteSync.lastError = message
            }
        } catch {
            lastMessage = String(describing: error)
        }
    }

    private func syncPendingColumnsIfNeeded(_ labels: [String]) {
        guard syncColumnsAfterLoadingStatuses else { return }
        syncColumnsAfterLoadingStatuses = false
        applyRemoteStatusesToColumns(labels)
    }

    private func applyRemoteStatusesToColumns(_ statuses: [String]) {
        let effectiveStatuses = statuses
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !effectiveStatuses.isEmpty else { return }

        do {
            try store.updateSettings { settings in
                var columns = TaskBoardSettings.normalizedColumns(settings.columns)
                for status in effectiveStatuses {
                    let id = TaskColumnId.fromRemoteStatus(status)
                    if let idx = columns.firstIndex(where: { $0.columnId == id }) {
                        columns[idx].isEnabled = true
                        columns[idx].remoteStatusLabel = status
                        if columns[idx].title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                            columns[idx].title == columns[idx].columnId.defaultTitle {
                            columns[idx].title = status
                        }
                    } else {
                        columns.append(TaskColumnSettings(
                            columnId: id,
                            title: status,
                            isEnabled: true,
                            remoteStatusLabel: status
                        ))
                    }
                }
                settings.columns = TaskBoardSettings.normalizedColumns(columns)
            }
            lastMessage = String(localized: "tasks.settings.columns.syncedRemoteStatuses",
                                 defaultValue: "Remote statuses synced to columns.",
                                 table: "TermLoop")
            objectWillChange.send()
            syncLinkedTaskColumnsToRemoteStatuses()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    private func syncLinkedTaskColumnsToRemoteStatuses() {
        guard !isSyncing else { return }
        let linkedTasks = store.fileSnapshot().tasks.compactMap { task -> (taskId: UUID, reference: RemoteWorkItemReference)? in
            guard task.archivedAt == nil, let reference = task.remoteWorkItem else { return nil }
            return (task.id, reference)
        }
        guard !linkedTasks.isEmpty else { return }

        let syncSettings = settings
        isSyncing = true
        syncTask?.cancel()
        syncTask = Task(priority: .utility) { [weak self] in
            let service = Self.makeRemoteWorkItemService(settings: syncSettings)
            var snapshots: [(taskId: UUID, snapshot: RemoteWorkItemSnapshot)] = []
            var failureCount = 0
            for linkedTask in linkedTasks {
                do {
                    let snapshot = try await service.fetch(linkedTask.reference)
                    try Task.checkCancellation()
                    snapshots.append((linkedTask.taskId, snapshot))
                } catch is CancellationError {
                    return
                } catch {
                    failureCount += 1
                }
            }
            await MainActor.run {
                self?.applyLinkedStatusSnapshots(snapshots, failureCount: failureCount)
            }
        }
    }

    private func applyLinkedStatusSnapshots(
        _ snapshots: [(taskId: UUID, snapshot: RemoteWorkItemSnapshot)],
        failureCount: Int
    ) {
        let now = Date()
        var updatedCount = 0
        var movedCount = 0
        var unmappedCount = 0

        do {
            let changed = store.mutate { file in
                let columnByRemoteStatus = Self.remoteStatusColumnLookup(file.settings.columns)
                var rankCursorByColumn = Self.lastRankByColumn(file.tasks)
                var touchedColumns = Set<TaskColumnId>()
                var didChange = false

                for item in snapshots {
                    guard let idx = file.tasks.firstIndex(where: {
                        $0.id == item.taskId && $0.archivedAt == nil
                    }) else {
                        continue
                    }

                    let old = file.tasks[idx]
                    let statusLabel = item.snapshot.statusLabel?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                        .nilIfEmpty
                    file.tasks[idx].remoteWorkItem = item.snapshot.reference
                    file.tasks[idx].remoteStatusLabel = statusLabel
                    file.tasks[idx].lastRemoteSyncAt = now

                    if let statusKey = Self.remoteStatusLookupKey(statusLabel),
                       let targetColumn = columnByRemoteStatus[statusKey] {
                        if file.tasks[idx].columnId != targetColumn {
                            file.tasks[idx].columnId = targetColumn
                            let nextRank = rankCursorByColumn[targetColumn]
                                .map(TaskRanking.after)
                                ?? TaskRanking.initial()
                            file.tasks[idx].rank = nextRank
                            rankCursorByColumn[targetColumn] = nextRank
                            touchedColumns.insert(targetColumn)
                            movedCount += 1
                        }
                    } else if statusLabel != nil {
                        unmappedCount += 1
                    }

                    if file.tasks[idx] != old {
                        file.tasks[idx].updatedAt = now
                        updatedCount += 1
                        didChange = true
                    }
                }

                for columnId in touchedColumns {
                    didChange = TaskBoardStore.rebalanceColumnIfNeeded(columnId, in: &file) || didChange
                }

                file.settings.remoteSync.lastError = nil
                return didChange
            }

            if changed {
                try store.saveNow()
            }
            let failureSuffix = failureCount > 0 ? " \(failureCount) failed." : ""
            let unmappedSuffix = unmappedCount > 0 ? " \(unmappedCount) had no mapped local column." : ""
            finishSync(message: String(
                localized: "tasks.settings.columns.syncedRemoteStatusesWithTasks",
                defaultValue: "Remote statuses synced. Updated \(updatedCount) linked tasks, moved \(movedCount).\(unmappedSuffix)\(failureSuffix)",
                table: "TermLoop"
            ))
        } catch {
            finishSync(error: error)
        }
    }

    private static func remoteStatusColumnLookup(_ columns: [TaskColumnSettings]) -> [String: TaskColumnId] {
        var lookup: [String: TaskColumnId] = [:]
        for column in TaskBoardSettings.normalizedColumns(columns) {
            guard let key = remoteStatusLookupKey(column.remoteStatusLabel) else { continue }
            lookup[key] = column.columnId
        }
        return lookup
    }

    private static func remoteStatusLookupKey(_ value: String?) -> String? {
        value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty?
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .lowercased()
    }

    private static func lastRankByColumn(_ tasks: [TaskRecord]) -> [TaskColumnId: String] {
        var result: [TaskColumnId: String] = [:]
        for task in tasks where task.archivedAt == nil {
            if let existing = result[task.columnId] {
                if existing < task.rank {
                    result[task.columnId] = task.rank
                }
            } else {
                result[task.columnId] = task.rank
            }
        }
        return result
    }

    private func updateColumn(
        _ columns: [TaskColumnSettings],
        columnId: TaskColumnId,
        mutate: (inout TaskColumnSettings) -> Void
    ) -> [TaskColumnSettings] {
        var normalized = TaskBoardSettings.normalizedColumns(columns)
        guard let idx = normalized.firstIndex(where: { $0.columnId == columnId }) else {
            return normalized
        }
        mutate(&normalized[idx])
        return TaskBoardSettings.normalizedColumns(normalized)
    }

    private static func matchingStatusOption(
        in options: [RemoteWorkItemStatusOption],
        targetStatus: String
    ) -> RemoteWorkItemStatusOption? {
        let target = targetStatus.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return nil }
        return options.first { option in
            [option.label, option.targetState]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .contains { $0.compare(target, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }
        }
    }

    private func hydrateRemoteMetadataFromCache() {
        let cache = readMetadataCache()
        if let accounts = cache.jiraAccounts?.value, !accounts.isEmpty {
            jiraAccountOptions = accounts
        }
        containerOptions = cache.containers[Self.containerCacheKey(settings)]?.value ?? []
        if let labels = cache.statuses[Self.statusCacheKey(settings)]?.value {
            remoteStatusOptions = labels.map(TaskRemoteStatusOption.init)
        } else if settings.provider != .jira {
            remoteStatusOptions = Self.defaultStatusLabels(for: settings.provider).map(TaskRemoteStatusOption.init)
        } else {
            remoteStatusOptions = []
        }
    }

    private func persistJiraAccountsToCache(_ options: [TaskRemoteJiraAccountOption]) {
        var cache = readMetadataCache()
        cache.jiraAccounts = TaskRemoteMetadataCacheEntry(value: options, updatedAt: Date())
        writeMetadataCache(cache)
    }

    private func persistContainerOptionsToCache(_ options: [TaskRemoteContainerOption], settings: TaskRemoteSyncSettings) {
        var cache = readMetadataCache()
        cache.containers[Self.containerCacheKey(settings)] = TaskRemoteMetadataCacheEntry(value: options, updatedAt: Date())
        writeMetadataCache(cache)
    }

    private func persistStatusLabelsToCache(_ labels: [String], settings: TaskRemoteSyncSettings) {
        var cache = readMetadataCache()
        cache.statuses[Self.statusCacheKey(settings)] = TaskRemoteMetadataCacheEntry(value: labels, updatedAt: Date())
        writeMetadataCache(cache)
    }

    private func readMetadataCache() -> TaskRemoteMetadataCacheFile {
        guard let data = try? Data(contentsOf: metadataCacheURL()),
              let cache = try? JSONDecoder.tasks.decode(TaskRemoteMetadataCacheFile.self, from: data) else {
            return TaskRemoteMetadataCacheFile()
        }
        return cache
    }

    private func writeMetadataCache(_ cache: TaskRemoteMetadataCacheFile) {
        let url = metadataCacheURL()
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let data = try JSONEncoder.tasks.encode(cache)
            try data.write(to: url, options: .atomic)
        } catch {
            #if DEBUG
            print("Task remote metadata cache write failed: \(error)")
            #endif
        }
    }

    private func metadataCacheURL() -> URL {
        store.projectRoot.appendingPathComponent(".termloop/remote-work-items-cache.json")
    }

    private static func containerCacheKey(_ settings: TaskRemoteSyncSettings) -> String {
        [settings.provider.rawValue, settings.jiraSite ?? "", settings.jiraEmail ?? ""]
            .joined(separator: "|")
    }

    private static func statusCacheKey(_ settings: TaskRemoteSyncSettings) -> String {
        [containerCacheKey(settings), settings.container ?? ""].joined(separator: "|")
    }

    public func loadCLIStatusesIfNeeded() {
        guard cliStatuses.count < RemoteWorkItemProviderId.allCases.count else { return }
        loadCLIStatuses()
    }

    public func loadCLIStatuses() {
        cliStatusTask?.cancel()
        for provider in RemoteWorkItemProviderId.allCases {
            cliStatuses[provider] = TaskRemoteCLIStatus(
                provider: provider,
                executable: Self.cliExecutable(for: provider),
                isChecking: true,
                isAvailable: cliStatuses[provider]?.isAvailable ?? false,
                summary: String(localized: "tasks.settings.remote.cli.checking",
                                defaultValue: "Checking…",
                                table: "TermLoop"),
                detail: cliStatuses[provider]?.detail,
                checkedAt: cliStatuses[provider]?.checkedAt
            )
        }
        cliStatusTask = Task(priority: .utility) { [weak self] in
            for provider in RemoteWorkItemProviderId.allCases {
                let status = await Self.probeCLIStatus(provider)
                await MainActor.run {
                    self?.cliStatuses[provider] = status
                }
            }
        }
    }

    private static func probeCLIStatus(_ provider: RemoteWorkItemProviderId) async -> TaskRemoteCLIStatus {
        let executable = cliExecutable(for: provider)
        do {
            let result = try await RemoteWorkItemCommandRunner.shared.run(
                executable: executable,
                arguments: ["--version"],
                cwd: nil,
                timeout: 4
            )
            let output = (result.stdout + "\n" + result.stderr)
                .split(separator: "\n")
                .map(String.init)
                .first?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard result.exitStatus == 0, !result.timedOut else {
                return TaskRemoteCLIStatus(
                    provider: provider,
                    executable: executable,
                    isAvailable: false,
                    summary: "\(executable) unavailable",
                    detail: commandFailureMessage(result, fallback: "Version check failed."),
                    checkedAt: Date()
                )
            }
            return TaskRemoteCLIStatus(
                provider: provider,
                executable: executable,
                isAvailable: true,
                summary: "\(executable) ready",
                detail: output,
                checkedAt: Date()
            )
        } catch {
            return TaskRemoteCLIStatus(
                provider: provider,
                executable: executable,
                isAvailable: false,
                summary: "\(executable) not found",
                detail: humanError(error),
                checkedAt: Date()
            )
        }
    }

    private static func cliExecutable(for provider: RemoteWorkItemProviderId) -> String {
        switch provider {
        case .jira: return "acli"
        case .github: return "gh"
        case .gitlab: return "glab"
        }
    }

    private static func makeRemoteWorkItemService(settings: TaskRemoteSyncSettings) -> RemoteWorkItemService {
        RemoteWorkItemService(
            providers: [
                JiraRemoteWorkItemProvider(
                    site: settings.jiraSite,
                    email: settings.jiraEmail
                ),
                GitHubRemoteWorkItemProvider(),
                GitLabRemoteWorkItemProvider()
            ]
        )
    }

    private static func fetchContainerOptions(settings: TaskRemoteSyncSettings) async throws -> [TaskRemoteContainerOption] {
        switch settings.provider {
        case .jira:
            do {
                let result = try await runAcliJira(
                    settings: settings,
                    arguments: ["jira", "project", "list", "--limit", "100", "--json"],
                    timeout: 20
                )
                guard result.exitStatus == 0, !result.timedOut else {
                    throw RemoteWorkItemError.commandFailed(commandFailureMessage(
                        result,
                        fallback: "Jira project list is unavailable. Enter the project key manually; sync can still work."
                    ))
                }
                return try parseProjectOptions(result.stdout)
            } catch {
                let projectListError = humanError(error)
                let fallback = try await runAcliJira(
                    settings: settings,
                    arguments: [
                        "jira", "workitem", "search",
                        "--jql", "assignee = currentUser() ORDER BY updated DESC",
                        "--limit", "100",
                        "--fields", "key,summary",
                        "--json"
                    ],
                    timeout: 20
                )
                guard fallback.exitStatus == 0, !fallback.timedOut else {
                    let fallbackError = commandFailureMessage(fallback, fallback: "Could not list assigned Jira work items.")
                    throw RemoteWorkItemError.commandFailed("Jira project list is unavailable: \(projectListError). Fallback also failed: \(fallbackError)")
                }
                let options = try parseProjectOptionsFromWorkItems(fallback.stdout)
                if options.isEmpty {
                    throw RemoteWorkItemError.commandFailed("Jira project list is unavailable: \(projectListError)")
                }
                return options
            }
        case .github:
            let result = try await RemoteWorkItemCommandRunner.shared.run(
                executable: "gh",
                arguments: ["repo", "list", "--limit", "100", "--json", "nameWithOwner,name"],
                cwd: nil,
                timeout: 20
            )
            guard result.exitStatus == 0, !result.timedOut else {
                throw RemoteWorkItemError.commandFailed(commandFailureMessage(result, fallback: "Could not list GitHub repositories."))
            }
            return try parseRepositoryOptions(result.stdout)
        case .gitlab:
            let result = try await RemoteWorkItemCommandRunner.shared.run(
                executable: "glab",
                arguments: ["repo", "list", "--per-page", "100", "--output", "json"],
                cwd: nil,
                timeout: 20
            )
            guard result.exitStatus == 0, !result.timedOut else {
                throw RemoteWorkItemError.commandFailed(commandFailureMessage(result, fallback: "Could not list GitLab projects. Enter group/project manually."))
            }
            return try parseRepositoryOptions(result.stdout)
        }
    }

    private static func fetchRemoteStatusLabels(settings: TaskRemoteSyncSettings) async throws -> [String] {
        switch settings.provider {
        case .jira:
            let selectedProject = settings.container?.trimmingCharacters(in: .whitespacesAndNewlines)
            let jql: String
            if let selectedProject, !selectedProject.isEmpty {
                jql = "project = \(selectedProject) ORDER BY updated DESC"
            } else {
                jql = "assignee = currentUser() ORDER BY updated DESC"
            }
            let result = try await runAcliJira(
                settings: settings,
                arguments: [
                    "jira", "workitem", "search",
                    "--jql", jql,
                    "--limit", "100",
                    "--fields", "status",
                    "--json"
                ],
                timeout: 20
            )
            guard result.exitStatus == 0, !result.timedOut else {
                throw RemoteWorkItemError.commandFailed(commandFailureMessage(result, fallback: "Could not list Jira statuses."))
            }
            return try parseStatusLabels(result.stdout)
        case .github, .gitlab:
            return defaultStatusLabels(for: settings.provider)
        }
    }

    private static func defaultStatusLabels(for provider: RemoteWorkItemProviderId) -> [String] {
        switch provider {
        case .jira:
            return defaultJiraStatuses
        case .github:
            return ["open", "closed"]
        case .gitlab:
            return ["opened", "closed"]
        }
    }

    private static func runAcliJira(
        settings: TaskRemoteSyncSettings,
        arguments: [String],
        timeout: TimeInterval
    ) async throws -> RemoteWorkItemCommandResult {
        try await switchJiraSiteIfConfigured(settings)
        return try await RemoteWorkItemCommandRunner.shared.run(
            executable: "acli",
            arguments: arguments,
            cwd: nil,
            timeout: timeout
        )
    }

    private static func switchJiraSiteIfConfigured(_ settings: TaskRemoteSyncSettings) async throws {
        guard let site = settings.jiraSite?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty else {
            return
        }
        var args = ["jira", "auth", "switch", "--site", site]
        if let email = settings.jiraEmail?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
            args += ["--email", email]
        }
        let result = try await RemoteWorkItemCommandRunner.shared.run(
            executable: "acli",
            arguments: args,
            cwd: nil,
            timeout: 12
        )
        guard result.exitStatus == 0, !result.timedOut else {
            throw RemoteWorkItemError.commandFailed(
                result.stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "Could not switch Jira site to \(site). Run `acli jira auth login --web` or `acli jira auth login --site \(site) --email <email> --token`."
                    : result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
    }

    private static func discoverJiraAccounts() async -> [TaskRemoteJiraAccountOption] {
        var options = parseJiraAccountsConfig()
        if options.isEmpty,
           let status = try? await RemoteWorkItemCommandRunner.shared.run(
               executable: "acli",
               arguments: ["jira", "auth", "status"],
               cwd: nil,
               timeout: 8
           ),
           status.exitStatus == 0,
           let option = parseJiraAuthStatus(status.stdout + "\n" + status.stderr) {
            options = [option]
        }
        return uniqueJiraAccounts(options)
    }

    private static func parseJiraAccountsConfig() -> [TaskRemoteJiraAccountOption] {
        let environment = ProcessInfo.processInfo.environment
        let configRoot = environment["XDG_CONFIG_HOME"].flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty }
            .map(URL.init(fileURLWithPath:))
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config")
        let url = configRoot.appendingPathComponent("acli/jira_config.yaml")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }

        let currentProfile = yamlScalar(named: "current_profile", in: text)
        var options: [TaskRemoteJiraAccountOption] = []
        var profile: [String: String] = [:]

        func flush() {
            guard let site = profile["site"]?.nilIfEmpty else { return }
            let cloudId = profile["cloud_id"] ?? ""
            let accountId = profile["account_id"] ?? ""
            let profileId = "\(cloudId):\(accountId)"
            options.append(TaskRemoteJiraAccountOption(
                site: site,
                email: profile["email"],
                displayName: profile["display_name"],
                isCurrent: currentProfile == profileId
            ))
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("- ") {
                flush()
                profile = [:]
                let rest = String(line.dropFirst(2))
                if let (key, value) = yamlPair(rest) { profile[key] = value }
                continue
            }
            guard !profile.isEmpty, let (key, value) = yamlPair(line) else { continue }
            profile[key] = value
        }
        flush()
        return uniqueJiraAccounts(options)
    }

    private static func parseJiraAuthStatus(_ text: String) -> TaskRemoteJiraAccountOption? {
        var site: String?
        var email: String?
        for rawLine in text.split(separator: "\n").map(String.init) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("Site:") {
                site = String(line.dropFirst("Site:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            } else if line.hasPrefix("Email:") {
                email = String(line.dropFirst("Email:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        guard let site = site?.nilIfEmpty else { return nil }
        return TaskRemoteJiraAccountOption(site: site, email: email, displayName: nil, isCurrent: true)
    }

    private static func uniqueJiraAccounts(_ options: [TaskRemoteJiraAccountOption]) -> [TaskRemoteJiraAccountOption] {
        var seen = Set<String>()
        return options.filter { option in
            guard !seen.contains(option.id) else { return false }
            seen.insert(option.id)
            return true
        }
        .sorted { lhs, rhs in
            if lhs.isCurrent != rhs.isCurrent { return lhs.isCurrent }
            return lhs.displayLabel.localizedStandardCompare(rhs.displayLabel) == .orderedAscending
        }
    }

    private static func yamlScalar(named key: String, in text: String) -> String? {
        for line in text.split(separator: "\n").map(String.init) {
            guard let (lineKey, value) = yamlPair(line.trimmingCharacters(in: .whitespacesAndNewlines)), lineKey == key else {
                continue
            }
            return value
        }
        return nil
    }

    private static func yamlPair(_ line: String) -> (String, String)? {
        guard !line.isEmpty, !line.hasPrefix("#"), let separator = line.firstIndex(of: ":") else { return nil }
        let key = String(line[..<separator]).trimmingCharacters(in: .whitespacesAndNewlines)
        var value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("\"") && value.hasSuffix("\"") && value.count >= 2 {
            value = String(value.dropFirst().dropLast())
        }
        return key.isEmpty ? nil : (key, value)
    }

    private static func normalizedJiraSite(_ value: String) -> String? {
        var site = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: site), let host = url.host {
            site = host
        }
        site = site
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return site.nilIfEmpty
    }

    private static func confirmRemoteStatusSync(
        reference: RemoteWorkItemReference,
        targetStatus: String
    ) -> Bool {
        let alert = NSAlert()
        alert.messageText = String(
            localized: "tasks.remoteSync.status.prompt.title",
            defaultValue: "Update remote status?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "tasks.remoteSync.status.prompt.body",
            defaultValue: "Set \(reference.key) to “\(targetStatus)” remotely too?",
            table: "TermLoop"
        )
        alert.alertStyle = .informational
        alert.addButton(withTitle: String(
            localized: "tasks.remoteSync.status.prompt.update",
            defaultValue: "Update Remote",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "tasks.remoteSync.status.prompt.localOnly",
            defaultValue: "Local Only",
            table: "TermLoop"
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private static func humanError(_ error: Error) -> String {
        if let remoteError = error as? RemoteWorkItemError {
            switch remoteError {
            case .commandFailed(let message), .parseFailed(let message), .unsupportedReference(let message):
                return message.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? String(localized: "common.unknownError", defaultValue: "Unknown error", table: "TermLoop")
            case .unsupportedProvider(let provider):
                return "Unsupported provider: \(provider.rawValue)"
            }
        }
        let text = String(describing: error).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? String(localized: "common.unknownError", defaultValue: "Unknown error", table: "TermLoop") : text
    }

    private static func commandFailureMessage(
        _ result: RemoteWorkItemCommandResult,
        fallback: String
    ) -> String {
        let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let stdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stderr.isEmpty { return stderr }
        if !stdout.isEmpty { return stdout }
        if result.timedOut { return "Command timed out." }
        return fallback
    }

    private static func parseProjectOptions(_ text: String) throws -> [TaskRemoteContainerOption] {
        guard let data = text.data(using: .utf8) else {
            throw RemoteWorkItemError.parseFailed("Provider CLI returned non-UTF8 JSON")
        }
        let json = try JSONSerialization.jsonObject(with: data)
        let rawProjects: [[String: Any]]
        if let array = json as? [[String: Any]] {
            rawProjects = array
        } else if let object = json as? [String: Any] {
            rawProjects = (object["values"] as? [[String: Any]])
                ?? (object["projects"] as? [[String: Any]])
                ?? (object["results"] as? [[String: Any]])
                ?? []
        } else {
            rawProjects = []
        }
        var seen = Set<String>()
        return rawProjects.compactMap { project in
            let key = (project["key"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let key, !key.isEmpty, !seen.contains(key) else { return nil }
            seen.insert(key)
            let name = ((project["name"] as? String)
                ?? (project["title"] as? String)
                ?? key)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return TaskRemoteContainerOption(key: key, name: name)
        }
        .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }

    private static func parseProjectOptionsFromWorkItems(_ text: String) throws -> [TaskRemoteContainerOption] {
        guard let data = text.data(using: .utf8) else {
            throw RemoteWorkItemError.parseFailed("Provider CLI returned non-UTF8 JSON")
        }
        let json = try JSONSerialization.jsonObject(with: data)
        let items: [[String: Any]]
        if let array = json as? [[String: Any]] {
            items = array
        } else if let object = json as? [String: Any] {
            items = (object["issues"] as? [[String: Any]])
                ?? (object["workItems"] as? [[String: Any]])
                ?? (object["values"] as? [[String: Any]])
                ?? []
        } else {
            items = []
        }

        var projects: [String: String] = [:]
        for item in items {
            let fields = item["fields"] as? [String: Any]
            let project = (fields?["project"] as? [String: Any]) ?? (item["project"] as? [String: Any])
            let explicitKey = (project?["key"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let issueKey = ((item["key"] as? String) ?? (fields?["key"] as? String))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let derivedKey = issueKey.flatMap { key -> String? in
                guard let dash = key.firstIndex(of: "-") else { return nil }
                return String(key[..<dash])
            }
            guard let key = (explicitKey?.nilIfEmpty ?? derivedKey?.nilIfEmpty) else { continue }
            let name = ((project?["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty) ?? key
            projects[key] = projects[key] ?? name
        }

        return projects
            .map { TaskRemoteContainerOption(key: $0.key, name: $0.value) }
            .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }

    private static func parseRepositoryOptions(_ text: String) throws -> [TaskRemoteContainerOption] {
        guard let data = text.data(using: .utf8) else {
            throw RemoteWorkItemError.parseFailed("Provider CLI returned non-UTF8 JSON")
        }
        let json = try JSONSerialization.jsonObject(with: data)
        let items: [[String: Any]]
        if let array = json as? [[String: Any]] {
            items = array
        } else if let object = json as? [String: Any] {
            items = (object["repositories"] as? [[String: Any]])
                ?? (object["projects"] as? [[String: Any]])
                ?? (object["values"] as? [[String: Any]])
                ?? []
        } else {
            items = []
        }

        var seen = Set<String>()
        return items.compactMap { item in
            let key = [
                item["nameWithOwner"] as? String,
                item["path_with_namespace"] as? String,
                item["pathWithNamespace"] as? String,
                item["full_name"] as? String,
                item["fullName"] as? String,
                item["name_with_namespace"] as? String
            ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty }
            .first
            guard let key, seen.insert(key).inserted else { return nil }
            let name = [
                item["name"] as? String,
                item["description"] as? String
            ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty }
            .first ?? key
            return TaskRemoteContainerOption(key: key, name: name)
        }
        .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }

    private static let defaultJiraStatuses = ["To Do", "In Progress", "Done"]

    private static func parseStatusLabels(_ text: String) throws -> [String] {
        guard let data = text.data(using: .utf8) else {
            throw RemoteWorkItemError.parseFailed("Provider CLI returned non-UTF8 JSON")
        }
        let json = try JSONSerialization.jsonObject(with: data)
        let items: [[String: Any]]
        if let array = json as? [[String: Any]] {
            items = array
        } else if let object = json as? [String: Any] {
            items = (object["issues"] as? [[String: Any]])
                ?? (object["workItems"] as? [[String: Any]])
                ?? (object["values"] as? [[String: Any]])
                ?? []
        } else {
            items = []
        }
        var labels: [String] = []
        var seen = Set<String>()
        for item in items {
            let fields = item["fields"] as? [String: Any]
            let status = (fields?["status"] as? [String: Any]) ?? (item["status"] as? [String: Any])
            let label = ((status?["name"] as? String) ?? (item["status"] as? String))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let label, !label.isEmpty else { continue }
            let key = label.lowercased()
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            labels.append(label)
        }
        if labels.isEmpty {
            labels = defaultJiraStatuses
        }
        return labels.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}
