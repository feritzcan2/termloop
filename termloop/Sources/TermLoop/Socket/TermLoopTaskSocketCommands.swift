// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Mobile-facing v2 socket commands for the project-scoped task board
/// (`.termloop/tasks.json`). Handlers are read-only or queue async lifecycle
/// work via `TaskLifecycleCoordinator`; clients refresh `tasks.list` to see
/// long-running provisioning state changes.
@MainActor
enum TermLoopTaskSocketCommands {
    static func handle(method: String, params: [String: Any]) -> TerminalController.V2CallResult? {
        switch method {
        case "tasks.list":        return tasksList(params)
        case "tasks.get":         return tasksGet(params)
        case "tasks.create":      return tasksCreate(params)
        case "tasks.update":      return tasksUpdate(params)
        case "tasks.move":        return tasksMove(params)
        case "tasks.archive":     return tasksArchive(params)
        case "tasks.start_agent": return tasksStartAgent(params)
        default:                  return nil
        }
    }

    // MARK: - Handlers

    private static func tasksList(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        let includeArchived = params["include_archived"] as? Bool ?? false

        // Same source the macOS Tasks board renders.
        let snapshots = store.columnSnapshots
        let titlesByColumn = columnTitlesMap(store: store, snapshots: snapshots)
        let columns: [[String: Any]] = snapshots.map { snapshot in
            [
                "id": snapshot.id.rawValue,
                "title": titlesByColumn[snapshot.id] ?? snapshot.id.defaultTitle
            ]
        }

        let visible = store.fileSnapshot().tasks.filter { task in
            includeArchived || task.archivedAt == nil
        }
        let payloads: [[String: Any]] = visible.map { task in
            taskPayload(task, columnTitle: titlesByColumn[task.columnId] ?? store.columnTitle(for: task.columnId))
        }
        return .ok([
            "project_id": store.projectId.uuidString,
            "tasks": payloads,
            "columns": columns,
            "include_archived": includeArchived
        ])
    }

    private static func tasksGet(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let taskId = uuidParam(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
            return .err(code: "not_found", message: "Task not found", data: nil)
        }
        let snapshots = store.columnSnapshots
        let titlesByColumn = columnTitlesMap(store: store, snapshots: snapshots)
        let columns: [[String: Any]] = snapshots.map { snapshot in
            [
                "id": snapshot.id.rawValue,
                "title": titlesByColumn[snapshot.id] ?? snapshot.id.defaultTitle
            ]
        }
        let columnTitle = titlesByColumn[task.columnId] ?? store.columnTitle(for: task.columnId)
        return .ok([
            "task": taskPayload(task, columnTitle: columnTitle),
            "columns": columns,
            "project_id": store.projectId.uuidString
        ])
    }

    private static func tasksCreate(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let title = nonEmptyParam(params, "title") else {
            return .err(code: "invalid_params", message: "Missing or empty title", data: nil)
        }
        let brief = nonEmptyParam(params, "brief")
        let columnId: TaskColumnId
        if let raw = nonEmptyParam(params, "column_id") {
            columnId = TaskColumnId(rawValue: raw)
        } else {
            columnId = .backlog
        }

        let coordinator = TaskLifecycleCoordinator.makeForProject(store: store)
        do {
            let id = try coordinator.createTask(title: title, columnId: columnId, brief: brief)
            guard let task = store.fileSnapshot().tasks.first(where: { $0.id == id }) else {
                return .err(code: "internal_error", message: "Task created but missing from store", data: nil)
            }
            let columnTitle = store.columnTitle(for: task.columnId)
            return .ok(["task": taskPayload(task, columnTitle: columnTitle)])
        } catch {
            return .err(code: "internal_error", message: error.localizedDescription, data: nil)
        }
    }

    private static func tasksUpdate(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let taskId = uuidParam(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        let coordinator = TaskLifecycleCoordinator.makeForProject(store: store)
        do {
            if let title = nonEmptyParam(params, "title") {
                try coordinator.updateTitle(taskId: taskId, title: title)
            }
            if params.keys.contains("brief") {
                let trimmed = (params["brief"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let next = (trimmed?.isEmpty ?? true) ? nil : trimmed
                try coordinator.updateBrief(taskId: taskId, brief: next)
            }
            guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
                return .err(code: "not_found", message: "Task not found", data: nil)
            }
            return .ok(["task": taskPayload(task, columnTitle: store.columnTitle(for: task.columnId))])
        } catch TaskLifecycleError.taskNotFound {
            return .err(code: "not_found", message: "Task not found", data: nil)
        } catch {
            return .err(code: "internal_error", message: error.localizedDescription, data: nil)
        }
    }

    private static func tasksMove(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let taskId = uuidParam(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        guard let columnRaw = nonEmptyParam(params, "column_id") else {
            return .err(code: "invalid_params", message: "Missing column_id", data: nil)
        }
        let column = TaskColumnId(rawValue: columnRaw)
        if let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }),
           task.columnId == column {
            return .ok(["ok": true, "task_id": taskId.uuidString, "column_id": column.rawValue])
        }
        let coordinator = TaskLifecycleCoordinator.makeForProject(store: store)
        // moveColumn persists + rebalances asynchronously; clients refresh
        // tasks.list (or tasks.get) to observe the new rank.
        Task {
            do {
                try await coordinator.moveColumn(taskId: taskId, to: column)
            } catch {
                #if DEBUG
                print("tasks.move failed: \(error)")
                #endif
            }
        }
        return .ok(["ok": true, "task_id": taskId.uuidString, "column_id": column.rawValue])
    }

    private static func tasksArchive(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let taskId = uuidParam(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        let coordinator = TaskLifecycleCoordinator.makeForProject(store: store)
        do {
            try coordinator.archiveTask(taskId)
            return .ok(["ok": true, "task_id": taskId.uuidString])
        } catch TaskLifecycleError.taskNotFound {
            return .err(code: "not_found", message: "Task not found", data: nil)
        } catch {
            return .err(code: "internal_error", message: error.localizedDescription, data: nil)
        }
    }

    private static func tasksStartAgent(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let taskId = uuidParam(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
            return .err(code: "not_found", message: "Task not found", data: nil)
        }
        let agentId = nonEmptyParam(params, "terminal_agent_id")
        let coordinator = TaskLifecycleCoordinator.makeForProject(store: store)

        if let workspaceId = task.workspaceId,
           AppDelegate.shared?.workspaceFor(tabId: workspaceId) != nil {
            // Already bound — just (re)set the terminal agent metadata so the
            // mobile client can land on a configured workspace.
            if let agentId {
                WorkspaceMetadataStore.shared.setTerminalAgentId(agentId, for: workspaceId)
            }
            return .ok([
                "task_id": taskId.uuidString,
                "workspace_id": workspaceId.uuidString,
                "worktree_path": orNull(task.worktreePath),
                "branch": orNull(task.branch),
                "status": "ready"
            ])
        }

        if task.provisionState == .pending {
            return .ok([
                "task_id": taskId.uuidString,
                "status": "provisioning"
            ])
        }

        // Not bound — start provisioning in the background. Client polls
        // tasks.list to observe provision_state ready + workspace_id.
        Task {
            do {
                try await coordinator.bindWorktree(taskId: taskId)
                if let agentId,
                   let updated = store.fileSnapshot().tasks.first(where: { $0.id == taskId }),
                   let wsId = updated.workspaceId {
                    WorkspaceMetadataStore.shared.setTerminalAgentId(agentId, for: wsId)
                }
            } catch {
                #if DEBUG
                print("tasks.start_agent bind failed: \(error)")
                #endif
            }
        }
        return .ok([
            "task_id": taskId.uuidString,
            "status": "provisioning"
        ])
    }

    // MARK: - Helpers

    private enum StoreResolution {
        case success(TaskBoardStore)
        case failure(TerminalController.V2CallResult)
    }

    private static func resolveStore(_ params: [String: Any]) -> StoreResolution {
        let projectId: UUID
        if let pid = uuidParam(params, "project_id") {
            projectId = pid
        } else if let active = ProjectStore.shared.activeProjectId {
            projectId = active
        } else {
            return .failure(.err(code: "no_project", message: "No active project", data: nil))
        }
        guard let store = TaskBoardStoreProvider.shared.store(for: projectId) else {
            return .failure(.err(code: "store_unavailable",
                                 message: "Could not load task board for project",
                                 data: nil))
        }
        return .success(store)
    }

    private static func taskPayload(_ task: TaskRecord, columnTitle: String) -> [String: Any] {
        var payload: [String: Any] = [
            "id": task.id.uuidString,
            "project_id": task.projectId.uuidString,
            "title": task.title,
            "brief": orNull(task.brief),
            "origin": task.origin.rawValue,
            "column_id": task.columnId.rawValue,
            "column_title": columnTitle,
            "rank": task.rank,
            "workspace_id": orNull(task.workspaceId?.uuidString),
            "worktree_path": orNull(task.worktreePath),
            "branch": orNull(task.branch),
            "owns_worktree": task.ownsWorktree,
            "provision_state": provisionStateString(task.provisionState),
            "provision_failure_reason": orNull(task.provisionState.failureDisplayText),
            "remote_status_label": orNull(task.remoteStatusLabel),
            "task_file_path": orNull(task.taskFilePath),
            "created_at": task.createdAt.timeIntervalSince1970,
            "updated_at": task.updatedAt.timeIntervalSince1970,
            "archived_at": task.archivedAt.map { $0.timeIntervalSince1970 as Any } ?? NSNull()
        ]
        if let remote = task.remoteWorkItem {
            payload["remote_provider"] = remote.provider.rawValue
            payload["remote_key"] = remote.key
            payload["remote_url"] = orNull(remote.url)
        } else {
            payload["remote_provider"] = NSNull()
            payload["remote_key"] = NSNull()
            payload["remote_url"] = NSNull()
        }
        return payload
    }

    private static func provisionStateString(_ state: TaskProvisionState) -> String {
        switch state {
        case .none:    return "none"
        case .pending: return "pending"
        case .ready:   return "ready"
        case .failed:  return "failed"
        }
    }

    private static func columnTitlesMap(
        store: TaskBoardStore,
        snapshots: [TaskColumnSnapshot]
    ) -> [TaskColumnId: String] {
        var out: [TaskColumnId: String] = [:]
        out.reserveCapacity(snapshots.count)
        for snapshot in snapshots {
            out[snapshot.id] = store.columnTitle(for: snapshot.id)
        }
        return out
    }

    // MARK: - Param helpers (local mirrors)

    private static func nonEmptyParam(_ params: [String: Any], _ key: String) -> String? {
        guard let raw = params[key] as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func uuidParam(_ params: [String: Any], _ key: String) -> UUID? {
        guard let raw = nonEmptyParam(params, key) else { return nil }
        return UUID(uuidString: raw)
    }

    private static func orNull(_ value: Any?) -> Any {
        if let value { return value }
        return NSNull()
    }
}
