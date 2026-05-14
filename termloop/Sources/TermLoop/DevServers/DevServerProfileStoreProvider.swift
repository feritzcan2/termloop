// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

@MainActor
public final class DevServerProfileStoreProvider: ObservableObject {
    public static let shared = DevServerProfileStoreProvider {
        DevServerProfileStoreProvider.defaultResolveRoot(projectId: $0)
    }

    private var stores: [UUID: DevServerProfileStore] = [:]
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
        projectRoots.removeValue(forKey: projectId)
        objectWillChange.send()
    }

    public func removeAll() {
        stores.removeAll()
        projectRoots.removeAll()
        objectWillChange.send()
    }

    public func store(for projectId: UUID) -> DevServerProfileStore? {
        if let existing = stores[projectId] { return existing }
        let root: URL
        if let registered = projectRoots[projectId] {
            root = registered
        } else if let resolved = resolveRoot(projectId) {
            projectRoots[projectId] = resolved
            root = resolved
        } else {
            return nil
        }
        let store = DevServerProfileStore(projectRoot: root, projectId: projectId)
        store.loadOrCreate()
        stores[projectId] = store
        return store
    }

    private static func defaultResolveRoot(projectId: UUID) -> URL? {
        guard let project = ProjectStore.shared.project(id: projectId) else { return nil }
        return URL(fileURLWithPath: project.folderPath)
    }
}
