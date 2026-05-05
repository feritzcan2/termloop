// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Fixed v1 column set. Configurable columns are deferred to v2.
public enum TaskColumnId: String, Codable, CaseIterable, Hashable, Sendable {
    case backlog
    case todo
    case inProgress = "in_progress"
    case inReview = "in_review"
    case done
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
}

public struct TaskRecord: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: UUID
    public let projectId: UUID
    public var title: String
    public var brief: String?
    public var columnId: TaskColumnId
    public var rank: String
    public var workspaceId: UUID?
    public var worktreePath: String?
    public var branch: String?
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
        columnId: TaskColumnId,
        rank: String,
        workspaceId: UUID? = nil,
        worktreePath: String? = nil,
        branch: String? = nil,
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
        self.columnId = columnId
        self.rank = rank
        self.workspaceId = workspaceId
        self.worktreePath = worktreePath
        self.branch = branch
        self.bindingGeneration = bindingGeneration
        self.provisionState = provisionState
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.archivedAt = archivedAt
    }
}

public struct TaskBoardFile: Codable, Equatable, Sendable {
    public static let currentSchemaVersion: Int = 1

    public var schemaVersion: Int
    public var tasks: [TaskRecord]
    public var updatedAt: Date

    public init(
        schemaVersion: Int = TaskBoardFile.currentSchemaVersion,
        tasks: [TaskRecord] = [],
        updatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.tasks = tasks
        self.updatedAt = updatedAt
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
    public let provisionState: TaskProvisionState
    public let branch: String?
    public let agentCount: Int
    public let hasTicket: Bool

    public init(
        id: UUID,
        title: String,
        provisionState: TaskProvisionState,
        branch: String?,
        agentCount: Int,
        hasTicket: Bool
    ) {
        self.id = id
        self.title = title
        self.provisionState = provisionState
        self.branch = branch
        self.agentCount = agentCount
        self.hasTicket = hasTicket
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
        self.provisionState = task.provisionState
        self.bindingGeneration = task.bindingGeneration
    }
}
