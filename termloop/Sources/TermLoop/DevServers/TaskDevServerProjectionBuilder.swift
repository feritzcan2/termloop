// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
enum TaskDevServerProjectionBuilder {
    static func summaries(
        for tasks: [TaskRecord],
        projectId: UUID,
        runStore: DevServerRunStore
    ) -> [UUID: TaskDevServerSummary] {
        let runsByTask = Dictionary(
            grouping: runStore.snapshots(projectId: projectId).filter { $0.key.taskId != nil },
            by: { $0.key.taskId }
        )
        return Dictionary(uniqueKeysWithValues: tasks.compactMap { task in
            guard task.archivedAt == nil,
                  let runs = runsByTask[task.id],
                  !runs.isEmpty else {
                return nil
            }
            return (task.id, TaskDevServerSummary(taskId: task.id, runs: runs.sorted(by: isDisplayOrdered(_:_:))))
        })
    }

    static func summary(
        taskId: UUID,
        projectId: UUID,
        runStore: DevServerRunStore
    ) -> TaskDevServerSummary? {
        let runs = runStore.snapshots(projectId: projectId, taskId: taskId)
        guard !runs.isEmpty else { return nil }
        return TaskDevServerSummary(taskId: taskId, runs: runs.sorted(by: isDisplayOrdered(_:_:)))
    }

    private static func isDisplayOrdered(_ lhs: DevServerRunSnapshot, _ rhs: DevServerRunSnapshot) -> Bool {
        if lhs.isActive != rhs.isActive { return lhs.isActive }
        return lhs.updatedAt > rhs.updatedAt
    }
}
