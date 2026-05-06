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

    public func remove(projectId: UUID) {
        stores.removeValue(forKey: projectId)
        projectRoots.removeValue(forKey: projectId)
    }

    public func removeAll() {
        stores.removeAll()
        projectRoots.removeAll()
    }

    public func store(for projectId: UUID) -> TaskBoardStore? {
        if let existing = stores[projectId] { return existing }
        let root: URL
        if let registered = projectRoots[projectId] {
            root = registered
        } else if let resolved = Self.resolveRoot(projectId) {
            // Lazy fallback: resolve via ProjectStore when no explicit registration
            // happened. Idempotent — caches the answer for next call.
            projectRoots[projectId] = resolved
            root = resolved
        } else {
            return nil
        }
        let store = TaskBoardStore(projectRoot: root, projectId: projectId)
        do {
            try store.loadOrCreate()
        } catch {
            #if DEBUG
            print("TaskBoardStoreProvider: failed to load tasks for \(projectId): \(error)")
            #endif
            return nil
        }
        stores[projectId] = store
        return store
    }

    /// Looks up the project's folder via the existing `ProjectStore`. Static so
    /// tests can replace the closure with their own resolver.
    static var resolveRoot: (UUID) -> URL? = { projectId in
        guard let project = ProjectStore.shared.project(id: projectId) else { return nil }
        return URL(fileURLWithPath: project.folderPath)
    }
}
