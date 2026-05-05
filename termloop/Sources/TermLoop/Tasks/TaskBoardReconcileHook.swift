// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Hook called when the active project changes (or on app start with a project
/// already loaded). Idempotent — safe to call repeatedly. Implements Task 8b
/// of the Tasks Page plan.
///
/// The hook deliberately fails silently: a missing store, missing workspace
/// lister, or reconcile error must not crash the app. Any surfaced repair
/// state ends up in the per-project `TaskBoardStore` for the UI to display.
@MainActor
public enum TaskBoardReconcileHook {
    public static func projectDidActivate(_ projectId: UUID?) {
        guard let projectId else { return }
        guard let store = TaskBoardStoreProvider.shared.store(for: projectId) else { return }
        guard let workspaces = TaskBoardStoreProvider.shared.workspaceLister else { return }
        let reconciler = TaskBoardImportReconciler(store: store, workspaces: workspaces)
        do {
            try reconciler.run()
        } catch {
            #if DEBUG
            print("TaskBoardReconcileHook: reconcile failed for \(projectId): \(error)")
            #endif
        }
    }
}
