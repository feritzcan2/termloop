// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation

@MainActor
public final class TaskBoardStoreProvider: ObservableObject {
    public static let shared = TaskBoardStoreProvider {
        TaskBoardStoreProvider.defaultResolveRoot(projectId: $0)
    }

    /// Injected lister — assigned at app startup from the existing
    /// WorkspaceMetadataStore-backed lister. Tests inject their own.
    public var workspaceLister: TaskBoardWorkspaceListing?

    private var stores: [UUID: TaskBoardStore] = [:]
    private var projectRoots: [UUID: URL] = [:]
    private let resolveRoot: (UUID) -> URL?

    private init(resolveRoot: @escaping (UUID) -> URL?) {
        self.resolveRoot = resolveRoot
    }

    public func registerProjectRoot(_ root: URL, for projectId: UUID) {
        projectRoots[projectId] = root
        objectWillChange.send()
    }

    public func remove(projectId: UUID) {
        stores.removeValue(forKey: projectId)
        TaskRemoteSyncCoordinatorProvider.shared.remove(projectId: projectId)
        RemoteTaskPromotionDraftStoreProvider.shared.remove(projectId: projectId)
        projectRoots.removeValue(forKey: projectId)
        objectWillChange.send()
    }

    public func removeAll() {
        stores.removeAll()
        TaskRemoteSyncCoordinatorProvider.shared.removeAll()
        RemoteTaskPromotionDraftStoreProvider.shared.removeAll()
        projectRoots.removeAll()
        objectWillChange.send()
    }

    public func store(for projectId: UUID) -> TaskBoardStore? {
        if let existing = stores[projectId] { return existing }
        let root: URL
        if let registered = projectRoots[projectId] {
            root = registered
        } else if let resolved = resolveRoot(projectId) {
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

    private static func defaultResolveRoot(projectId: UUID) -> URL? {
        guard let project = ProjectStore.shared.project(id: projectId) else { return nil }
        return URL(fileURLWithPath: project.folderPath)
    }
}

@MainActor
public final class TaskRemoteSyncCoordinatorProvider {
    public static let shared = TaskRemoteSyncCoordinatorProvider()

    private var coordinators: [UUID: TaskRemoteSyncCoordinator] = [:]

    private init() {}

    public func coordinator(for store: TaskBoardStore) -> TaskRemoteSyncCoordinator {
        if let existing = coordinators[store.projectId] {
            return existing
        }
        let coordinator = TaskRemoteSyncCoordinator(store: store)
        coordinators[store.projectId] = coordinator
        return coordinator
    }

    public func remove(projectId: UUID) {
        coordinators.removeValue(forKey: projectId)
    }

    public func removeAll() {
        coordinators.removeAll()
    }
}
