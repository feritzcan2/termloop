// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// One synthesized activity entry. Authored by `TaskActivityLogProviding`
/// implementations that read from existing TermLoop stores
/// (TerminalAgentActivityStore, WorkspaceMetadataStore, GitChangesMainAreaStore).
public struct TaskActivityLogEntry: Equatable, Identifiable, Sendable {
    public let id: UUID
    public let timestamp: Date
    public let title: String
    public let detail: String?

    public init(timestamp: Date, title: String, detail: String? = nil) {
        self.id = UUID()
        self.timestamp = timestamp
        self.title = title
        self.detail = detail
    }
}

/// Read-only projection of the last-N activity events scoped to a task.
@MainActor
public protocol TaskActivityLogProviding: AnyObject {
    func entries(for taskId: UUID, limit: Int) -> [TaskActivityLogEntry]
}

/// Default empty provider — used until a real provider is wired (Task 24).
@MainActor
public final class EmptyTaskActivityLogProvider: TaskActivityLogProviding {
    public static let shared = EmptyTaskActivityLogProvider()
    private init() {}
    public func entries(for taskId: UUID, limit: Int) -> [TaskActivityLogEntry] { [] }
}
