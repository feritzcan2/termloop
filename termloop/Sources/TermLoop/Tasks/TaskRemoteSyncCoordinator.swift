// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import Foundation

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

private let taskRemoteDefaultJiraStatuses = ["To Do", "In Progress", "In Review", "Done"]

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

struct TaskRemoteWorkItemCreateError: LocalizedError, Sendable {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

private final class TaskRemoteCreateContinuation: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<UUID, Error>?

    init(_ continuation: CheckedContinuation<UUID, Error>) {
        self.continuation = continuation
    }

    func resume(returning value: UUID) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }

    func resume(throwing error: Error) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(throwing: error)
    }
}

private struct TaskRemoteMetadataCacheEntry<Value: Codable & Sendable>: Codable, Sendable {
    var value: Value
    var updatedAt: Date
}

private struct TaskRemoteMetadataCacheFile: Codable, Sendable {
    var jiraAccounts: TaskRemoteMetadataCacheEntry<[TaskRemoteJiraAccountOption]>?
    var containers: [String: TaskRemoteMetadataCacheEntry<[TaskRemoteContainerOption]>] = [:]
    var statuses: [String: TaskRemoteMetadataCacheEntry<[String]>] = [:]
    var issueTypes: [String: TaskRemoteMetadataCacheEntry<[TaskRemoteIssueTypeOption]>] = [:]

    init() {}

    private enum CodingKeys: String, CodingKey {
        case jiraAccounts
        case containers
        case statuses
        case issueTypes
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jiraAccounts = try container.decodeIfPresent(
            TaskRemoteMetadataCacheEntry<[TaskRemoteJiraAccountOption]>.self,
            forKey: .jiraAccounts
        )
        containers = try container.decodeIfPresent(
            [String: TaskRemoteMetadataCacheEntry<[TaskRemoteContainerOption]>].self,
            forKey: .containers
        ) ?? [:]
        statuses = try container.decodeIfPresent(
            [String: TaskRemoteMetadataCacheEntry<[String]>].self,
            forKey: .statuses
        ) ?? [:]
        issueTypes = try container.decodeIfPresent(
            [String: TaskRemoteMetadataCacheEntry<[TaskRemoteIssueTypeOption]>].self,
            forKey: .issueTypes
        ) ?? [:]
    }
}

private struct LinkedRemoteTaskForStatusSync: Sendable {
    let taskId: UUID
    let reference: RemoteWorkItemReference
    let projectedTitle: String
    let projectedStatusLabel: String?
    let currentColumnId: TaskColumnId
    let source: String
}

public enum TaskColumnMoveDirection: Sendable {
    case up
    case down
}

@MainActor
public final class TaskRemoteSyncCoordinator: ObservableObject {
    @Published public private(set) var isSyncing: Bool = false
    @Published public private(set) var isLoadingJiraAccounts: Bool = false
    @Published public private(set) var isLoadingContainers: Bool = false
    @Published public private(set) var isLoadingStatuses: Bool = false
    @Published public private(set) var isLoadingIssueTypes: Bool = false
    @Published public private(set) var jiraAccountOptions: [TaskRemoteJiraAccountOption] = []
    @Published public private(set) var containerOptions: [TaskRemoteContainerOption] = []
    @Published public private(set) var remoteStatusOptions: [TaskRemoteStatusOption] = []
    @Published public private(set) var issueTypeOptions: [TaskRemoteIssueTypeOption] = []
    @Published public private(set) var issueTypeOptionsMessage: String?
    @Published public private(set) var cliStatuses: [RemoteWorkItemProviderId: TaskRemoteCLIStatus] = [:]
    @Published public private(set) var jiraAccountsCachedAt: Date?
    @Published public private(set) var containerOptionsCachedAt: Date?
    @Published public private(set) var remoteStatusOptionsCachedAt: Date?
    @Published public private(set) var lastMessage: String?

    private let store: TaskBoardStore
    private var syncTask: Task<Void, Never>?
    private var cliStatusTask: Task<Void, Never>?
    private var syncColumnsAfterLoadingStatuses = false
    private var showRemoteStatusSyncAlertOnCompletion = false
    private var metadataCache = TaskRemoteMetadataCacheFile()
    private var metadataCacheMutationCount = 0
    private var storeChangeCancellable: AnyCancellable?

    public init(store: TaskBoardStore) {
        self.store = store
        storeChangeCancellable = store.objectWillChange.sink { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.objectWillChange.send()
            }
        }
        let cacheURL = store.projectRoot.appendingPathComponent(".termloop/remote-work-items-cache.json")
        Task { [weak self] in
            let cache = await Self.loadMetadataCacheFromDisk(at: cacheURL)
            guard let self else { return }
            self.applyInitialMetadataCache(cache)
        }
    }

    nonisolated private static func debugLog(_ message: String) {
        NSLog("[TasksRemoteSync] \(message)")
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
        guard settings.isEnabled else { return }
        hydrateRemoteMetadataFromCache()
        loadCLIStatusesIfNeeded()
        if jiraAccountOptions.isEmpty {
            let localOptions = JiraRemoteWorkItemProvider.configuredAccounts()
            if !localOptions.isEmpty {
                jiraAccountOptions = localOptions
                applyDefaultJiraAccountIfNeeded(localOptions)
                persistJiraAccountsToCache(localOptions)
            }
        }
        syncIfEnabledOnAppear()
    }

    public func setRemoteItemsEnabled(_ enabled: Bool) {
        guard settings.remoteItemsEnabled != enabled else { return }
        do {
            try store.updateSettings { settings in
                settings.remoteSync.remoteItemsEnabled = enabled
                if !enabled {
                    settings.remoteSync.syncAssignedToMe = false
                }
                settings.remoteSync.lastError = nil
            }
            lastMessage = nil
            if enabled {
                prepareRemoteSettings()
            } else {
                syncTask?.cancel()
                isSyncing = false
                isLoadingStatuses = false
                isLoadingIssueTypes = false
                syncColumnsAfterLoadingStatuses = false
                showRemoteStatusSyncAlertOnCompletion = false
                cliStatusTask?.cancel()
                isLoadingJiraAccounts = false
                isLoadingContainers = false
                issueTypeOptions = []
                issueTypeOptionsMessage = nil
                cliStatuses = [:]
            }
        } catch {
            lastMessage = String(describing: error)
        }
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

    public func cliSetupHint(for provider: RemoteWorkItemProviderId) -> String {
        switch provider {
        case .jira:
            return String(localized: "tasks.settings.remote.cli.hint.jira",
                          defaultValue: "Install/log in with Atlassian CLI, then run `acli jira auth status` to verify.",
                          table: "TermLoop")
        case .github:
            return String(localized: "tasks.settings.remote.cli.hint.github",
                          defaultValue: "Install GitHub CLI and run `gh auth login`; repo sync uses `gh issue` commands.",
                          table: "TermLoop")
        case .gitlab:
            return String(localized: "tasks.settings.remote.cli.hint.gitlab",
                          defaultValue: "Install GitLab CLI and run `glab auth login`; project sync uses `glab issue` commands.",
                          table: "TermLoop")
        }
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
            hydrateRemoteMetadataFromCache()
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func setSyncAssignedToMe(_ enabled: Bool) {
        do {
            try store.updateSettings { settings in
                if enabled {
                    settings.remoteSync.remoteItemsEnabled = true
                }
                settings.remoteSync.syncAssignedToMe = enabled
                if enabled {
                    settings.remoteSync.lastError = nil
                }
            }
        } catch {
            lastMessage = String(describing: error)
        }
        if enabled {
            syncAssignedToMe(reason: "tasks.settings.toggle")
        }
    }

    public func setAssignedSyncLimit(_ limit: Int) {
        do {
            try store.updateSettings { settings in
                settings.remoteSync.limit = max(1, min(limit, 500))
                settings.remoteSync.lastError = nil
            }
            lastMessage = nil
        } catch {
            lastMessage = String(describing: error)
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
            hydrateRemoteMetadataFromCache()
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
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func moveColumn(_ columnId: TaskColumnId, direction: TaskColumnMoveDirection) {
        let visibleIds = settingsVisibleColumns.map(\.columnId)
        guard let visibleIndex = visibleIds.firstIndex(of: columnId) else { return }
        let targetVisibleIndex: Int
        switch direction {
        case .up:
            targetVisibleIndex = visibleIndex - 1
        case .down:
            targetVisibleIndex = visibleIndex + 1
        }
        guard visibleIds.indices.contains(targetVisibleIndex) else { return }
        let targetColumnId = visibleIds[targetVisibleIndex]

        do {
            try store.updateSettings { settings in
                var columns = TaskBoardSettings.normalizedColumns(settings.columns)
                guard let from = columns.firstIndex(where: { $0.columnId == columnId }),
                      let to = columns.firstIndex(where: { $0.columnId == targetColumnId }) else {
                    return
                }
                columns.swapAt(from, to)
                settings.columns = TaskBoardSettings.normalizedColumns(columns)
            }
        } catch {
            lastMessage = String(describing: error)
        }
    }

    public func syncRemoteStatusesToColumns() {
        guard settings.isAssignedSyncEnabled else {
            lastMessage = String(localized: "tasks.settings.columns.assignedSyncRequired",
                                 defaultValue: "Turn on Sync assigned to me before syncing remote statuses to columns.",
                                 table: "TermLoop")
            return
        }
        let snapshot = store.fileSnapshot()
        Self.debugLog(
            "syncRemoteStatusesToColumns requested projectId=\(store.projectId.uuidString) root=\(store.projectRoot.path) " +
            "provider=\(settings.provider.rawValue) container=\(settings.container ?? "nil") " +
            "tasks=\(snapshot.tasks.count) activeTasks=\(snapshot.tasks.filter { $0.archivedAt == nil }.count) " +
            "columns=\(snapshot.settings.columns.count)"
        )
        syncColumnsAfterLoadingStatuses = true
        showRemoteStatusSyncAlertOnCompletion = true
        loadRemoteStatusOptions()
    }

    public func syncIfEnabledOnAppear() {
        guard settings.isAssignedSyncEnabled else { return }
        if let last = settings.lastSyncedAt, Date().timeIntervalSince(last) < 600 {
            return
        }
        syncAssignedToMe(reason: "tasks.settings.appear")
    }

    public func loadJiraAccountOptionsIfNeeded() {
        guard settings.isEnabled else { return }
        guard jiraAccountOptions.isEmpty else { return }
        if let cached = readMetadataCache().jiraAccounts?.value, !cached.isEmpty {
            jiraAccountOptions = cached
            return
        }
        let localOptions = JiraRemoteWorkItemProvider.configuredAccounts()
        if !localOptions.isEmpty {
            jiraAccountOptions = localOptions
            persistJiraAccountsToCache(localOptions)
        }
    }

    public func loadJiraAccountOptions() {
        guard settings.isEnabled else { return }
        guard !isLoadingJiraAccounts else { return }
        isLoadingJiraAccounts = true
        Task(priority: .utility) { [weak self] in
            let options = await JiraRemoteWorkItemProvider.discoverAccounts()
            await MainActor.run {
                guard let self else { return }
                self.isLoadingJiraAccounts = false
                guard self.settings.isEnabled else { return }
                self.jiraAccountOptions = options
                self.applyDefaultJiraAccountIfNeeded(options)
                self.persistJiraAccountsToCache(options)
            }
        }
    }

    public func loadContainerOptionsIfNeeded() {
        guard settings.isEnabled else { return }
        guard containerOptions.isEmpty else { return }
        hydrateRemoteMetadataFromCache()
    }

    public func loadRemoteStatusOptionsIfNeeded() {
        guard settings.isAssignedSyncEnabled else { return }
        guard remoteStatusOptions.isEmpty else { return }
        hydrateRemoteMetadataFromCache()
    }

    public func loadIssueTypeOptionsIfNeeded() {
        guard settings.isEnabled, settings.provider == .jira else { return }
        guard issueTypeOptions.isEmpty else { return }
        hydrateRemoteMetadataFromCache()
        if issueTypeOptions.isEmpty {
            loadIssueTypeOptions()
        }
    }

    public func loadContainerOptions() {
        guard settings.isEnabled else { return }
        guard !isLoadingContainers else { return }
        isLoadingContainers = true
        let syncSettings = settings
        Task(priority: .utility) { [weak self] in
            do {
                let options = try await Self.fetchContainerOptions(settings: syncSettings)
                await MainActor.run {
                    guard let self else { return }
                    self.isLoadingContainers = false
                    guard self.settings.isEnabled else { return }
                    self.persistContainerOptionsToCache(options, settings: syncSettings)
                    guard Self.containerCacheKey(syncSettings) == Self.containerCacheKey(self.settings) else { return }
                    self.containerOptions = options
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    self.isLoadingContainers = false
                    guard self.settings.isEnabled,
                          Self.containerCacheKey(syncSettings) == Self.containerCacheKey(self.settings) else { return }
                    self.containerOptions = []
                    self.lastMessage = Self.humanError(error)
                }
            }
        }
    }

    public func loadIssueTypeOptions() {
        guard settings.isEnabled, settings.provider == .jira else {
            issueTypeOptions = []
            issueTypeOptionsMessage = nil
            return
        }
        guard !isLoadingIssueTypes else { return }
        guard settings.container?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty != nil else {
            issueTypeOptions = []
            issueTypeOptionsMessage = Self.missingContainerMessage(for: .jira)
            return
        }
        isLoadingIssueTypes = true
        issueTypeOptionsMessage = nil
        let syncSettings = settings
        Task(priority: .utility) { [weak self] in
            do {
                let options = try await Self.fetchIssueTypeOptions(settings: syncSettings)
                await MainActor.run {
                    guard let self else { return }
                    self.isLoadingIssueTypes = false
                    self.persistIssueTypeOptionsToCache(options, settings: syncSettings)
                    guard self.settings.isEnabled,
                          Self.issueTypeCacheKey(syncSettings) == Self.issueTypeCacheKey(self.settings) else { return }
                    self.issueTypeOptions = options
                    self.issueTypeOptionsMessage = options.isEmpty
                        ? String(localized: "tasks.remoteCreate.issueType.empty",
                                 defaultValue: "No Jira issue types were returned for this project. Type one manually.",
                                 table: "TermLoop")
                        : nil
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    self.isLoadingIssueTypes = false
                    guard self.settings.isEnabled,
                          Self.issueTypeCacheKey(syncSettings) == Self.issueTypeCacheKey(self.settings) else { return }
                    self.issueTypeOptions = []
                    self.issueTypeOptionsMessage = Self.humanError(error)
                }
            }
        }
    }

    public func loadRemoteStatusOptions() {
        guard settings.isAssignedSyncEnabled else {
            lastMessage = String(localized: "tasks.settings.columns.assignedSyncRequired",
                                 defaultValue: "Turn on Sync assigned to me before loading remote statuses.",
                                 table: "TermLoop")
            return
        }
        guard !isLoadingStatuses else {
            Self.debugLog("loadRemoteStatusOptions reused in-flight request applyColumns=\(syncColumnsAfterLoadingStatuses)")
            return
        }
        isLoadingStatuses = true
        let syncSettings = settings
        Self.debugLog(
            "loadRemoteStatusOptions start projectId=\(store.projectId.uuidString) root=\(store.projectRoot.path) " +
            "provider=\(syncSettings.provider.rawValue) container=\(syncSettings.container ?? "nil") " +
            "jiraSite=\(syncSettings.jiraSite ?? "nil") jiraEmail=\(syncSettings.jiraEmail ?? "nil")"
        )
        Task(priority: .utility) { [weak self] in
            do {
                let labels = try await Self.fetchRemoteStatusLabels(settings: syncSettings)
                Self.debugLog("loadRemoteStatusOptions fetched count=\(labels.count) labels=\(labels.joined(separator: " | "))")
                await MainActor.run {
                    guard let self else { return }
                    self.isLoadingStatuses = false
                    self.persistStatusLabelsToCache(labels, settings: syncSettings)
                    guard self.settings.isAssignedSyncEnabled,
                          Self.statusCacheKey(syncSettings) == Self.statusCacheKey(self.settings) else {
                        self.syncColumnsAfterLoadingStatuses = false
                        self.showRemoteStatusSyncAlertOnCompletion = false
                        return
                    }
                    self.remoteStatusOptions = labels.map(TaskRemoteStatusOption.init)
                    self.syncPendingColumnsIfNeeded(labels)
                }
            } catch {
                Self.debugLog("loadRemoteStatusOptions failed error=\(Self.humanError(error))")
                await MainActor.run {
                    guard let self else { return }
                    let shouldAlert = self.showRemoteStatusSyncAlertOnCompletion
                    let message = Self.humanError(error)
                    self.isLoadingStatuses = false
                    self.syncColumnsAfterLoadingStatuses = false
                    self.showRemoteStatusSyncAlertOnCompletion = false
                    guard self.settings.isAssignedSyncEnabled,
                          Self.statusCacheKey(syncSettings) == Self.statusCacheKey(self.settings) else { return }
                    self.lastMessage = message
                    if shouldAlert {
                        self.presentSyncResultAlert(
                            title: String(localized: "tasks.remoteSync.status.alert.failedTitle",
                                          defaultValue: "Remote Status Sync Failed",
                                          table: "TermLoop"),
                            message: message
                        )
                    }
                }
            }
        }
    }

    public func syncAssignedToMe(reason: String = "tasks.settings.syncNow") {
        guard settings.isAssignedSyncEnabled else {
            lastMessage = String(localized: "tasks.settings.remote.assignedSyncRequired",
                                 defaultValue: "Turn on Sync assigned to me before syncing assigned work items.",
                                 table: "TermLoop")
            return
        }
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
                    guard let self else { return }
                    guard self.settings.isAssignedSyncEnabled,
                          Self.remoteWorkItemContextKey(syncSettings) == Self.remoteWorkItemContextKey(self.settings) else {
                        self.isSyncing = false
                        return
                    }
                    self.applyAssignedSnapshots(
                        snapshots,
                        reason: reason,
                        requestLimit: request.limit,
                        showCompletionAlert: reason != "tasks.settings.appear"
                    )
                }
            } catch {
                await MainActor.run {
                    self?.finishSync(error: error)
                }
            }
        }
    }

    public func syncAssignedToMeAsync(reason: String = "tasks.mobile.syncNow") async throws {
        guard settings.isAssignedSyncEnabled else {
            let message = String(localized: "tasks.settings.remote.assignedSyncRequired",
                                 defaultValue: "Turn on Sync assigned to me before syncing assigned work items.",
                                 table: "TermLoop")
            lastMessage = message
            throw TaskRemoteWorkItemCreateError(message)
        }
        guard !isSyncing else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.create.busy",
                defaultValue: "A remote item operation is already running.",
                table: "TermLoop"
            ))
        }
        let syncSettings = settings
        let request = RemoteWorkItemListRequest(
            provider: syncSettings.provider,
            container: syncSettings.container,
            limit: syncSettings.limit
        )

        isSyncing = true
        lastMessage = nil
        do {
            let service = Self.makeRemoteWorkItemService(settings: syncSettings)
            let snapshots = try await service.listAssignedToMe(request)
            try Task.checkCancellation()
            guard settings.isAssignedSyncEnabled,
                  Self.remoteWorkItemContextKey(syncSettings) == Self.remoteWorkItemContextKey(settings) else {
                isSyncing = false
                throw TaskRemoteWorkItemCreateError(String(
                    localized: "tasks.remoteSync.create.contextChanged",
                    defaultValue: "Created remote work item, but remote settings changed before it could be linked locally.",
                    table: "TermLoop"
                ))
            }
            applyAssignedSnapshots(
                snapshots,
                reason: reason,
                requestLimit: request.limit,
                showCompletionAlert: false
            )
        } catch {
            finishSync(error: error)
            throw error
        }
    }

    public func createRemoteWorkItem(
        title rawTitle: String,
        bodyMarkdown rawBodyMarkdown: String? = nil,
        issueType rawIssueType: String? = nil,
        onRemoteCreated: (@MainActor @Sendable (RemoteWorkItemReference) -> Void)? = nil,
        onCreated: (@MainActor @Sendable (UUID) -> Void)? = nil,
        onFailed: (@MainActor @Sendable (String) -> Void)? = nil
    ) {
        func fail(_ message: String) {
            lastMessage = message
            onFailed?(message)
        }

        guard !isSyncing else {
            fail(String(localized: "tasks.remoteSync.create.busy",
                        defaultValue: "A remote item operation is already running.",
                        table: "TermLoop"))
            return
        }
        guard settings.isEnabled else {
            fail(String(localized: "tasks.remoteSync.create.disabled",
                        defaultValue: "Enable remote work items before creating remote work items.",
                        table: "TermLoop"))
            return
        }
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            fail(String(localized: "tasks.remoteSync.create.emptyTitle",
                        defaultValue: "Enter a title before creating a remote work item.",
                        table: "TermLoop"))
            return
        }
        guard let container = settings.container?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty else {
            fail(Self.missingContainerMessage(for: settings.provider))
            return
        }

        let syncSettings = settings
        let bodyMarkdown = rawBodyMarkdown?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
        let issueType = rawIssueType?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
        let request = RemoteWorkItemCreateRequest(
            provider: syncSettings.provider,
            title: title,
            bodyMarkdown: bodyMarkdown,
            container: container,
            issueType: issueType
        )

        isSyncing = true
        lastMessage = nil
        syncTask?.cancel()
        syncTask = Task(priority: .utility) { [weak self, onRemoteCreated, onCreated, onFailed] in
            do {
                let service = Self.makeRemoteWorkItemService(settings: syncSettings)
                let snapshot = try await service.create(request, projectRoot: nil)
                try Task.checkCancellation()
                await MainActor.run {
                    onRemoteCreated?(snapshot.reference)
                    guard let self else { return }
                    guard self.settings.isEnabled,
                          Self.remoteWorkItemContextKey(syncSettings) == Self.remoteWorkItemContextKey(self.settings) else {
                        let message = String(
                            localized: "tasks.remoteSync.create.contextChanged",
                            defaultValue: "Created remote work item \(snapshot.reference.key), but remote settings changed before it could be linked locally.",
                            table: "TermLoop"
                        )
                        self.isSyncing = false
                        self.lastMessage = message
                        onFailed?(message)
                        return
                    }
                    if let taskId = self.applyCreatedRemoteSnapshot(snapshot) {
                        onCreated?(taskId)
                    } else {
                        onFailed?(self.lastMessage ?? String(
                            localized: "tasks.remoteSync.create.localFailed",
                            defaultValue: "Created the remote work item, but could not create the local task.",
                            table: "TermLoop"
                        ))
                    }
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    if error is CancellationError {
                        let message = String(
                            localized: "tasks.remoteSync.create.cancelled",
                            defaultValue: "Remote item creation was cancelled.",
                            table: "TermLoop"
                        )
                        self.isSyncing = false
                        self.lastMessage = message
                        onFailed?(message)
                    } else {
                        let message = Self.humanError(error)
                        self.finishSync(error: error)
                        onFailed?(message)
                    }
                }
            }
        }
    }

    func createRemoteWorkItemAsync(
        title: String,
        bodyMarkdown: String? = nil,
        issueType: String? = nil,
        onRemoteCreated: (@MainActor @Sendable (RemoteWorkItemReference) -> Void)? = nil
    ) async throws -> UUID {
        try await withCheckedThrowingContinuation { continuation in
            let box = TaskRemoteCreateContinuation(continuation)
            createRemoteWorkItem(
                title: title,
                bodyMarkdown: bodyMarkdown,
                issueType: issueType,
                onRemoteCreated: onRemoteCreated,
                onCreated: { taskId in
                    box.resume(returning: taskId)
                },
                onFailed: { message in
                    box.resume(throwing: TaskRemoteWorkItemCreateError(message))
                }
            )
        }
    }

    func materializeRemoteWorkItemAsync(reference: RemoteWorkItemReference) async throws -> UUID {
        try await withCheckedThrowingContinuation { continuation in
            let box = TaskRemoteCreateContinuation(continuation)
            guard !isSyncing else {
                box.resume(throwing: TaskRemoteWorkItemCreateError(String(
                    localized: "tasks.remoteSync.create.busy",
                    defaultValue: "A remote item operation is already running.",
                    table: "TermLoop"
                )))
                return
            }
            guard settings.isEnabled else {
                box.resume(throwing: TaskRemoteWorkItemCreateError(String(
                    localized: "tasks.remoteSync.create.disabled",
                    defaultValue: "Enable remote work items before creating remote work items.",
                    table: "TermLoop"
                )))
                return
            }
            let syncSettings = settings
            isSyncing = true
            lastMessage = nil
            syncTask?.cancel()
            syncTask = Task(priority: .utility) { [weak self] in
                do {
                    let service = Self.makeRemoteWorkItemService(settings: syncSettings)
                    let snapshot = try await service.fetch(reference)
                    try Task.checkCancellation()
                    await MainActor.run {
                        guard let self else { return }
                        if let taskId = self.applyCreatedRemoteSnapshot(snapshot) {
                            box.resume(returning: taskId)
                        } else {
                            box.resume(throwing: TaskRemoteWorkItemCreateError(self.lastMessage ?? String(
                                localized: "tasks.remoteSync.create.localFailed",
                                defaultValue: "Created the remote work item, but could not create the local task.",
                                table: "TermLoop"
                            )))
                        }
                    }
                } catch {
                    await MainActor.run {
                        guard let self else { return }
                        if error is CancellationError {
                            let message = String(
                                localized: "tasks.remoteSync.create.cancelled",
                                defaultValue: "Remote item creation was cancelled.",
                                table: "TermLoop"
                            )
                            self.isSyncing = false
                            self.lastMessage = message
                            box.resume(throwing: TaskRemoteWorkItemCreateError(message))
                        } else {
                            self.finishSync(error: error)
                            box.resume(throwing: error)
                        }
                    }
                }
            }
        }
    }

    public func link(taskId: UUID, rawInput: String) {
        guard settings.isEnabled else {
            lastMessage = String(localized: "tasks.remoteSync.disabled",
                                 defaultValue: "Enable remote work items before linking.",
                                 table: "TermLoop")
            return
        }
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
                    _ = self?.applyLinkedSnapshot(snapshot, taskId: taskId)
                }
            } catch {
                await MainActor.run {
                    self?.finishSync(error: error)
                }
            }
        }
    }

    public func linkRemoteWorkItemAsync(taskId: UUID, rawInput: String) async throws {
        guard settings.isEnabled else {
            let message = String(localized: "tasks.remoteSync.disabled",
                                 defaultValue: "Enable remote work items before linking.",
                                 table: "TermLoop")
            lastMessage = message
            throw TaskRemoteWorkItemCreateError(message)
        }
        guard !isSyncing else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.create.busy",
                defaultValue: "A remote item operation is already running.",
                table: "TermLoop"
            ))
        }
        let input = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty, let reference = RemoteWorkItemParser.parse(input) else {
            let message = String(localized: "tasks.remoteSync.link.invalid",
                                 defaultValue: "Could not parse work item link.",
                                 table: "TermLoop")
            lastMessage = message
            throw TaskRemoteWorkItemCreateError(message)
        }

        isSyncing = true
        lastMessage = nil
        let syncSettings = settings
        do {
            let service = Self.makeRemoteWorkItemService(settings: syncSettings)
            let snapshot = try await service.fetch(reference)
            try Task.checkCancellation()
            guard applyLinkedSnapshot(snapshot, taskId: taskId) else {
                throw TaskRemoteWorkItemCreateError(lastMessage ?? String(
                    localized: "tasks.remoteSync.create.localFailed",
                    defaultValue: "Created the remote work item, but could not create the local task.",
                    table: "TermLoop"
                ))
            }
        } catch {
            finishSync(error: error)
            throw error
        }
    }

    public func refresh(taskId: UUID) {
        guard settings.isEnabled else { return }
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
                    _ = self?.applyLinkedSnapshot(snapshot, taskId: taskId)
                }
            } catch {
                await MainActor.run {
                    self?.finishSync(error: error)
                }
            }
        }
    }

    public func refreshRemoteWorkItemAsync(taskId: UUID) async throws {
        guard settings.isEnabled else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.disabled",
                defaultValue: "Enable remote work items before linking.",
                table: "TermLoop"
            ))
        }
        guard !isSyncing else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.create.busy",
                defaultValue: "A remote item operation is already running.",
                table: "TermLoop"
            ))
        }
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }),
              let reference = task.remoteWorkItem else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.localTaskMissing",
                defaultValue: "Remote item was fetched, but the local task no longer exists.",
                table: "TermLoop"
            ))
        }

        isSyncing = true
        lastMessage = nil
        let syncSettings = settings
        do {
            let service = Self.makeRemoteWorkItemService(settings: syncSettings)
            let snapshot = try await service.fetch(reference)
            try Task.checkCancellation()
            guard applyLinkedSnapshot(snapshot, taskId: taskId) else {
                throw TaskRemoteWorkItemCreateError(lastMessage ?? String(
                    localized: "tasks.remoteSync.create.localFailed",
                    defaultValue: "Created the remote work item, but could not create the local task.",
                    table: "TermLoop"
                ))
            }
        } catch {
            finishSync(error: error)
            throw error
        }
    }

    public func unlinkRemoteWorkItem(taskId: UUID) throws {
        var found = false
        let changed = store.mutate { file in
            guard let idx = file.tasks.firstIndex(where: { $0.id == taskId }) else { return false }
            found = true
            let old = file.tasks[idx]
            file.tasks[idx].remoteWorkItem = nil
            file.tasks[idx].remoteStatusLabel = nil
            file.tasks[idx].lastRemoteSyncAt = nil
            file.tasks[idx].updatedAt = Date()
            return file.tasks[idx] != old
        }
        guard found else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.localTaskMissing",
                defaultValue: "Remote item was fetched, but the local task no longer exists.",
                table: "TermLoop"
            ))
        }
        if changed {
            try store.saveNow()
        }
        finishSync(message: String(localized: "tasks.remoteSync.unlinked",
                                   defaultValue: "Unlinked work item.",
                                   table: "TermLoop"))
    }

    public func maybePromptRemoteStatusSync(taskId: UUID, to columnId: TaskColumnId) async {
        let syncSettings = store.settingsSnapshot
        guard syncSettings.remoteSync.isEnabled else { return }
        guard !isSyncing else { return }
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

        let cachedOptions = remoteStatusOptions.map { option in
            RemoteWorkItemStatusOption(
                id: "cached.\(option.id)",
                label: option.label,
                targetState: option.label,
                providerPayload: reference.provider == .jira ? ["targetStatusLabel": option.label] : [:]
            )
        }
        let cachedOption = Self.matchingStatusOption(
            in: cachedOptions,
            targetStatus: targetStatus
        )
        let immediateOption = cachedOption ?? Self.fallbackJiraStatusOption(
            reference: reference,
            targetStatus: targetStatus
        )

        Self.debugLog(
            "maybePromptRemoteStatusSync prompt task=\(taskId.uuidString) key=\(reference.key) " +
            "targetStatus=\(targetStatus) cacheOptions=\(cachedOptions.count) " +
            "optionSource=\(cachedOption != nil ? "cache" : (immediateOption != nil ? "jiraFallback" : "postConfirmFetch"))"
        )
        let shouldSync = Self.confirmRemoteStatusSync(
            reference: reference,
            targetStatus: immediateOption?.label ?? targetStatus
        )
        guard shouldSync else { return }

        isSyncing = true
        lastMessage = nil
        let remoteSettings = syncSettings.remoteSync
        do {
            let service = Self.makeRemoteWorkItemService(settings: remoteSettings)
            let option: RemoteWorkItemStatusOption?
            if let immediateOption {
                option = immediateOption
            } else {
                let options = try await service.availableStatuses(reference)
                option = Self.matchingStatusOption(
                    in: options,
                    targetStatus: targetStatus
                )
            }
            guard let option else {
                let message = String(
                    localized: "tasks.remoteSync.status.noMatchingStatus",
                    defaultValue: "Could not find a matching remote status for \(targetStatus). Refresh remote statuses and try again.",
                    table: "TermLoop"
                )
                isSyncing = false
                lastMessage = message
                presentSyncResultAlert(
                    title: String(localized: "tasks.remoteSync.status.updateFailedTitle",
                                  defaultValue: "Remote Status Update Failed",
                                  table: "TermLoop"),
                    message: message,
                    style: .warning
                )
                return
            }
            let snapshot = try await service.updateStatus(
                reference,
                to: option,
                projectRoot: nil
            )
            try Task.checkCancellation()
            guard Self.remoteStatusLabel(
                snapshot.statusLabel,
                matches: option,
                targetStatus: targetStatus
            ) else {
                RemoteWorkItemSnapshotStore.shared.upsert(snapshot)
                let actual = snapshot.statusLabel?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty ?? String(localized: "common.unknown",
                                          defaultValue: "unknown",
                                          table: "TermLoop")
                let expected = (option.targetState ?? option.label)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty ?? targetStatus
                let message = String(
                    localized: "tasks.remoteSync.status.mismatch",
                    defaultValue: "\(reference.key) did not change to \(expected). Remote still reports \(actual).",
                    table: "TermLoop"
                )
                isSyncing = false
                lastMessage = message
                do {
                    try store.updateSettings { settings in
                        settings.remoteSync.lastError = message
                    }
                } catch {
                    lastMessage = String(describing: error)
                }
                presentSyncResultAlert(
                    title: String(localized: "tasks.remoteSync.status.updateFailedTitle",
                                  defaultValue: "Remote Status Update Failed",
                                  table: "TermLoop"),
                    message: message,
                    style: .warning
                )
                return
            }
            guard applyLinkedSnapshot(snapshot, taskId: taskId) else {
                isSyncing = false
                presentSyncResultAlert(
                    title: String(localized: "tasks.remoteSync.status.updatedLocalFailedTitle",
                                  defaultValue: "Remote Status Updated, Local Sync Failed",
                                  table: "TermLoop"),
                    message: lastMessage ?? String(
                        localized: "tasks.remoteSync.status.updatedLocalFailedBody",
                        defaultValue: "\(reference.key) was updated remotely, but the local task could not be refreshed.",
                        table: "TermLoop"
                    ),
                    style: .warning
                )
                return
            }
            let status = snapshot.statusLabel?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .nilIfEmpty ?? option.label
            let message = String(localized: "tasks.remoteSync.status.updatedBody",
                                 defaultValue: "\(reference.key) is now \(status).",
                                 table: "TermLoop")
            finishSync(message: message)
            presentSyncResultAlert(
                title: String(localized: "tasks.remoteSync.status.updatedTitle",
                              defaultValue: "Remote Status Updated",
                              table: "TermLoop"),
                message: message
            )
        } catch {
            finishSync(error: error)
            guard !(error is CancellationError) else { return }
            presentSyncResultAlert(
                title: String(localized: "tasks.remoteSync.status.updateFailedTitle",
                              defaultValue: "Remote Status Update Failed",
                              table: "TermLoop"),
                message: Self.humanError(error),
                style: .warning
            )
        }
    }

    public func updateRemoteStatusAsync(taskId: UUID, to columnId: TaskColumnId) async throws -> String {
        let syncSettings = store.settingsSnapshot
        guard syncSettings.remoteSync.isEnabled else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.disabled",
                defaultValue: "Enable remote work items before linking.",
                table: "TermLoop"
            ))
        }
        guard !isSyncing else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.create.busy",
                defaultValue: "A remote item operation is already running.",
                table: "TermLoop"
            ))
        }
        guard let targetStatus = syncSettings.columns
            .first(where: { $0.columnId == columnId })?
            .remoteStatusLabel?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !targetStatus.isEmpty else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.status.noMatchingStatus",
                defaultValue: "Could not find a matching remote status for \(columnId.defaultTitle). Refresh remote statuses and try again.",
                table: "TermLoop"
            ))
        }
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }),
              let reference = task.remoteWorkItem else {
            throw TaskRemoteWorkItemCreateError(String(
                localized: "tasks.remoteSync.localTaskMissing",
                defaultValue: "Remote item was fetched, but the local task no longer exists.",
                table: "TermLoop"
            ))
        }

        let cachedOptions = remoteStatusOptions.map { option in
            RemoteWorkItemStatusOption(
                id: "cached.\(option.id)",
                label: option.label,
                targetState: option.label,
                providerPayload: reference.provider == .jira ? ["targetStatusLabel": option.label] : [:]
            )
        }
        let cachedOption = Self.matchingStatusOption(in: cachedOptions, targetStatus: targetStatus)
        let immediateOption = cachedOption ?? Self.fallbackJiraStatusOption(reference: reference, targetStatus: targetStatus)

        isSyncing = true
        lastMessage = nil
        let remoteSettings = syncSettings.remoteSync
        do {
            let service = Self.makeRemoteWorkItemService(settings: remoteSettings)
            let option: RemoteWorkItemStatusOption?
            if let immediateOption {
                option = immediateOption
            } else {
                let options = try await service.availableStatuses(reference)
                option = Self.matchingStatusOption(in: options, targetStatus: targetStatus)
            }
            guard let option else {
                let message = String(
                    localized: "tasks.remoteSync.status.noMatchingStatus",
                    defaultValue: "Could not find a matching remote status for \(targetStatus). Refresh remote statuses and try again.",
                    table: "TermLoop"
                )
                isSyncing = false
                lastMessage = message
                throw TaskRemoteWorkItemCreateError(message)
            }
            let snapshot = try await service.updateStatus(reference, to: option, projectRoot: nil)
            try Task.checkCancellation()
            guard Self.remoteStatusLabel(snapshot.statusLabel, matches: option, targetStatus: targetStatus) else {
                RemoteWorkItemSnapshotStore.shared.upsert(snapshot)
                let actual = snapshot.statusLabel?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty ?? String(localized: "common.unknown",
                                          defaultValue: "unknown",
                                          table: "TermLoop")
                let expected = (option.targetState ?? option.label)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty ?? targetStatus
                let message = String(
                    localized: "tasks.remoteSync.status.mismatch",
                    defaultValue: "\(reference.key) did not change to \(expected). Remote still reports \(actual).",
                    table: "TermLoop"
                )
                isSyncing = false
                lastMessage = message
                _ = try? store.updateSettings { settings in
                    settings.remoteSync.lastError = message
                }
                throw TaskRemoteWorkItemCreateError(message)
            }
            guard applyLinkedSnapshot(snapshot, taskId: taskId) else {
                throw TaskRemoteWorkItemCreateError(lastMessage ?? String(
                    localized: "tasks.remoteSync.status.updatedLocalFailedBody",
                    defaultValue: "\(reference.key) was updated remotely, but the local task could not be refreshed.",
                    table: "TermLoop"
                ))
            }
            let status = snapshot.statusLabel?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .nilIfEmpty ?? option.label
            let message = String(localized: "tasks.remoteSync.status.updatedBody",
                                 defaultValue: "\(reference.key) is now \(status).",
                                 table: "TermLoop")
            finishSync(message: message)
            return message
        } catch {
            finishSync(error: error)
            throw error
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
        } catch {
            lastMessage = String(describing: error)
        }
    }

    private func applyAssignedSnapshots(
        _ snapshots: [RemoteWorkItemSnapshot],
        reason: String,
        requestLimit: Int,
        showCompletionAlert: Bool
    ) {
        RemoteWorkItemSnapshotStore.shared.upsert(snapshots)
        let now = Date()
        var materializeInputs: [(taskId: UUID, snapshot: RemoteWorkItemSnapshot)] = []
        var createdCount = 0
        var updatedCount = 0

        let changed = store.mutate { file in
            var didChange = false
            let oldSettings = file.settings.remoteSync
            let shouldSyncColumnsFromRemote = file.settings.remoteSync.isAssignedSyncEnabled
            if shouldSyncColumnsFromRemote {
                for snapshot in snapshots {
                    guard let status = snapshot.statusLabel?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty else {
                        continue
                    }
                    let before = file.settings.columns
                    Self.ensureRemoteStatusColumn(status, in: &file.settings.columns)
                    didChange = didChange || before != file.settings.columns
                }
            }
            let columnByRemoteStatus = Self.remoteStatusColumnLookup(file.settings.columns)
            var rankCursorByColumn = Self.lastRankByColumn(file.tasks)
            var touchedColumns = Set<TaskColumnId>()

            func targetColumn(for snapshot: RemoteWorkItemSnapshot) -> TaskColumnId {
                guard shouldSyncColumnsFromRemote,
                      let statusKey = Self.remoteStatusLookupKey(snapshot.statusLabel),
                      let columnId = columnByRemoteStatus[statusKey] else {
                    return .backlog
                }
                return columnId
            }

            func nextRank(in columnId: TaskColumnId) -> String {
                let next = rankCursorByColumn[columnId]
                    .map(TaskRanking.after)
                    ?? TaskRanking.initial()
                rankCursorByColumn[columnId] = next
                return next
            }

            for snapshot in snapshots {
                let targetColumn = targetColumn(for: snapshot)
                let matchingIndexes = file.tasks.indices.filter { idx in
                    let task = file.tasks[idx]
                    return task.archivedAt == nil
                        && task.remoteWorkItem?.representsSameRemoteItem(as: snapshot.reference) == true
                }
                if !matchingIndexes.isEmpty {
                    for idx in matchingIndexes {
                        let old = file.tasks[idx]
                        update(&file.tasks[idx], with: snapshot, syncedAt: now)
                        if shouldSyncColumnsFromRemote, file.tasks[idx].columnId != targetColumn {
                            touchedColumns.insert(file.tasks[idx].columnId)
                            file.tasks[idx].columnId = targetColumn
                            file.tasks[idx].rank = nextRank(in: targetColumn)
                            touchedColumns.insert(targetColumn)
                        }
                        if file.tasks[idx] != old {
                            updatedCount += 1
                            didChange = true
                        }
                        materializeInputs.append((file.tasks[idx].id, snapshot))
                    }
                } else {
                    let rank = nextRank(in: targetColumn)
                    let task = TaskRecord(
                        projectId: store.projectId,
                        title: snapshot.title,
                        brief: nil,
                        origin: .remote,
                        remoteWorkItem: snapshot.reference,
                        remoteStatusLabel: snapshot.statusLabel,
                        lastRemoteSyncAt: now,
                        columnId: targetColumn,
                        rank: rank
                    )
                    file.tasks.append(task)
                    touchedColumns.insert(targetColumn)
                    materializeInputs.append((task.id, snapshot))
                    createdCount += 1
                    didChange = true
                }
            }

            if didChange {
                for columnId in touchedColumns {
                    _ = TaskBoardStore.rebalanceColumnIfNeeded(columnId, in: &file)
                }
            }
            file.settings.remoteSync.lastSyncedAt = now
            file.settings.remoteSync.lastError = nil
            return didChange || file.settings.remoteSync != oldSettings
        }

        materialize(materializeInputs)
        if changed || !materializeInputs.isEmpty {
            do { try store.saveNow() } catch { lastMessage = String(describing: error) }
        }
        let reachedLimit = snapshots.count >= requestLimit
        let baseMessage = String(
            localized: "tasks.remoteSync.synced",
            defaultValue: "Synced \(snapshots.count) latest assigned work items. Added \(createdCount), updated \(updatedCount).",
            table: "TermLoop"
        )
        let message = reachedLimit
            ? String(
                localized: "tasks.remoteSync.synced.truncated",
                defaultValue: "\(baseMessage) Limit \(requestLimit) was reached, so more assigned items may exist. Raise the limit or narrow the project/repo if needed.",
                table: "TermLoop"
            )
            : baseMessage
        finishSync(message: message)
        if showCompletionAlert {
            presentSyncResultAlert(
                title: String(localized: "tasks.remoteSync.alert.title",
                              defaultValue: "Task Sync Complete",
                              table: "TermLoop"),
                message: message
            )
        }
        NSLog("[Tasks] assigned-to-me sync applied count=\(snapshots.count) reason=\(reason)")
    }

    @discardableResult
    private func applyCreatedRemoteSnapshot(_ snapshot: RemoteWorkItemSnapshot) -> UUID? {
        RemoteWorkItemSnapshotStore.shared.upsert(snapshot)
        let now = Date()
        var materializeInputs: [(taskId: UUID, snapshot: RemoteWorkItemSnapshot)] = []
        var taskId: UUID?
        var createdNewTask = false

        do {
            let changed = store.mutate { file in
                var didChange = false
                let hadLastError = file.settings.remoteSync.lastError != nil
                let shouldSyncColumnsFromRemote = file.settings.remoteSync.isAssignedSyncEnabled
                var columnByRemoteStatus = Self.remoteStatusColumnLookup(file.settings.columns)
                var rankCursorByColumn = Self.lastRankByColumn(file.tasks)
                var touchedColumns = Set<TaskColumnId>()

                func targetColumn(for snapshot: RemoteWorkItemSnapshot) -> TaskColumnId {
                    guard shouldSyncColumnsFromRemote,
                          let status = snapshot.statusLabel?
                              .trimmingCharacters(in: .whitespacesAndNewlines)
                              .nilIfEmpty,
                          let statusKey = Self.remoteStatusLookupKey(status) else {
                        return .backlog
                    }
                    if columnByRemoteStatus[statusKey] == nil {
                        Self.ensureRemoteStatusColumn(status, in: &file.settings.columns)
                        columnByRemoteStatus = Self.remoteStatusColumnLookup(file.settings.columns)
                        didChange = true
                    }
                    return columnByRemoteStatus[statusKey] ?? .backlog
                }

                func nextRank(in columnId: TaskColumnId) -> String {
                    let next = rankCursorByColumn[columnId]
                        .map(TaskRanking.after)
                        ?? TaskRanking.initial()
                    rankCursorByColumn[columnId] = next
                    return next
                }

                let targetColumn = targetColumn(for: snapshot)
                let matchingIndexes = file.tasks.indices.filter { idx in
                    let task = file.tasks[idx]
                    return task.archivedAt == nil
                        && task.remoteWorkItem?.representsSameRemoteItem(as: snapshot.reference) == true
                }
                if !matchingIndexes.isEmpty {
                    for idx in matchingIndexes {
                        let old = file.tasks[idx]
                        update(&file.tasks[idx], with: snapshot, syncedAt: now)
                        if shouldSyncColumnsFromRemote, file.tasks[idx].columnId != targetColumn {
                            touchedColumns.insert(file.tasks[idx].columnId)
                            file.tasks[idx].columnId = targetColumn
                            file.tasks[idx].rank = nextRank(in: targetColumn)
                            touchedColumns.insert(targetColumn)
                        }
                        taskId = taskId ?? file.tasks[idx].id
                        materializeInputs.append((file.tasks[idx].id, snapshot))
                        didChange = didChange || file.tasks[idx] != old
                    }
                } else {
                    let rank = nextRank(in: targetColumn)
                    let task = TaskRecord(
                        projectId: store.projectId,
                        title: snapshot.title,
                        brief: nil,
                        origin: .remote,
                        remoteWorkItem: snapshot.reference,
                        remoteStatusLabel: snapshot.statusLabel,
                        lastRemoteSyncAt: now,
                        columnId: targetColumn,
                        rank: rank
                    )
                    file.tasks.append(task)
                    touchedColumns.insert(targetColumn)
                    taskId = task.id
                    materializeInputs.append((task.id, snapshot))
                    createdNewTask = true
                    didChange = true
                }

                for columnId in touchedColumns {
                    didChange = TaskBoardStore.rebalanceColumnIfNeeded(columnId, in: &file) || didChange
                }
                file.settings.remoteSync.lastError = nil
                return didChange || hadLastError
            }

            materialize(materializeInputs)
            if changed || !materializeInputs.isEmpty {
                try store.saveNow()
            }
            let message = createdNewTask
                ? String(localized: "tasks.remoteSync.created",
                         defaultValue: "Created remote work item \(snapshot.reference.key).",
                         table: "TermLoop")
                : String(localized: "tasks.remoteSync.created.existing",
                         defaultValue: "Remote work item \(snapshot.reference.key) already existed locally. Updated it.",
                         table: "TermLoop")
            finishSync(message: message)
            return taskId
        } catch {
            finishSync(error: error)
            return nil
        }
    }

    @discardableResult
    private func applyLinkedSnapshot(_ snapshot: RemoteWorkItemSnapshot, taskId: UUID) -> Bool {
        RemoteWorkItemSnapshotStore.shared.upsert(snapshot)
        let now = Date()
        var foundTask = false
        var materializeInputs: [(taskId: UUID, snapshot: RemoteWorkItemSnapshot)] = []
        do {
            store.mutate { file in
                guard file.tasks.contains(where: { $0.id == taskId }) else { return false }
                foundTask = true
                let hadLastError = file.settings.remoteSync.lastError != nil
                let shouldSyncColumnsFromRemote = file.settings.remoteSync.isAssignedSyncEnabled
                var columnByRemoteStatus = Self.remoteStatusColumnLookup(file.settings.columns)
                var rankCursorByColumn = Self.lastRankByColumn(file.tasks)
                var touchedColumns = Set<TaskColumnId>()
                var didChange = false

                func targetColumn(for snapshot: RemoteWorkItemSnapshot) -> TaskColumnId? {
                    guard shouldSyncColumnsFromRemote,
                          let status = snapshot.statusLabel?
                              .trimmingCharacters(in: .whitespacesAndNewlines)
                              .nilIfEmpty,
                          let statusKey = Self.remoteStatusLookupKey(status) else {
                        return nil
                    }
                    if columnByRemoteStatus[statusKey] == nil {
                        Self.ensureRemoteStatusColumn(status, in: &file.settings.columns)
                        columnByRemoteStatus = Self.remoteStatusColumnLookup(file.settings.columns)
                        didChange = true
                    }
                    return columnByRemoteStatus[statusKey]
                }

                func nextRank(in columnId: TaskColumnId) -> String {
                    let next = rankCursorByColumn[columnId]
                        .map(TaskRanking.after)
                        ?? TaskRanking.initial()
                    rankCursorByColumn[columnId] = next
                    return next
                }

                let targetColumn = targetColumn(for: snapshot)
                let matchingIndexes = file.tasks.indices.filter { candidateIdx in
                    let task = file.tasks[candidateIdx]
                    return task.id == taskId
                        || (
                            task.archivedAt == nil
                                && task.remoteWorkItem?.representsSameRemoteItem(as: snapshot.reference) == true
                        )
                }

                for idx in matchingIndexes {
                    let old = file.tasks[idx]
                    update(&file.tasks[idx], with: snapshot, syncedAt: now)
                    if let targetColumn, file.tasks[idx].columnId != targetColumn {
                        touchedColumns.insert(file.tasks[idx].columnId)
                        file.tasks[idx].columnId = targetColumn
                        file.tasks[idx].rank = nextRank(in: targetColumn)
                        touchedColumns.insert(targetColumn)
                    }
                    if file.tasks[idx] != old {
                        didChange = true
                    }
                    materializeInputs.append((file.tasks[idx].id, snapshot))
                }

                for columnId in touchedColumns {
                    didChange = TaskBoardStore.rebalanceColumnIfNeeded(columnId, in: &file) || didChange
                }

                file.settings.remoteSync.lastError = nil
                return didChange || hadLastError
            }
            guard foundTask else {
                finishSync(message: String(localized: "tasks.remoteSync.localTaskMissing",
                                           defaultValue: "Remote item was fetched, but the local task no longer exists.",
                                           table: "TermLoop"))
                return false
            }
            materialize(materializeInputs)
            try store.saveNow()
            finishSync(message: String(localized: "tasks.remoteSync.linked",
                                       defaultValue: "Linked work item.",
                                       table: "TermLoop"))
            return true
        } catch {
            finishSync(error: error)
            return false
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
        if error is CancellationError { return }
        guard settings.isEnabled else { return }
        let message = Self.humanError(error)
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
        let shouldAlert = showRemoteStatusSyncAlertOnCompletion
        showRemoteStatusSyncAlertOnCompletion = false
        applyRemoteStatusesToColumns(labels, showCompletionAlert: shouldAlert)
    }

    private func applyRemoteStatusesToColumns(_ statuses: [String], showCompletionAlert: Bool) {
        let effectiveStatuses = statuses
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !effectiveStatuses.isEmpty else {
            Self.debugLog("applyRemoteStatusesToColumns skipped empty statuses")
            return
        }

        do {
            var addedCount = 0
            var enabledCount = 0
            var mappedCount = 0
            Self.debugLog(
                "applyRemoteStatusesToColumns start statuses=\(effectiveStatuses.joined(separator: " | ")) " +
                "existingColumns=\(store.fileSnapshot().settings.columns.map { "\($0.columnId.rawValue):\($0.remoteStatusLabel ?? "nil"):\($0.isEnabled)" }.joined(separator: ","))"
            )
            try store.updateSettings { settings in
                var columns = TaskBoardSettings.normalizedColumns(settings.columns)
                for status in effectiveStatuses {
                    let id = TaskColumnId.fromRemoteStatus(status)
                    Self.debugLog("applyRemoteStatusesToColumns mapping status=\(status) columnId=\(id.rawValue)")
                    if let idx = columns.firstIndex(where: { $0.columnId == id }) {
                        let wasEnabled = columns[idx].isEnabled
                        let priorStatus = columns[idx].remoteStatusLabel
                        columns[idx].isEnabled = true
                        columns[idx].remoteStatusLabel = status
                        if !wasEnabled { enabledCount += 1 }
                        if priorStatus != status { mappedCount += 1 }
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
                        addedCount += 1
                    }
                }
                settings.columns = TaskBoardSettings.normalizedColumns(columns)
            }
            let message = String(localized: "tasks.settings.columns.syncedRemoteStatuses",
                                 defaultValue: "Remote statuses synced to columns. Found \(effectiveStatuses.count), added \(addedCount), enabled \(enabledCount), mapped \(mappedCount).",
                                 table: "TermLoop")
            lastMessage = message
            Self.debugLog("applyRemoteStatusesToColumns complete message=\(message)")
            syncLinkedTaskColumnsToRemoteStatuses(showCompletionAlert: showCompletionAlert, columnMessage: message)
        } catch {
            lastMessage = String(describing: error)
            Self.debugLog("applyRemoteStatusesToColumns failed error=\(String(describing: error))")
        }
    }

    private func syncLinkedTaskColumnsToRemoteStatuses(showCompletionAlert: Bool, columnMessage: String) {
        if isSyncing {
            Self.debugLog("syncLinkedTaskColumns cancelling existing syncTask before status-column sync")
            syncTask?.cancel()
            isSyncing = false
        }
        let linkedTasks = linkedRemoteTasksForStatusSync()
        Self.debugLog(
            "syncLinkedTaskColumns start linkedCount=\(linkedTasks.count) tasks=\(linkedTasks.map { "\($0.taskId.uuidString.prefix(8)):\($0.reference.key):src=\($0.source):col=\($0.currentColumnId.rawValue):projected=\($0.projectedStatusLabel ?? "nil")" }.joined(separator: ","))"
        )
        guard !linkedTasks.isEmpty else {
            if showCompletionAlert {
                presentSyncResultAlert(
                    title: String(localized: "tasks.remoteSync.status.alert.title",
                                  defaultValue: "Remote Status Sync Complete",
                                  table: "TermLoop"),
                    message: columnMessage
                )
            }
            return
        }

        let syncSettings = settings
        isSyncing = true
        syncTask?.cancel()
        syncTask = Task(priority: .utility) { [weak self] in
            let service = Self.makeRemoteWorkItemService(settings: syncSettings)
            var snapshots: [(taskId: UUID, snapshot: RemoteWorkItemSnapshot)] = []
            var failureCount = 0
            var projectedFallbackCount = 0
            for linkedTask in linkedTasks {
                do {
                    Self.debugLog(
                        "syncLinkedTaskColumns fetch start task=\(linkedTask.taskId.uuidString) key=\(linkedTask.reference.key) " +
                        "source=\(linkedTask.source) projectedStatus=\(linkedTask.projectedStatusLabel ?? "nil")"
                    )
                    let snapshot = try await service.fetch(linkedTask.reference)
                    try Task.checkCancellation()
                    Self.debugLog(
                        "syncLinkedTaskColumns fetch success task=\(linkedTask.taskId.uuidString) key=\(linkedTask.reference.key) " +
                        "remoteStatus=\(snapshot.statusLabel ?? "nil")"
                    )
                    snapshots.append((linkedTask.taskId, snapshot))
                } catch is CancellationError {
                    Self.debugLog("syncLinkedTaskColumns cancelled")
                    return
                } catch {
                    if let fallback = Self.projectedStatusSnapshot(for: linkedTask) {
                        Self.debugLog(
                            "syncLinkedTaskColumns fetch failed using projected fallback task=\(linkedTask.taskId.uuidString) " +
                            "key=\(linkedTask.reference.key) projectedStatus=\(fallback.statusLabel ?? "nil") error=\(Self.humanError(error))"
                        )
                        snapshots.append((linkedTask.taskId, fallback))
                        projectedFallbackCount += 1
                    } else {
                        Self.debugLog(
                            "syncLinkedTaskColumns fetch failed no fallback task=\(linkedTask.taskId.uuidString) " +
                            "key=\(linkedTask.reference.key) error=\(Self.humanError(error))"
                        )
                        failureCount += 1
                    }
                }
            }
            await MainActor.run {
                self?.applyLinkedStatusSnapshots(
                    snapshots,
                    failureCount: failureCount,
                    projectedFallbackCount: projectedFallbackCount,
                    showCompletionAlert: showCompletionAlert
                )
            }
        }
    }

    private func linkedRemoteTasksForStatusSync() -> [LinkedRemoteTaskForStatusSync] {
        store.fileSnapshot().tasks.compactMap { task -> LinkedRemoteTaskForStatusSync? in
            guard task.archivedAt == nil else { return nil }
            if let reference = task.remoteWorkItem {
                return LinkedRemoteTaskForStatusSync(
                    taskId: task.id,
                    reference: reference,
                    projectedTitle: task.title,
                    projectedStatusLabel: task.remoteStatusLabel,
                    currentColumnId: task.columnId,
                    source: "task.remoteWorkItem"
                )
            }
            guard let snapshot = TaskWorkItemProjectionBuilder.snapshot(for: task, projectId: store.projectId) else {
                return nil
            }
            return LinkedRemoteTaskForStatusSync(
                taskId: task.id,
                reference: snapshot.reference,
                projectedTitle: snapshot.title ?? task.title,
                projectedStatusLabel: snapshot.statusLabel,
                currentColumnId: task.columnId,
                source: "worktree.binding"
            )
        }
    }

    nonisolated private static func projectedStatusSnapshot(for linkedTask: LinkedRemoteTaskForStatusSync) -> RemoteWorkItemSnapshot? {
        guard let statusLabel = linkedTask.projectedStatusLabel?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty else {
            return nil
        }
        return RemoteWorkItemSnapshot(
            reference: linkedTask.reference,
            title: linkedTask.projectedTitle,
            bodyMarkdown: nil,
            statusLabel: statusLabel,
            assignees: [],
            labels: [],
            providerUpdatedAt: nil,
            fetchedAt: Date()
        )
    }

    private func applyLinkedStatusSnapshots(
        _ snapshots: [(taskId: UUID, snapshot: RemoteWorkItemSnapshot)],
        failureCount: Int,
        projectedFallbackCount: Int,
        showCompletionAlert: Bool
    ) {
        RemoteWorkItemSnapshotStore.shared.upsert(snapshots.map(\.snapshot))
        let now = Date()
        var updatedCount = 0
        var movedCount = 0
        var unmappedCount = 0

        do {
            Self.debugLog(
                "applyLinkedStatusSnapshots start snapshots=\(snapshots.count) failures=\(failureCount) " +
                "fallbacks=\(projectedFallbackCount) showAlert=\(showCompletionAlert)"
            )
            let changed = store.mutate { file in
                var columnByRemoteStatus = Self.remoteStatusColumnLookup(file.settings.columns)
                Self.debugLog(
                    "applyLinkedStatusSnapshots columns=\(file.settings.columns.map { "\($0.columnId.rawValue):\($0.remoteStatusLabel ?? "nil"):\($0.isEnabled)" }.joined(separator: ","))"
                )
                let hadLastError = file.settings.remoteSync.lastError != nil
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
                    Self.debugLog(
                        "applyLinkedStatusSnapshots item task=\(item.taskId.uuidString) key=\(item.snapshot.reference.key) " +
                        "oldColumn=\(old.columnId.rawValue) oldRemoteStatus=\(old.remoteStatusLabel ?? "nil") newStatus=\(statusLabel ?? "nil")"
                    )
                    file.tasks[idx].remoteWorkItem = item.snapshot.reference
                    file.tasks[idx].remoteStatusLabel = statusLabel
                    file.tasks[idx].lastRemoteSyncAt = now

                    if let statusLabel,
                       let statusKey = Self.remoteStatusLookupKey(statusLabel),
                       columnByRemoteStatus[statusKey] == nil {
                        Self.debugLog("applyLinkedStatusSnapshots missing column for status=\(statusLabel); creating/enabling")
                        Self.ensureRemoteStatusColumn(statusLabel, in: &file.settings.columns)
                        columnByRemoteStatus = Self.remoteStatusColumnLookup(file.settings.columns)
                        didChange = true
                    }

                    if let statusKey = Self.remoteStatusLookupKey(statusLabel),
                       let targetColumn = columnByRemoteStatus[statusKey] {
                        Self.debugLog(
                            "applyLinkedStatusSnapshots target task=\(item.taskId.uuidString) statusKey=\(statusKey) " +
                            "targetColumn=\(targetColumn.rawValue)"
                        )
                        if file.tasks[idx].columnId != targetColumn {
                            file.tasks[idx].columnId = targetColumn
                            let nextRank = rankCursorByColumn[targetColumn]
                                .map(TaskRanking.after)
                                ?? TaskRanking.initial()
                            file.tasks[idx].rank = nextRank
                            rankCursorByColumn[targetColumn] = nextRank
                            touchedColumns.insert(targetColumn)
                            movedCount += 1
                            Self.debugLog(
                                "applyLinkedStatusSnapshots moved task=\(item.taskId.uuidString) " +
                                "from=\(old.columnId.rawValue) to=\(targetColumn.rawValue)"
                            )
                        } else {
                            Self.debugLog("applyLinkedStatusSnapshots already in target task=\(item.taskId.uuidString)")
                        }
                    } else if statusLabel != nil {
                        unmappedCount += 1
                        Self.debugLog(
                            "applyLinkedStatusSnapshots unmapped task=\(item.taskId.uuidString) status=\(statusLabel ?? "nil")"
                        )
                    }

                    if file.tasks[idx] != old {
                        file.tasks[idx].updatedAt = now
                        updatedCount += 1
                        didChange = true
                    } else {
                        Self.debugLog("applyLinkedStatusSnapshots no record change task=\(item.taskId.uuidString)")
                    }
                }

                for columnId in touchedColumns {
                    didChange = TaskBoardStore.rebalanceColumnIfNeeded(columnId, in: &file) || didChange
                }

                file.settings.remoteSync.lastError = nil
                return didChange || hadLastError
            }

            if changed {
                try store.saveNow()
                Self.debugLog("applyLinkedStatusSnapshots saved changes")
            } else {
                Self.debugLog("applyLinkedStatusSnapshots no changes to save")
            }
            let failureSuffix = failureCount > 0 ? " \(failureCount) failed." : ""
            let unmappedSuffix = unmappedCount > 0 ? " \(unmappedCount) had no mapped local column." : ""
            let fallbackSuffix = projectedFallbackCount > 0 ? " Used displayed status for \(projectedFallbackCount)." : ""
            let message = String(
                localized: "tasks.settings.columns.syncedRemoteStatusesWithTasks",
                defaultValue: "Remote statuses synced. Updated \(updatedCount) linked tasks, moved \(movedCount).\(unmappedSuffix)\(fallbackSuffix)\(failureSuffix)",
                table: "TermLoop"
            )
            Self.debugLog("applyLinkedStatusSnapshots complete message=\(message)")
            finishSync(message: message)
            if showCompletionAlert {
                presentSyncResultAlert(
                    title: String(localized: "tasks.remoteSync.status.alert.title",
                                  defaultValue: "Remote Status Sync Complete",
                                  table: "TermLoop"),
                    message: message
                )
            }
        } catch {
            finishSync(error: error)
        }
    }

    nonisolated private static func remoteStatusColumnLookup(_ columns: [TaskColumnSettings]) -> [String: TaskColumnId] {
        var lookup: [String: TaskColumnId] = [:]
        for column in TaskBoardSettings.normalizedColumns(columns) {
            guard let key = remoteStatusLookupKey(column.remoteStatusLabel) else { continue }
            lookup[key] = column.columnId
        }
        return lookup
    }

    nonisolated private static func ensureRemoteStatusColumn(_ status: String, in columns: inout [TaskColumnSettings]) {
        let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let columnId = TaskColumnId.fromRemoteStatus(trimmed)
        var normalized = TaskBoardSettings.normalizedColumns(columns)
        if let idx = normalized.firstIndex(where: { $0.columnId == columnId }) {
            normalized[idx].isEnabled = true
            normalized[idx].remoteStatusLabel = trimmed
            if normalized[idx].title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                normalized[idx].title == normalized[idx].columnId.defaultTitle {
                normalized[idx].title = trimmed
            }
        } else {
            normalized.append(TaskColumnSettings(
                columnId: columnId,
                title: trimmed,
                isEnabled: true,
                remoteStatusLabel: trimmed
            ))
        }
        columns = TaskBoardSettings.normalizedColumns(normalized)
    }

    nonisolated private static func remoteStatusLookupKey(_ value: String?) -> String? {
        value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty?
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .lowercased()
    }

    nonisolated private static func lastRankByColumn(_ tasks: [TaskRecord]) -> [TaskColumnId: String] {
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

    private static func remoteStatusLabel(
        _ actualStatus: String?,
        matches option: RemoteWorkItemStatusOption,
        targetStatus: String
    ) -> Bool {
        guard let actual = actualStatus?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty else {
            return false
        }
        return [
            targetStatus,
            option.label,
            option.targetState,
            option.providerPayload["targetStatusLabel"]
        ]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty }
        .contains { expected in
            actual.compare(expected, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }
    }

    private static func fallbackJiraStatusOption(
        reference: RemoteWorkItemReference,
        targetStatus: String
    ) -> RemoteWorkItemStatusOption? {
        guard reference.provider == .jira else { return nil }
        let trimmed = targetStatus.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return RemoteWorkItemStatusOption(
            id: "jira.status.manual.\(trimmed.lowercased().replacingOccurrences(of: " ", with: "-"))",
            label: trimmed,
            targetState: trimmed,
            providerPayload: ["targetStatusLabel": trimmed]
        )
    }

    private func hydrateRemoteMetadataFromCache() {
        let cache = readMetadataCache()
        if let accountEntry = cache.jiraAccounts, !accountEntry.value.isEmpty {
            jiraAccountOptions = accountEntry.value
            jiraAccountsCachedAt = accountEntry.updatedAt
        }
        let containerEntry = cache.containers[Self.containerCacheKey(settings)]
        containerOptions = containerEntry?.value ?? []
        containerOptionsCachedAt = containerEntry?.updatedAt
        if let issueTypeEntry = cache.issueTypes[Self.issueTypeCacheKey(settings)] {
            issueTypeOptions = issueTypeEntry.value
            issueTypeOptionsMessage = nil
        } else {
            issueTypeOptions = []
            issueTypeOptionsMessage = nil
        }
        if let statusEntry = cache.statuses[Self.statusCacheKey(settings)] {
            remoteStatusOptions = statusEntry.value.map(TaskRemoteStatusOption.init)
            remoteStatusOptionsCachedAt = statusEntry.updatedAt
        } else if settings.provider != .jira {
            remoteStatusOptions = Self.defaultStatusLabels(for: settings.provider).map(TaskRemoteStatusOption.init)
            remoteStatusOptionsCachedAt = nil
        } else {
            remoteStatusOptions = []
            remoteStatusOptionsCachedAt = nil
        }
    }

    private func persistJiraAccountsToCache(_ options: [TaskRemoteJiraAccountOption]) {
        var cache = readMetadataCache()
        let now = Date()
        cache.jiraAccounts = TaskRemoteMetadataCacheEntry(value: options, updatedAt: now)
        writeMetadataCache(cache)
        jiraAccountsCachedAt = now
    }

    private func persistContainerOptionsToCache(_ options: [TaskRemoteContainerOption], settings: TaskRemoteSyncSettings) {
        var cache = readMetadataCache()
        let now = Date()
        cache.containers[Self.containerCacheKey(settings)] = TaskRemoteMetadataCacheEntry(value: options, updatedAt: now)
        writeMetadataCache(cache)
        if Self.containerCacheKey(settings) == Self.containerCacheKey(self.settings) {
            containerOptionsCachedAt = now
        }
    }

    private func persistIssueTypeOptionsToCache(_ options: [TaskRemoteIssueTypeOption], settings: TaskRemoteSyncSettings) {
        var cache = readMetadataCache()
        let now = Date()
        cache.issueTypes[Self.issueTypeCacheKey(settings)] = TaskRemoteMetadataCacheEntry(value: options, updatedAt: now)
        writeMetadataCache(cache)
    }

    private func persistStatusLabelsToCache(_ labels: [String], settings: TaskRemoteSyncSettings) {
        var cache = readMetadataCache()
        let now = Date()
        cache.statuses[Self.statusCacheKey(settings)] = TaskRemoteMetadataCacheEntry(value: labels, updatedAt: now)
        writeMetadataCache(cache)
        if Self.statusCacheKey(settings) == Self.statusCacheKey(self.settings) {
            remoteStatusOptionsCachedAt = now
        }
    }

    private func readMetadataCache() -> TaskRemoteMetadataCacheFile {
        metadataCache
    }

    private func writeMetadataCache(_ cache: TaskRemoteMetadataCacheFile) {
        metadataCache = cache
        metadataCacheMutationCount += 1
        let url = metadataCacheURL()
        Task.detached(priority: .utility) {
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
    }

    private func applyInitialMetadataCache(_ cache: TaskRemoteMetadataCacheFile) {
        guard metadataCacheMutationCount == 0 else { return }
        metadataCache = cache
        hydrateRemoteMetadataFromCache()
    }

    nonisolated private static func loadMetadataCacheFromDisk(at url: URL) async -> TaskRemoteMetadataCacheFile {
        await Task.detached(priority: .utility) {
            readMetadataCacheFromDisk(at: url)
        }.value
    }

    nonisolated private static func readMetadataCacheFromDisk(at url: URL) -> TaskRemoteMetadataCacheFile {
        guard let data = try? Data(contentsOf: url),
              let cache = try? JSONDecoder.tasks.decode(TaskRemoteMetadataCacheFile.self, from: data) else {
            return TaskRemoteMetadataCacheFile()
        }
        return cache
    }

    private func metadataCacheURL() -> URL {
        store.projectRoot.appendingPathComponent(".termloop/remote-work-items-cache.json")
    }

    private static func containerCacheKey(_ settings: TaskRemoteSyncSettings) -> String {
        [settings.provider.rawValue, settings.jiraSite ?? "", settings.jiraEmail ?? ""]
            .joined(separator: "|")
    }

    private static func remoteWorkItemContextKey(_ settings: TaskRemoteSyncSettings) -> String {
        [containerCacheKey(settings), settings.container ?? ""].joined(separator: "|")
    }

    private static func statusCacheKey(_ settings: TaskRemoteSyncSettings) -> String {
        [remoteWorkItemContextKey(settings), "status-v2"].joined(separator: "|")
    }

    private static func issueTypeCacheKey(_ settings: TaskRemoteSyncSettings) -> String {
        [remoteWorkItemContextKey(settings), "issue-types-v1"].joined(separator: "|")
    }

    public func loadCLIStatusesIfNeeded() {
        guard cliStatuses.count < RemoteWorkItemProviderId.allCases.count else { return }
        loadCLIStatuses()
    }

    public func loadCLIStatuses() {
        guard settings.isEnabled else { return }
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
                if Task.isCancelled { return }
                let status = await Self.probeCLIStatus(provider)
                if Task.isCancelled { return }
                await MainActor.run {
                    guard let self, self.settings.isEnabled else { return }
                    self.cliStatuses[provider] = status
                }
            }
        }
    }

    func refreshCLIStatus(for provider: RemoteWorkItemProviderId) async -> TaskRemoteCLIStatus {
        let status = await Self.probeCLIStatus(provider)
        cliStatuses[provider] = status
        return status
    }

    func refreshCLIStatusSynchronously(
        for provider: RemoteWorkItemProviderId,
        timeout: TimeInterval = 4
    ) -> TaskRemoteCLIStatus {
        let status = Self.probeCLIStatusSynchronously(provider, timeout: timeout)
        cliStatuses[provider] = status
        return status
    }

    private static func probeCLIStatus(_ provider: RemoteWorkItemProviderId) async -> TaskRemoteCLIStatus {
        await probeCLIStatusNow(provider)
    }

    private nonisolated static func probeCLIStatusSynchronously(
        _ provider: RemoteWorkItemProviderId,
        timeout: TimeInterval
    ) -> TaskRemoteCLIStatus {
        let executable = cliExecutable(for: provider)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [executable, "--version"]
        process.environment = RemoteWorkItemCommandRunner.sanitizedEnvironment(ProcessInfo.processInfo.environment)

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        let semaphore = DispatchSemaphore(value: 0)
        do {
            process.terminationHandler = { _ in semaphore.signal() }
            try process.run()
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

        let timedOut = semaphore.wait(timeout: .now() + timeout) == .timedOut
        if timedOut, process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
        let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let result = RemoteWorkItemCommandResult(
            executable: executable,
            arguments: ["--version"],
            cwd: nil,
            exitStatus: timedOut ? 124 : process.terminationStatus,
            stdout: stdout,
            stderr: stderr,
            timedOut: timedOut,
            terminatedBySignal: process.terminationReason == .uncaughtSignal
        )
        let output = (stdout + "\n" + stderr)
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
    }

    private nonisolated static func probeCLIStatusNow(_ provider: RemoteWorkItemProviderId) async -> TaskRemoteCLIStatus {
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

    private nonisolated static func cliExecutable(for provider: RemoteWorkItemProviderId) -> String {
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
            return try await JiraRemoteWorkItemProvider(
                site: settings.jiraSite,
                email: settings.jiraEmail
            )
            .projectOptions()
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

    private static func fetchIssueTypeOptions(settings: TaskRemoteSyncSettings) async throws -> [TaskRemoteIssueTypeOption] {
        guard settings.provider == .jira else { return [] }
        guard let projectKey = settings.container?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty else {
            throw RemoteWorkItemError.unsupportedReference("Jira issue type lookup requires a project key")
        }
        return try await JiraRemoteWorkItemProvider(
            site: settings.jiraSite,
            email: settings.jiraEmail
        )
        .issueTypeOptions(projectKey: projectKey)
    }

    private static func fetchRemoteStatusLabels(settings: TaskRemoteSyncSettings) async throws -> [String] {
        switch settings.provider {
        case .jira:
            let selectedProject = settings.container?.trimmingCharacters(in: .whitespacesAndNewlines)
            debugLog("fetchRemoteStatusLabels jira provider project=\(selectedProject ?? "nil")")
            let labels = try await JiraRemoteWorkItemProvider(
                site: settings.jiraSite,
                email: settings.jiraEmail
            )
            .statusLabels(projectKey: selectedProject)
            guard !labels.isEmpty else {
                throw RemoteWorkItemError.parseFailed("Jira status search returned no status labels.")
            }
            debugLog("fetchRemoteStatusLabels jira provider labels=\(labels.joined(separator: " | "))")
            return labels
        case .github, .gitlab:
            return defaultStatusLabels(for: settings.provider)
        }
    }

    private static func defaultStatusLabels(for provider: RemoteWorkItemProviderId) -> [String] {
        switch provider {
        case .jira:
            return taskRemoteDefaultJiraStatuses
        case .github:
            return ["open", "closed"]
        case .gitlab:
            return ["opened", "closed"]
        }
    }

    private static func missingContainerMessage(for provider: RemoteWorkItemProviderId) -> String {
        switch provider {
        case .jira:
            return String(localized: "tasks.remoteSync.create.missingJiraProject",
                          defaultValue: "Select a Jira project before creating a remote work item.",
                          table: "TermLoop")
        case .github:
            return String(localized: "tasks.remoteSync.create.missingGitHubRepo",
                          defaultValue: "Select a GitHub repository before creating a remote work item.",
                          table: "TermLoop")
        case .gitlab:
            return String(localized: "tasks.remoteSync.create.missingGitLabProject",
                          defaultValue: "Select a GitLab project before creating a remote work item.",
                          table: "TermLoop")
        }
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

    private nonisolated static func humanError(_ error: Error) -> String {
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

    private nonisolated static func commandFailureMessage(
        _ result: RemoteWorkItemCommandResult,
        fallback: String
    ) -> String {
        return remoteCommandFailureMessage(result, fallback: fallback)
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

    private func presentSyncResultAlert(
        title: String,
        message: String,
        style: NSAlert.Style = .informational
    ) {
        let alert = NSAlert()
        alert.messageText = title
        alert.alertStyle = style
        if message.count > 240 || message.contains("\n") {
            alert.informativeText = String(localized: "tasks.remoteSync.alert.details",
                                           defaultValue: "Details:",
                                           table: "TermLoop")
            let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 560, height: 180))
            scrollView.hasVerticalScroller = true
            scrollView.hasHorizontalScroller = true
            scrollView.borderType = .bezelBorder

            let textView = NSTextView(frame: scrollView.bounds)
            textView.isEditable = false
            textView.isSelectable = true
            textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            textView.string = message
            textView.textContainer?.containerSize = NSSize(
                width: CGFloat.greatestFiniteMagnitude,
                height: CGFloat.greatestFiniteMagnitude
            )
            textView.textContainer?.widthTracksTextView = false
            scrollView.documentView = textView
            alert.accessoryView = scrollView
        } else {
            alert.informativeText = message
        }
        alert.addButton(withTitle: String(localized: "common.ok",
                                          defaultValue: "OK",
                                          table: "TermLoop"))
        alert.runModal()
    }
}
