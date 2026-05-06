// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

public struct TaskRemoteProjectOption: Identifiable, Equatable, Sendable {
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

public struct TaskRemoteStatusOption: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String

    public init(_ label: String) {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        self.label = trimmed
        self.id = trimmed.lowercased()
    }
}

@MainActor
public final class TaskRemoteSyncCoordinator: ObservableObject {
    @Published public private(set) var isSyncing: Bool = false
    @Published public private(set) var isLoadingProjects: Bool = false
    @Published public private(set) var isLoadingStatuses: Bool = false
    @Published public private(set) var projectOptions: [TaskRemoteProjectOption] = []
    @Published public private(set) var remoteStatusOptions: [TaskRemoteStatusOption] = []
    @Published public private(set) var lastMessage: String?

    private let store: TaskBoardStore
    private var syncTask: Task<Void, Never>?
    private var syncColumnsAfterLoadingStatuses = false

    public init(store: TaskBoardStore) {
        self.store = store
    }

    deinit {
        syncTask?.cancel()
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
                settings.remoteSync.container = trimmed.isEmpty ? nil : trimmed
                settings.remoteSync.lastError = nil
            }
            objectWillChange.send()
            loadRemoteStatusOptions()
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

    public func loadProjectOptionsIfNeeded() {
        guard projectOptions.isEmpty else { return }
        loadProjectOptions()
    }

    public func loadRemoteStatusOptionsIfNeeded() {
        guard remoteStatusOptions.isEmpty else { return }
        loadRemoteStatusOptions()
    }

    public func loadProjectOptions() {
        guard !isLoadingProjects else { return }
        isLoadingProjects = true
        Task(priority: .utility) { [weak self] in
            do {
                let result = try await RemoteWorkItemCommandRunner.shared.run(
                    executable: "acli",
                    arguments: ["jira", "project", "list", "--limit", "100", "--json"],
                    cwd: nil,
                    timeout: 20
                )
                guard result.exitStatus == 0, !result.timedOut else {
                    throw RemoteWorkItemError.commandFailed(
                        result.stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? "Could not list Jira projects."
                            : result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                    )
                }
                let options = try Self.parseProjectOptions(result.stdout)
                await MainActor.run {
                    self?.projectOptions = options
                    self?.isLoadingProjects = false
                }
            } catch {
                await MainActor.run {
                    self?.isLoadingProjects = false
                    self?.lastMessage = String(describing: error)
                }
            }
        }
    }

    public func loadRemoteStatusOptions() {
        guard !isLoadingStatuses else { return }
        isLoadingStatuses = true
        let selectedProject = settings.container?.trimmingCharacters(in: .whitespacesAndNewlines)
        let jql: String
        if let selectedProject, !selectedProject.isEmpty {
            jql = "project = \(selectedProject) ORDER BY updated DESC"
        } else {
            jql = "assignee = currentUser() ORDER BY updated DESC"
        }
        Task(priority: .utility) { [weak self] in
            do {
                let result = try await RemoteWorkItemCommandRunner.shared.run(
                    executable: "acli",
                    arguments: [
                        "jira", "workitem", "search",
                        "--jql", jql,
                        "--limit", "100",
                        "--fields", "status",
                        "--json"
                    ],
                    cwd: nil,
                    timeout: 20
                )
                guard result.exitStatus == 0, !result.timedOut else {
                    throw RemoteWorkItemError.commandFailed(
                        result.stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? "Could not list Jira statuses."
                            : result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                    )
                }
                let labels = try Self.parseStatusLabels(result.stdout)
                await MainActor.run {
                    self?.remoteStatusOptions = labels.map(TaskRemoteStatusOption.init)
                    self?.isLoadingStatuses = false
                    self?.syncPendingColumnsIfNeeded(labels)
                }
            } catch {
                await MainActor.run {
                    let labels = Self.defaultJiraStatuses
                    self?.remoteStatusOptions = labels.map(TaskRemoteStatusOption.init)
                    self?.isLoadingStatuses = false
                    self?.lastMessage = String(describing: error)
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
                let service = Self.makeRemoteWorkItemService()
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
        syncTask?.cancel()
        syncTask = Task(priority: .utility) { [weak self] in
            do {
                let service = Self.makeRemoteWorkItemService()
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
        syncTask?.cancel()
        syncTask = Task(priority: .utility) { [weak self] in
            do {
                let service = Self.makeRemoteWorkItemService()
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
        Task(priority: .utility) { [weak self] in
            do {
                let service = Self.makeRemoteWorkItemService()
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
        } catch {
            lastMessage = String(describing: error)
        }
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

    private static func makeRemoteWorkItemService() -> RemoteWorkItemService {
        RemoteWorkItemService(
            providers: [
                JiraRemoteWorkItemProvider(),
                GitHubRemoteWorkItemProvider(),
                GitLabRemoteWorkItemProvider()
            ]
        )
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

    private static func parseProjectOptions(_ text: String) throws -> [TaskRemoteProjectOption] {
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
            return TaskRemoteProjectOption(key: key, name: name)
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
