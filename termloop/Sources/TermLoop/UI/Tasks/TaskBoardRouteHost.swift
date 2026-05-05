// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Per-window host that resolves the per-project `TaskBoardStore` and the
/// per-window `TaskSelectionStore`, then renders the Tasks page. Lives at the
/// route boundary so the rest of the Tasks UI doesn't reach into globals.
@MainActor
struct TaskBoardRouteHost: View {
    let projectId: UUID

    @StateObject private var selection = TaskSelectionStore()

    var body: some View {
        if let store = TaskBoardStoreProvider.shared.store(for: projectId) {
            TaskBoardPage(
                store: store,
                selection: selection,
                coordinator: TaskLifecycleCoordinator.makeForProject(store: store)
            )
        } else {
            // Project not yet registered (rare race during startup) — placeholder
            // until reconcile registers it. The host re-renders on store mutation.
            Text(String(localized: "tasks.empty.noProject",
                        defaultValue: "Loading tasks…", table: "TermLoop"))
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
