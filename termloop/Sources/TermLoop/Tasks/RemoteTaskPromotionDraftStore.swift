// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation

public enum RemoteTaskPromotionStatus: String, Codable, Equatable, Sendable {
    case drafted
    case awaitingConfirmation
    case creatingRemote
    case remoteCreated
    case bindingWorktree
    case launchingAgent
    case ready
    case failed
    case cancelled
}

public struct RemoteTaskPromotionDraft: Codable, Identifiable, Equatable, Sendable {
    public let id: UUID
    public let projectId: UUID
    public let sourceWorkspaceId: UUID
    public var title: String
    public var descriptionMarkdown: String
    public var issueType: String?
    public var provider: RemoteWorkItemProviderId
    public var container: String
    public var status: RemoteTaskPromotionStatus
    public var remoteWorkItem: RemoteWorkItemReference?
    public var taskId: UUID?
    public var targetWorkspaceId: UUID?
    public var worktreePath: String?
    public var errorMessage: String?
    public let createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID,
        projectId: UUID,
        sourceWorkspaceId: UUID,
        title: String,
        descriptionMarkdown: String,
        issueType: String? = nil,
        provider: RemoteWorkItemProviderId,
        container: String,
        status: RemoteTaskPromotionStatus = .awaitingConfirmation,
        remoteWorkItem: RemoteWorkItemReference? = nil,
        taskId: UUID? = nil,
        targetWorkspaceId: UUID? = nil,
        worktreePath: String? = nil,
        errorMessage: String? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.projectId = projectId
        self.sourceWorkspaceId = sourceWorkspaceId
        self.title = title
        self.descriptionMarkdown = descriptionMarkdown
        let trimmedIssueType = issueType?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.issueType = trimmedIssueType.isEmpty ? nil : trimmedIssueType
        self.provider = provider
        self.container = container
        self.status = status
        self.remoteWorkItem = remoteWorkItem
        self.taskId = taskId
        self.targetWorkspaceId = targetWorkspaceId
        self.worktreePath = worktreePath
        self.errorMessage = errorMessage
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

private struct RemoteTaskPromotionDraftFile: Codable, Equatable, Sendable {
    var schemaVersion: Int = 1
    var drafts: [RemoteTaskPromotionDraft] = []
}

@MainActor
public final class RemoteTaskPromotionDraftStore: ObservableObject {
    public let projectId: UUID
    public let projectRoot: URL

    @Published public private(set) var drafts: [RemoteTaskPromotionDraft] = []

    private let fileURL: URL
    private var file = RemoteTaskPromotionDraftFile()

    public init(projectId: UUID, projectRoot: URL) {
        self.projectId = projectId
        self.projectRoot = projectRoot
        self.fileURL = projectRoot
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("remote-task-promotions.json", isDirectory: false)
        load()
    }

    public func draft(id: UUID) -> RemoteTaskPromotionDraft? {
        file.drafts.first { $0.id == id }
    }

    @discardableResult
    public func upsert(_ draft: RemoteTaskPromotionDraft) throws -> RemoteTaskPromotionDraft {
        var next = draft
        next.updatedAt = Date()
        if let idx = file.drafts.firstIndex(where: { $0.id == next.id }) {
            file.drafts[idx] = next
        } else {
            file.drafts.append(next)
        }
        try saveNow()
        return next
    }

    public func update(id: UUID, _ mutate: (inout RemoteTaskPromotionDraft) -> Void) throws {
        guard let idx = file.drafts.firstIndex(where: { $0.id == id }) else { return }
        mutate(&file.drafts[idx])
        file.drafts[idx].updatedAt = Date()
        try saveNow()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder.tasks.decode(RemoteTaskPromotionDraftFile.self, from: data) else {
            file = RemoteTaskPromotionDraftFile()
            drafts = []
            return
        }
        file = decoded
        drafts = decoded.drafts
    }

    private func saveNow() throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder.tasks.encode(file)
        try data.write(to: fileURL, options: .atomic)
        drafts = file.drafts
    }
}

@MainActor
public final class RemoteTaskPromotionDraftStoreProvider {
    public static let shared = RemoteTaskPromotionDraftStoreProvider()

    private var stores: [UUID: RemoteTaskPromotionDraftStore] = [:]

    private init() {}

    public func store(projectId: UUID, projectRoot: URL) -> RemoteTaskPromotionDraftStore {
        let normalizedRoot = projectRoot.standardizedFileURL
        if let existing = stores[projectId],
           existing.projectRoot.standardizedFileURL == normalizedRoot {
            return existing
        }
        let store = RemoteTaskPromotionDraftStore(projectId: projectId, projectRoot: normalizedRoot)
        stores[projectId] = store
        return store
    }

    public func remove(projectId: UUID) {
        stores.removeValue(forKey: projectId)
    }

    public func removeAll() {
        stores.removeAll()
    }
}
