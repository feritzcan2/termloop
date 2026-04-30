// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
final class TaskSyncViewRegistry: ObservableObject {
    static let shared = TaskSyncViewRegistry()

    private var viewsByProject: [UUID: Set<UUID>] = [:]

    private init() {}

    func register(projectId: UUID) -> UUID {
        let token = UUID()
        viewsByProject[projectId, default: []].insert(token)
        TaskSyncRegistry.shared.visibilityChanged(projectId: projectId)
        return token
    }

    func unregister(projectId: UUID, token: UUID) {
        viewsByProject[projectId]?.remove(token)
        if viewsByProject[projectId]?.isEmpty == true {
            viewsByProject.removeValue(forKey: projectId)
        }
        TaskSyncRegistry.shared.visibilityChanged(projectId: projectId)
    }

    func isVisible(projectId: UUID) -> Bool {
        (viewsByProject[projectId]?.isEmpty == false)
    }
}
