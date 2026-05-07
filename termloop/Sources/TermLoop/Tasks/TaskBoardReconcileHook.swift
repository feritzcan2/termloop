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
    /// Idempotent setup: registers the workspace lister so subsequent
    /// `projectDidActivate` calls have something to project from. Safe to call
    /// multiple times. Invoked from app start (TermLoopHooks).
    public static func bootstrap() {
        if TaskBoardStoreProvider.shared.workspaceLister == nil {
            TaskBoardStoreProvider.shared.workspaceLister = TaskBoardWorkspaceListingAdapter.shared
        }
        TaskBoardReconcileScheduler.shared.start()
    }

    public static func projectDidActivate(_ projectId: UUID?) {
        bootstrap()
        TaskBoardReconcileScheduler.shared.request(projectId: projectId, reason: "projectDidActivate")
    }
}
