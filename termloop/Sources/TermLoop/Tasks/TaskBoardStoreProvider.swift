// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
public final class TaskBoardStoreProvider {
    public static let shared = TaskBoardStoreProvider()

    /// Injected lister — assigned at app startup from the existing
    /// WorkspaceMetadataStore-backed lister. Tests inject their own.
    public var workspaceLister: TaskBoardWorkspaceListing?

    private var stores: [UUID: TaskBoardStore] = [:]
    private var projectRoots: [UUID: URL] = [:]

    private init() {}

    public func registerProjectRoot(_ root: URL, for projectId: UUID) {
        projectRoots[projectId] = root
    }

    public func store(for projectId: UUID) -> TaskBoardStore? {
        if let existing = stores[projectId] { return existing }
        guard let root = projectRoots[projectId] else { return nil }
        let store = TaskBoardStore(projectRoot: root, projectId: projectId)
        try? store.loadOrCreate()
        stores[projectId] = store
        return store
    }
}
