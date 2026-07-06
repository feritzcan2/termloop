// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public struct TaskColumnId: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
    public var rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? Self.backlog.rawValue
            : rawValue
    }

    public init(stringLiteral value: String) {
        self.init(rawValue: value)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(rawValue: try container.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let backlog = TaskColumnId(rawValue: "backlog")
    public static let todo = TaskColumnId(rawValue: "todo")
    public static let inProgress = TaskColumnId(rawValue: "in_progress")
    public static let inReview = TaskColumnId(rawValue: "in_review")
    public static let done = TaskColumnId(rawValue: "done")
    public static let defaults: [TaskColumnId] = [.backlog, .todo, .inProgress, .inReview, .done]

    public var defaultTitle: String {
        if self == .backlog { return String(localized: "tasks.column.backlog", defaultValue: "Backlog", table: "TermLoop") }
        if self == .todo { return String(localized: "tasks.column.todo", defaultValue: "Todo", table: "TermLoop") }
        if self == .inProgress { return String(localized: "tasks.column.in_progress", defaultValue: "In Progress", table: "TermLoop") }
        if self == .inReview { return String(localized: "tasks.column.in_review", defaultValue: "In Review", table: "TermLoop") }
        if self == .done { return String(localized: "tasks.column.done", defaultValue: "Done", table: "TermLoop") }
        return rawValue
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    public static func fromRemoteStatus(_ status: String) -> TaskColumnId {
        let slug = status
            .lowercased()
            .unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "_" }
        let collapsed = String(slug)
            .split(separator: "_", omittingEmptySubsequences: true)
            .joined(separator: "_")
        switch collapsed {
        case "to_do", "todo": return .todo
        case "in_progress", "doing": return .inProgress
        case "in_review", "review": return .inReview
        case "done", "closed", "resolved": return .done
        case "backlog": return .backlog
        default: return TaskColumnId(rawValue: collapsed.isEmpty ? "remote_status" : "remote_\(collapsed)")
        }
    }
}

public enum TaskProvisionFailureReason {
    public static let interrupted = "interrupted"
    public static let worktreeMissing = "worktree missing"
    public static let provisioningUnavailable = "provisioning unavailable"
    public static let dirtySourceCheckout = "dirty source checkout"

    public static func localizedDisplayText(for reason: String) -> String {
        switch reason {
        case interrupted:
            return String(localized: "tasks.provision.failure.interrupted",
                          defaultValue: "Interrupted while provisioning",
                          table: "TermLoop")
        case worktreeMissing:
            return String(localized: "tasks.provision.failure.worktreeMissing",
                          defaultValue: "Worktree missing",
                          table: "TermLoop")
        case provisioningUnavailable:
            return String(localized: "tasks.provision.failure.provisioningUnavailable",
                          defaultValue: "Worktree could not be created. Check the project git state and retry.",
                          table: "TermLoop")
        case dirtySourceCheckout:
            return String(localized: "tasks.provision.failure.dirtySource",
                          defaultValue: "Project checkout has uncommitted changes.",
                          table: "TermLoop")
        default:
            return reason
        }
    }

    public static func isDirtySourceCheckout(_ reason: String) -> Bool {
        let normalized = reason
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .lowercased()
        return normalized == dirtySourceCheckout ||
            normalized.contains("dirty source") ||
            normalized.contains("dirty checkout") ||
            normalized.contains("uncommitted changes")
    }
}

public enum TaskProvisionState: Codable, Equatable, Hashable, Sendable {
    case none
    case pending
    case ready
    case failed(reason: String)

    public var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    public var displayLabel: String {
        switch self {
        case .none:
            return ""
        case .pending:
            return String(localized: "tasks.provision.pending",
                          defaultValue: "Provisioning…",
                          table: "TermLoop")
        case .ready:
            return String(localized: "tasks.provision.ready",
                          defaultValue: "Active",
                          table: "TermLoop")
        case .failed:
            return String(localized: "tasks.provision.failed",
                          defaultValue: "Failed",
                          table: "TermLoop")
        }
    }

    public var failureDisplayText: String? {
        guard case .failed(let reason) = self else { return nil }
        return TaskProvisionFailureReason.localizedDisplayText(for: reason)
    }
}

public enum TaskOrigin: String, Codable, Equatable, Hashable, Sendable {
    case manual
    case worktree
    case remote
}

public struct TaskRecord: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: UUID
    public let projectId: UUID
    public var title: String
    public var brief: String?
    public var origin: TaskOrigin
    public var remoteWorkItem: RemoteWorkItemReference?
    public var remoteStatusLabel: String?
    public var taskFilePath: String?
    public var lastRemoteSyncAt: Date?
    public var columnId: TaskColumnId
    public var rank: String
    public var workspaceId: UUID?
    public var worktreePath: String?
    public var branch: String?
    public var ownsWorktree: Bool
    public var bindingGeneration: Int
    public var provisionState: TaskProvisionState
    public let createdAt: Date
    public var updatedAt: Date
    public var archivedAt: Date?

    public init(
        id: UUID = UUID(),
        projectId: UUID,
        title: String,
        brief: String? = nil,
        origin: TaskOrigin = .manual,
        remoteWorkItem: RemoteWorkItemReference? = nil,
        remoteStatusLabel: String? = nil,
        taskFilePath: String? = nil,
        lastRemoteSyncAt: Date? = nil,
        columnId: TaskColumnId,
        rank: String,
        workspaceId: UUID? = nil,
        worktreePath: String? = nil,
        branch: String? = nil,
        ownsWorktree: Bool = false,
        bindingGeneration: Int = 0,
        provisionState: TaskProvisionState = .none,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        archivedAt: Date? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.title = title
        self.brief = brief
        self.origin = origin
        self.remoteWorkItem = remoteWorkItem
        self.remoteStatusLabel = remoteStatusLabel
        self.taskFilePath = taskFilePath
        self.lastRemoteSyncAt = lastRemoteSyncAt
        self.columnId = columnId
        self.rank = rank
        self.workspaceId = workspaceId
        self.worktreePath = worktreePath
        self.branch = branch
        self.ownsWorktree = ownsWorktree
        self.bindingGeneration = bindingGeneration
        self.provisionState = provisionState
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.archivedAt = archivedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case projectId
        case title
        case brief
        case origin
        case remoteWorkItem
        case remoteStatusLabel
        case taskFilePath
        case lastRemoteSyncAt
        case columnId
        case rank
        case workspaceId
        case worktreePath
        case branch
        case ownsWorktree
        case bindingGeneration
        case provisionState
        case createdAt
        case updatedAt
        case archivedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(UUID.self, forKey: .id)
        self.projectId = try container.decode(UUID.self, forKey: .projectId)
        self.title = try container.decode(String.self, forKey: .title)
        self.brief = try container.decodeIfPresent(String.self, forKey: .brief)
        self.remoteWorkItem = try container.decodeIfPresent(RemoteWorkItemReference.self, forKey: .remoteWorkItem)
        self.remoteStatusLabel = try container.decodeIfPresent(String.self, forKey: .remoteStatusLabel)
        self.taskFilePath = try container.decodeIfPresent(String.self, forKey: .taskFilePath)
        self.lastRemoteSyncAt = try container.decodeIfPresent(Date.self, forKey: .lastRemoteSyncAt)
        self.columnId = try container.decode(TaskColumnId.self, forKey: .columnId)
        self.rank = try container.decode(String.self, forKey: .rank)
        self.workspaceId = try container.decodeIfPresent(UUID.self, forKey: .workspaceId)
        self.worktreePath = try container.decodeIfPresent(String.self, forKey: .worktreePath)
        self.branch = try container.decodeIfPresent(String.self, forKey: .branch)
        self.ownsWorktree = try container.decodeIfPresent(Bool.self, forKey: .ownsWorktree) ?? false
        self.bindingGeneration = try container.decodeIfPresent(Int.self, forKey: .bindingGeneration) ?? 0
        self.provisionState = try container.decodeIfPresent(TaskProvisionState.self, forKey: .provisionState) ?? .none
        self.createdAt = try container.decode(Date.self, forKey: .createdAt)
        self.updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        self.archivedAt = try container.decodeIfPresent(Date.self, forKey: .archivedAt)
        self.origin = try container.decodeIfPresent(TaskOrigin.self, forKey: .origin)
            ?? TaskRecord.inferredOrigin(
                remoteWorkItem: remoteWorkItem,
                workspaceId: workspaceId,
                worktreePath: worktreePath,
                branch: branch
            )
    }

    private static func inferredOrigin(
        remoteWorkItem: RemoteWorkItemReference?,
        workspaceId: UUID?,
        worktreePath: String?,
        branch: String?
    ) -> TaskOrigin {
        if remoteWorkItem != nil { return .remote }
        if workspaceId != nil || worktreePath?.nilIfEmpty != nil || branch?.nilIfEmpty != nil {
            return .worktree
        }
        return .manual
    }
}

public enum TaskBackgroundSyncActivityLevel: String, Codable, Equatable, Sendable {
    case info
    case success
    case warning
    case error
}

public struct TaskBackgroundSyncActivityEntry: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var createdAt: Date
    public var level: TaskBackgroundSyncActivityLevel
    public var message: String
    public var remoteKey: String?

    public init(
        id: UUID = UUID(),
        createdAt: Date = Date(),
        level: TaskBackgroundSyncActivityLevel,
        message: String,
        remoteKey: String? = nil
    ) {
        self.id = id
        self.createdAt = createdAt
        self.level = level
        self.message = message
        self.remoteKey = remoteKey?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }
}

public struct TaskRemoteSyncSettings: Codable, Equatable, Sendable {
    public static let defaultBackgroundPollIntervalSeconds: TimeInterval = 300
    public static let minimumBackgroundPollIntervalSeconds: TimeInterval = 120
    public static let defaultAutoExecuteTemplateId = "task-auto-executor-agent"
    public static let defaultAutoExecuteMaxConcurrentAgents = 5
    public static let backgroundActivityLimit = 80
    public static let suppressedAssignedRemoteItemLimit = 1_000

    public var remoteItemsEnabled: Bool
    public var syncAssignedToMe: Bool
    public var backgroundSyncEnabled: Bool
    public var backgroundSyncAssignedToMe: Bool
    public var backgroundPollIntervalSeconds: TimeInterval
    public var backgroundLastCheckedAt: Date?
    public var backgroundLastMessage: String?
    public var backgroundLastError: String?
    public var backgroundJiraWatermark: Date?
    public var backgroundActivityLog: [TaskBackgroundSyncActivityEntry]
    public var suppressedAssignedRemoteItemKeys: [String: Date]
    public var autoCreateWorktree: Bool
    public var autoExecuteWithAgent: Bool
    public var autoExecuteMaxConcurrentAgents: Int
    public var autoExecuteAgentId: String?
    public var autoExecutePermissionModeRawValue: String
    public var autoExecuteTemplateId: String
    public var provider: RemoteWorkItemProviderId
    /// Per-provider selected container so switching tabs preserves each provider's project/repo.
    public var providerContainers: [RemoteWorkItemProviderId: String]
    /// Jira: optional Atlassian site host, e.g. "company.atlassian.net".
    public var jiraSite: String?
    /// Jira: optional account email used when switching between multiple ACLI accounts.
    public var jiraEmail: String?
    /// Jira: optional project key. GitHub/GitLab: owner/repo or group/project.
    public var container: String?
    public var limit: Int
    public var lastSyncedAt: Date?
    public var lastError: String?

    public init(
        remoteItemsEnabled: Bool = false,
        syncAssignedToMe: Bool = false,
        backgroundSyncEnabled: Bool = false,
        backgroundSyncAssignedToMe: Bool = true,
        backgroundPollIntervalSeconds: TimeInterval = TaskRemoteSyncSettings.defaultBackgroundPollIntervalSeconds,
        backgroundLastCheckedAt: Date? = nil,
        backgroundLastMessage: String? = nil,
        backgroundLastError: String? = nil,
        backgroundJiraWatermark: Date? = nil,
        backgroundActivityLog: [TaskBackgroundSyncActivityEntry] = [],
        suppressedAssignedRemoteItemKeys: [String: Date] = [:],
        autoCreateWorktree: Bool = false,
        autoExecuteWithAgent: Bool = false,
        autoExecuteMaxConcurrentAgents: Int = TaskRemoteSyncSettings.defaultAutoExecuteMaxConcurrentAgents,
        autoExecuteAgentId: String? = nil,
        autoExecutePermissionMode: String = "acceptEdits",
        autoExecuteTemplateId: String = TaskRemoteSyncSettings.defaultAutoExecuteTemplateId,
        provider: RemoteWorkItemProviderId = .jira,
        providerContainers: [RemoteWorkItemProviderId: String] = [:],
        jiraSite: String? = nil,
        jiraEmail: String? = nil,
        container: String? = nil,
        limit: Int = 50,
        lastSyncedAt: Date? = nil,
        lastError: String? = nil
    ) {
        self.remoteItemsEnabled = remoteItemsEnabled
        self.syncAssignedToMe = remoteItemsEnabled && syncAssignedToMe
        self.backgroundSyncEnabled = remoteItemsEnabled && backgroundSyncEnabled
        self.backgroundSyncAssignedToMe = backgroundSyncAssignedToMe
        self.backgroundPollIntervalSeconds = Self.normalizedBackgroundPollInterval(backgroundPollIntervalSeconds)
        self.backgroundLastCheckedAt = backgroundLastCheckedAt
        self.backgroundLastMessage = backgroundLastMessage?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.backgroundLastError = backgroundLastError?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.backgroundJiraWatermark = backgroundJiraWatermark
        self.backgroundActivityLog = Self.trimmedBackgroundActivityLog(backgroundActivityLog)
        self.suppressedAssignedRemoteItemKeys = Self.trimmedSuppressedAssignedRemoteItemKeys(suppressedAssignedRemoteItemKeys)
        self.autoCreateWorktree = remoteItemsEnabled && autoCreateWorktree
        self.autoExecuteWithAgent = remoteItemsEnabled && autoExecuteWithAgent
        self.autoExecuteMaxConcurrentAgents = Self.normalizedAutoExecuteMaxConcurrentAgents(autoExecuteMaxConcurrentAgents)
        self.autoExecuteAgentId = autoExecuteAgentId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.autoExecutePermissionModeRawValue = AgentTemplate.PermissionMode(rawValue: autoExecutePermissionMode)?.rawValue
            ?? AgentTemplate.PermissionMode.acceptEdits.rawValue
        self.autoExecuteTemplateId = autoExecuteTemplateId.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? Self.defaultAutoExecuteTemplateId
        self.provider = provider
        var containers = providerContainers.compactMapValues {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        }
        if let container = container?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
            containers[provider] = container
        }
        self.providerContainers = containers
        self.jiraSite = jiraSite?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.jiraEmail = jiraEmail?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.container = container?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.limit = max(1, min(limit, 500))
        self.lastSyncedAt = lastSyncedAt
        self.lastError = lastError
    }

    private enum CodingKeys: String, CodingKey {
        case remoteItemsEnabled
        case syncAssignedToMe
        case backgroundSyncEnabled
        case backgroundSyncAssignedToMe
        case backgroundPollIntervalSeconds
        case backgroundLastCheckedAt
        case backgroundLastMessage
        case backgroundLastError
        case backgroundJiraWatermark
        case backgroundActivityLog
        case suppressedAssignedRemoteItemKeys
        case autoCreateWorktree
        case autoExecuteWithAgent
        case autoExecuteMaxConcurrentAgents
        case autoExecuteAgentId
        case autoExecutePermissionModeRawValue
        case autoExecutePermissionMode
        case autoExecuteTemplateId
        case provider
        case providerContainers
        case jiraSite
        case jiraEmail
        case container
        case limit
        case lastSyncedAt
        case lastError
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.remoteItemsEnabled = try container.decodeIfPresent(Bool.self, forKey: .remoteItemsEnabled) ?? false
        let decodedSyncAssigned = try container.decodeIfPresent(Bool.self, forKey: .syncAssignedToMe) ?? false
        self.syncAssignedToMe = remoteItemsEnabled && decodedSyncAssigned
        let decodedBackgroundEnabled = try container.decodeIfPresent(Bool.self, forKey: .backgroundSyncEnabled) ?? false
        self.backgroundSyncEnabled = remoteItemsEnabled && decodedBackgroundEnabled
        self.backgroundSyncAssignedToMe = try container.decodeIfPresent(Bool.self, forKey: .backgroundSyncAssignedToMe) ?? true
        let decodedPollInterval = try container.decodeIfPresent(TimeInterval.self, forKey: .backgroundPollIntervalSeconds)
            ?? Self.defaultBackgroundPollIntervalSeconds
        self.backgroundPollIntervalSeconds = Self.normalizedBackgroundPollInterval(decodedPollInterval)
        self.backgroundLastCheckedAt = try container.decodeIfPresent(Date.self, forKey: .backgroundLastCheckedAt)
        self.backgroundLastMessage = try container.decodeIfPresent(String.self, forKey: .backgroundLastMessage)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.backgroundLastError = try container.decodeIfPresent(String.self, forKey: .backgroundLastError)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.backgroundJiraWatermark = try container.decodeIfPresent(Date.self, forKey: .backgroundJiraWatermark)
        self.backgroundActivityLog = Self.trimmedBackgroundActivityLog(
            try container.decodeIfPresent([TaskBackgroundSyncActivityEntry].self, forKey: .backgroundActivityLog) ?? []
        )
        self.suppressedAssignedRemoteItemKeys = Self.trimmedSuppressedAssignedRemoteItemKeys(
            try container.decodeIfPresent([String: Date].self, forKey: .suppressedAssignedRemoteItemKeys) ?? [:]
        )
        let decodedAutoCreateWorktree = try container.decodeIfPresent(Bool.self, forKey: .autoCreateWorktree) ?? false
        let decodedAutoExecuteWithAgent = try container.decodeIfPresent(Bool.self, forKey: .autoExecuteWithAgent) ?? false
        self.autoCreateWorktree = remoteItemsEnabled && decodedAutoCreateWorktree
        self.autoExecuteWithAgent = remoteItemsEnabled && decodedAutoExecuteWithAgent
        self.autoExecuteMaxConcurrentAgents = Self.normalizedAutoExecuteMaxConcurrentAgents(
            try container.decodeIfPresent(Int.self, forKey: .autoExecuteMaxConcurrentAgents)
                ?? Self.defaultAutoExecuteMaxConcurrentAgents
        )
        self.autoExecuteAgentId = try container.decodeIfPresent(String.self, forKey: .autoExecuteAgentId)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        if let raw = try container.decodeIfPresent(String.self, forKey: .autoExecutePermissionModeRawValue)
            ?? container.decodeIfPresent(String.self, forKey: .autoExecutePermissionMode),
           AgentTemplate.PermissionMode(rawValue: raw) != nil {
            self.autoExecutePermissionModeRawValue = raw
        } else {
            self.autoExecutePermissionModeRawValue = AgentTemplate.PermissionMode.acceptEdits.rawValue
        }
        self.autoExecuteTemplateId = (try container.decodeIfPresent(String.self, forKey: .autoExecuteTemplateId))?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? Self.defaultAutoExecuteTemplateId
        self.provider = try container.decodeIfPresent(RemoteWorkItemProviderId.self, forKey: .provider) ?? .jira
        var providerContainers = try container.decodeIfPresent([RemoteWorkItemProviderId: String].self, forKey: .providerContainers) ?? [:]
        providerContainers = providerContainers.compactMapValues {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        }
        self.jiraSite = try container.decodeIfPresent(String.self, forKey: .jiraSite)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.jiraEmail = try container.decodeIfPresent(String.self, forKey: .jiraEmail)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let activeContainer = try container.decodeIfPresent(String.self, forKey: .container)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        if let activeContainer {
            providerContainers[provider] = activeContainer
        }
        self.providerContainers = providerContainers
        self.container = activeContainer ?? providerContainers[provider]
        let decodedLimit = try container.decodeIfPresent(Int.self, forKey: .limit) ?? 50
        self.limit = max(1, min(decodedLimit, 500))
        self.lastSyncedAt = try container.decodeIfPresent(Date.self, forKey: .lastSyncedAt)
        self.lastError = try container.decodeIfPresent(String.self, forKey: .lastError)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        let activeContainer = self.container?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        var containers = providerContainers.compactMapValues {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        }
        if let activeContainer {
            containers[provider] = activeContainer
        }

        try container.encode(remoteItemsEnabled, forKey: .remoteItemsEnabled)
        try container.encode(remoteItemsEnabled && syncAssignedToMe, forKey: .syncAssignedToMe)
        try container.encode(remoteItemsEnabled && backgroundSyncEnabled, forKey: .backgroundSyncEnabled)
        try container.encode(backgroundSyncAssignedToMe, forKey: .backgroundSyncAssignedToMe)
        try container.encode(Self.normalizedBackgroundPollInterval(backgroundPollIntervalSeconds), forKey: .backgroundPollIntervalSeconds)
        try container.encodeIfPresent(backgroundLastCheckedAt, forKey: .backgroundLastCheckedAt)
        try container.encodeIfPresent(backgroundLastMessage?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty, forKey: .backgroundLastMessage)
        try container.encodeIfPresent(backgroundLastError?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty, forKey: .backgroundLastError)
        try container.encodeIfPresent(backgroundJiraWatermark, forKey: .backgroundJiraWatermark)
        try container.encode(Self.trimmedBackgroundActivityLog(backgroundActivityLog), forKey: .backgroundActivityLog)
        try container.encode(
            Self.trimmedSuppressedAssignedRemoteItemKeys(suppressedAssignedRemoteItemKeys),
            forKey: .suppressedAssignedRemoteItemKeys
        )
        try container.encode(remoteItemsEnabled && autoCreateWorktree, forKey: .autoCreateWorktree)
        try container.encode(remoteItemsEnabled && autoExecuteWithAgent, forKey: .autoExecuteWithAgent)
        try container.encode(Self.normalizedAutoExecuteMaxConcurrentAgents(autoExecuteMaxConcurrentAgents), forKey: .autoExecuteMaxConcurrentAgents)
        try container.encodeIfPresent(autoExecuteAgentId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty, forKey: .autoExecuteAgentId)
        try container.encode(autoExecutePermissionModeRawValue, forKey: .autoExecutePermissionModeRawValue)
        try container.encode(
            autoExecuteTemplateId.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? Self.defaultAutoExecuteTemplateId,
            forKey: .autoExecuteTemplateId
        )
        try container.encode(provider, forKey: .provider)
        try container.encode(containers, forKey: .providerContainers)
        try container.encodeIfPresent(jiraSite?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty, forKey: .jiraSite)
        try container.encodeIfPresent(jiraEmail?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty, forKey: .jiraEmail)
        try container.encodeIfPresent(activeContainer, forKey: .container)
        try container.encode(limit, forKey: .limit)
        try container.encodeIfPresent(lastSyncedAt, forKey: .lastSyncedAt)
        try container.encodeIfPresent(lastError, forKey: .lastError)
    }

    public var isEnabled: Bool { remoteItemsEnabled }
    public var isAssignedSyncEnabled: Bool { isEnabled && syncAssignedToMe }
    public var isBackgroundSyncEnabled: Bool { isEnabled && backgroundSyncEnabled }
    public var isBackgroundAssignedSyncEnabled: Bool { isBackgroundSyncEnabled && backgroundSyncAssignedToMe }
    public var isAutoCreateWorktreeEnabled: Bool { isBackgroundSyncEnabled && autoCreateWorktree }
    public var isAutoExecuteEnabled: Bool { isBackgroundSyncEnabled && autoExecuteWithAgent }
    var backgroundAutomationScopeKey: String {
        [
            provider.rawValue,
            Self.normalizedScopePart(jiraSite),
            Self.normalizedScopePart(jiraEmail),
            Self.normalizedScopePart(container)
        ].joined(separator: "|")
    }
    var resolvedAutoExecutePermissionMode: AgentTemplate.PermissionMode {
        get { AgentTemplate.PermissionMode(rawValue: autoExecutePermissionModeRawValue) ?? .acceptEdits }
        set { autoExecutePermissionModeRawValue = newValue.rawValue }
    }

    public static func normalizedBackgroundPollInterval(_ value: TimeInterval) -> TimeInterval {
        max(minimumBackgroundPollIntervalSeconds, min(value, 3600))
    }

    public static func normalizedAutoExecuteMaxConcurrentAgents(_ value: Int) -> Int {
        max(1, min(value, 10))
    }

    public static func trimmedBackgroundActivityLog(
        _ entries: [TaskBackgroundSyncActivityEntry]
    ) -> [TaskBackgroundSyncActivityEntry] {
        Array(entries.sorted { $0.createdAt > $1.createdAt }.prefix(backgroundActivityLimit))
    }

    mutating func suppressAssignedRemoteItem(_ reference: RemoteWorkItemReference, at date: Date = Date()) {
        suppressedAssignedRemoteItemKeys[reference.storageKey] = date
        suppressedAssignedRemoteItemKeys = Self.trimmedSuppressedAssignedRemoteItemKeys(suppressedAssignedRemoteItemKeys)
    }

    mutating func unsuppressAssignedRemoteItem(_ reference: RemoteWorkItemReference) {
        suppressedAssignedRemoteItemKeys.removeValue(forKey: reference.storageKey)
    }

    func isAssignedRemoteItemSuppressed(_ reference: RemoteWorkItemReference) -> Bool {
        suppressedAssignedRemoteItemKeys[reference.storageKey] != nil
    }

    public static func trimmedSuppressedAssignedRemoteItemKeys(_ keys: [String: Date]) -> [String: Date] {
        Dictionary(
            uniqueKeysWithValues: keys
                .sorted { $0.value > $1.value }
                .prefix(suppressedAssignedRemoteItemLimit)
                .map { ($0.key, $0.value) }
        )
    }

    private static func normalizedScopePart(_ value: String?) -> String {
        value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .nilIfEmpty
            ?? "-"
    }
}

public struct TaskColumnSettings: Codable, Equatable, Sendable, Identifiable {
    public var id: TaskColumnId { columnId }
    public var columnId: TaskColumnId
    public var title: String
    public var isEnabled: Bool
    /// Optional provider status label used when board moves are mirrored to remote work items.
    public var remoteStatusLabel: String?

    public init(
        columnId: TaskColumnId,
        title: String? = nil,
        isEnabled: Bool = true,
        remoteStatusLabel: String? = nil
    ) {
        self.columnId = columnId
        self.title = title ?? columnId.defaultTitle
        self.isEnabled = isEnabled
        self.remoteStatusLabel = remoteStatusLabel
    }

    private enum CodingKeys: String, CodingKey {
        case columnId
        case title
        case isEnabled
        case remoteStatusLabel
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.columnId = try container.decode(TaskColumnId.self, forKey: .columnId)
        self.title = try container.decodeIfPresent(String.self, forKey: .title) ?? columnId.defaultTitle
        self.isEnabled = try container.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? true
        self.remoteStatusLabel = try container.decodeIfPresent(String.self, forKey: .remoteStatusLabel)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(columnId, forKey: .columnId)
        try container.encode(title, forKey: .title)
        try container.encode(isEnabled, forKey: .isEnabled)
        try container.encodeIfPresent(remoteStatusLabel, forKey: .remoteStatusLabel)
    }
}

public struct TaskBoardSettings: Codable, Equatable, Sendable {
    public var remoteSync: TaskRemoteSyncSettings
    public var columns: [TaskColumnSettings]

    public init(
        remoteSync: TaskRemoteSyncSettings = TaskRemoteSyncSettings(),
        columns: [TaskColumnSettings] = TaskColumnId.defaults.map { TaskColumnSettings(columnId: $0) }
    ) {
        self.remoteSync = remoteSync
        self.columns = Self.normalizedColumns(columns)
    }

    private enum CodingKeys: String, CodingKey {
        case remoteSync
        case columns
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.remoteSync = try container.decodeIfPresent(TaskRemoteSyncSettings.self, forKey: .remoteSync)
            ?? TaskRemoteSyncSettings()
        self.columns = Self.normalizedColumns(
            try container.decodeIfPresent([TaskColumnSettings].self, forKey: .columns) ?? []
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(remoteSync, forKey: .remoteSync)
        try container.encode(Self.normalizedColumns(columns), forKey: .columns)
    }

    public static func normalizedColumns(_ input: [TaskColumnSettings]) -> [TaskColumnSettings] {
        var result = input
        if result.isEmpty {
            result = TaskColumnId.defaults.map { TaskColumnSettings(columnId: $0) }
        }
        var seen = Set<TaskColumnId>()
        result = result.compactMap { column in
            guard !seen.contains(column.columnId) else { return nil }
            seen.insert(column.columnId)
            var value = column
            let trimmed = value.title.trimmingCharacters(in: .whitespacesAndNewlines)
            value.title = trimmed.isEmpty ? value.columnId.defaultTitle : trimmed
            let remote = value.remoteStatusLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            value.remoteStatusLabel = remote.isEmpty ? nil : remote
            return value
        }
        if !result.contains(where: { $0.columnId == .backlog }) {
            result.insert(TaskColumnSettings(columnId: .backlog), at: 0)
        }
        return result
    }
}

public struct TaskBoardFile: Codable, Equatable, Sendable {
    public static let currentSchemaVersion: Int = 2

    public var schemaVersion: Int
    public var settings: TaskBoardSettings
    public var tasks: [TaskRecord]
    public var updatedAt: Date

    public init(
        schemaVersion: Int = TaskBoardFile.currentSchemaVersion,
        settings: TaskBoardSettings = TaskBoardSettings(),
        tasks: [TaskRecord] = [],
        updatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.settings = settings
        self.tasks = tasks
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case settings
        case tasks
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        self.settings = try container.decodeIfPresent(TaskBoardSettings.self, forKey: .settings)
            ?? TaskBoardSettings()
        self.tasks = try container.decode([TaskRecord].self, forKey: .tasks)
        self.updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(TaskBoardFile.currentSchemaVersion, forKey: .schemaVersion)
        try container.encode(settings, forKey: .settings)
        try container.encode(tasks, forKey: .tasks)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

/// Value-type snapshot the store emits per column for the board to render
/// without subscribing to the entire task list.
public struct TaskColumnSnapshot: Equatable, Identifiable, Sendable {
    public let id: TaskColumnId
    public let cards: [TaskCardSummary]

    public init(id: TaskColumnId, cards: [TaskCardSummary]) {
        self.id = id
        self.cards = cards
    }
}

public struct TaskCardSummary: Equatable, Identifiable, Hashable, Sendable {
    public let id: UUID
    public let title: String
    public let brief: String?
    public let provisionState: TaskProvisionState
    public let workspaceId: UUID?
    public let branch: String?
    public let hasTicket: Bool
    public let remoteWorkItem: RemoteWorkItemReference?
    public let remoteStatusLabel: String?
    public let taskFilePath: String?
    public let worktreePath: String?

    public init(
        id: UUID,
        title: String,
        brief: String? = nil,
        provisionState: TaskProvisionState,
        workspaceId: UUID? = nil,
        branch: String?,
        hasTicket: Bool,
        remoteWorkItem: RemoteWorkItemReference? = nil,
        remoteStatusLabel: String? = nil,
        taskFilePath: String? = nil,
        worktreePath: String? = nil
    ) {
        self.id = id
        self.title = title
        self.brief = brief
        self.provisionState = provisionState
        self.workspaceId = workspaceId
        self.branch = branch
        self.hasTicket = hasTicket
        self.remoteWorkItem = remoteWorkItem
        self.remoteStatusLabel = remoteStatusLabel
        self.taskFilePath = taskFilePath
        self.worktreePath = worktreePath
    }
}

/// Snapshot used by the bottom detail pane.
public struct TaskDetailSnapshot: Equatable, Sendable {
    public let id: UUID
    public let title: String
    public let columnId: TaskColumnId
    public let brief: String?
    public let workspaceId: UUID?
    public let worktreePath: String?
    public let branch: String?
    public let remoteWorkItem: RemoteWorkItemReference?
    public let remoteStatusLabel: String?
    public let taskFilePath: String?
    public let lastRemoteSyncAt: Date?
    public let provisionState: TaskProvisionState
    public let bindingGeneration: Int

    public init(task: TaskRecord) {
        self.id = task.id
        self.title = task.title
        self.columnId = task.columnId
        self.brief = task.brief
        self.workspaceId = task.workspaceId
        self.worktreePath = task.worktreePath
        self.branch = task.branch
        self.remoteWorkItem = task.remoteWorkItem
        self.remoteStatusLabel = task.remoteStatusLabel
        self.taskFilePath = task.taskFilePath
        self.lastRemoteSyncAt = task.lastRemoteSyncAt
        self.provisionState = task.provisionState
        self.bindingGeneration = task.bindingGeneration
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
