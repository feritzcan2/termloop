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
        case "tasks.remote_context": return tasksRemoteContext(params)
        case "tasks.remote_operation": return tasksRemoteOperation(params)
        case "tasks.remote_create": return tasksRemoteCreate(params)
        case "tasks.remote_link": return tasksRemoteLink(params)
        case "tasks.remote_unlink": return tasksRemoteUnlink(params)
        case "tasks.remote_refresh": return tasksRemoteRefresh(params)
        case "tasks.remote_sync_assigned": return tasksRemoteSyncAssigned(params)
        case "tasks.remote_refresh_linked": return tasksRemoteRefreshLinked(params)
        case "tasks.remote_update_status": return tasksRemoteUpdateStatus(params)
        case "tasks.remote_capabilities": return tasksRemoteCapabilities(params)
        case "tasks.promote_from_agent":  return tasksPromoteFromAgent(params)
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
            let settings = store.columnSettings(for: snapshot.id)
            return [
                "id": snapshot.id.rawValue,
                "title": titlesByColumn[snapshot.id] ?? snapshot.id.defaultTitle,
                "remote_status_label": orNull(settings.remoteStatusLabel)
            ]
        }

        let visible = store.fileSnapshot().tasks.filter { task in
            includeArchived || task.archivedAt == nil
        }
        let gitChangeCounts = taskGitChangeCounts(for: visible)
        let pullRequests = taskOpenPullRequests(for: visible)
        let payloads: [[String: Any]] = visible.map { task in
            taskPayload(
                task,
                columnTitle: titlesByColumn[task.columnId] ?? store.columnTitle(for: task.columnId),
                gitChangeCount: gitChangeCounts[task.id],
                pullRequests: pullRequests[task.id]
            )
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
            let settings = store.columnSettings(for: snapshot.id)
            return [
                "id": snapshot.id.rawValue,
                "title": titlesByColumn[snapshot.id] ?? snapshot.id.defaultTitle,
                "remote_status_label": orNull(settings.remoteStatusLabel)
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
        let promptText = nonEmptyParam(params, "prompt_text")
        let permissionMode: AgentTemplate.PermissionMode?
        do {
            permissionMode = try launchPermissionMode(params)
        } catch {
            return .err(code: "invalid_params", message: error.localizedDescription, data: nil)
        }
        let allowDirty = (params["allow_dirty"] as? Bool) ?? false
        let coordinator = TaskLifecycleCoordinator.makeForProject(store: store)

        if let workspaceId = task.workspaceId,
           AppDelegate.shared?.workspaceFor(tabId: workspaceId) != nil {
            guard let outcome = launchTaskAgentIfPossible(
                explicitAgentId: agentId,
                workspaceId: workspaceId,
                cwd: task.worktreePath,
                projectId: store.projectId,
                branch: task.branch,
                promptText: promptText,
                permissionMode: permissionMode
            ) else {
                return .err(
                    code: "agent_launch_failed",
                    message: "Could not launch the selected agent in this task workspace.",
                    data: ["workspace_id": workspaceId.uuidString]
                )
            }
            if let error = launchOutcomeError(outcome, workspaceId: workspaceId) {
                return error
            }
            return .ok([
                "task_id": taskId.uuidString,
                "workspace_id": workspaceId.uuidString,
                "worktree_path": orNull(task.worktreePath),
                "branch": orNull(task.branch),
                "status": "ready",
                "launch_mode": launchModeString(outcome)
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
                try await coordinator.bindWorktree(taskId: taskId, allowDirty: allowDirty)
                if let updated = store.fileSnapshot().tasks.first(where: { $0.id == taskId }),
                   let wsId = updated.workspaceId {
                    launchTaskAgentIfPossible(
                        explicitAgentId: agentId,
                        workspaceId: wsId,
                        cwd: updated.worktreePath,
                        projectId: store.projectId,
                        branch: updated.branch,
                        promptText: promptText,
                        permissionMode: permissionMode
                    )
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

    @discardableResult
    private static func launchTaskAgentIfPossible(
        explicitAgentId: String?,
        workspaceId: UUID,
        cwd: String?,
        projectId: UUID,
        branch: String?,
        promptText: String?,
        permissionMode: AgentTemplate.PermissionMode?
    ) -> TerminalAgentLifecycle.LaunchOutcome? {
        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
            return nil
        }
        let plan = taskAgentInvocationPlan(
            explicitAgentId: explicitAgentId,
            workspaceId: workspaceId,
            projectId: projectId,
            cwd: cwd,
            branch: branch,
            promptText: promptText,
            permissionMode: permissionMode
        )
        let resolvedAgentId = plan?.agentId ?? TerminalAgentLifecycle.resolveAgentId(
            explicit: explicitAgentId,
            workspaceId: workspaceId
        )
        guard let agent = TerminalAgentRegistry.shared.agent(id: resolvedAgentId) else {
            #if DEBUG
            print("tasks.start_agent launch failed: unknown agent \(resolvedAgentId)")
            #endif
            return nil
        }
        WorkspaceMetadataStore.shared.setTerminalAgentId(resolvedAgentId, for: workspaceId)
        if let plan {
            ProjectSkillMaterializer.materializeForLaunch(plan)
        }
        return TerminalAgentLifecycle.launchInExistingWorkspace(
            in: workspace,
            agent: agent,
            cwd: cwd ?? workspace.termLoopPresentationCwd(),
            permission: plan?.resolvedPermission,
            initialPrompt: plan?.resolvedPromptBody,
            systemPrompt: plan?.launchSystemInstructions,
            model: plan?.resolvedModel,
            reasoning: plan?.resolvedReasoning,
            launchProvidedFullContext: plan?.launchProvidedFullContext ?? false
        )
    }

    private static func taskAgentInvocationPlan(
        explicitAgentId: String?,
        workspaceId: UUID,
        projectId: UUID,
        cwd: String?,
        branch: String?,
        promptText: String?,
        permissionMode: AgentTemplate.PermissionMode?
    ) -> AgentInvocationPlan? {
        do {
            return try TermLoopSocketAgentLaunchInput.invocationPlan(
                agentId: explicitAgentId,
                promptText: promptText,
                workspaceId: workspaceId,
                projectId: projectId,
                cwd: cwd,
                branch: branch,
                permissionMode: permissionMode,
                reasonTag: "tasks.mobile.startAgent"
            )
        } catch {
            #if DEBUG
            print("tasks.start_agent compose failed: \(error)")
            #endif
            return nil
        }
    }

    private static func launchPermissionMode(_ params: [String: Any]) throws -> AgentTemplate.PermissionMode? {
        try TermLoopSocketAgentLaunchInput.permissionMode(rawValue: nonEmptyParam(params, "permission_mode"))
    }

    private static func launchOutcomeError(
        _ outcome: TerminalAgentLifecycle.LaunchOutcome,
        workspaceId: UUID
    ) -> TerminalController.V2CallResult? {
        switch outcome {
        case .launched:
            return nil
        case .held(let reason):
            return .err(
                code: "agent_launch_held",
                message: launchHoldMessage(reason),
                data: [
                    "workspace_id": workspaceId.uuidString,
                    "reason": launchHoldReasonString(reason)
                ]
            )
        case .rejected(let reason):
            return .err(
                code: "agent_launch_rejected",
                message: launchRejectMessage(reason),
                data: [
                    "workspace_id": workspaceId.uuidString,
                    "reason": launchRejectReasonString(reason)
                ]
            )
        }
    }

    private static func launchModeString(_ outcome: TerminalAgentLifecycle.LaunchOutcome) -> String {
        guard case .launched(let mode) = outcome else { return "none" }
        switch mode {
        case .fresh: return "fresh"
        case .restore: return "restore"
        }
    }

    private static func launchHoldReasonString(_ reason: TerminalAgentLifecycle.HoldReason) -> String {
        switch reason {
        case .claudeAutoRestoreDisabled: return "claude_auto_restore_disabled"
        }
    }

    private static func launchRejectReasonString(_ reason: TerminalAgentLifecycle.RejectReason) -> String {
        switch reason {
        case .liveAgentRunning:
            return "live_agent_running"
        case .agentMismatch:
            return "agent_mismatch"
        case .freshLaunchPayloadRequiresFreshSession:
            return "fresh_launch_payload_requires_fresh_session"
        }
    }

    private static func launchHoldMessage(_ reason: TerminalAgentLifecycle.HoldReason) -> String {
        switch reason {
        case .claudeAutoRestoreDisabled:
            return "Claude auto-restore is disabled for this workspace. Reopen the existing terminal or start a fresh task workspace."
        }
    }

    private static func launchRejectMessage(_ reason: TerminalAgentLifecycle.RejectReason) -> String {
        switch reason {
        case .liveAgentRunning:
            return "An agent is already running in this task workspace. Open the existing agent terminal instead."
        case .agentMismatch:
            return "This task workspace has a persisted session for a different agent. Open the existing terminal or start a fresh task workspace."
        case .freshLaunchPayloadRequiresFreshSession:
            return "This task workspace has a persisted agent session, so TermLoop cannot safely send the new prompt without starting a fresh session."
        }
    }

    private static func tasksRemoteContext(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        return .ok(remoteContextPayload(store: store, remoteSync: remoteSync))
    }

    private static func tasksRemoteOperation(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let operationId = uuidParam(params, "operation_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid operation_id", data: nil)
        }
        guard let payload = RemoteMobileOperationRegistry.payload(operationId) else {
            return .err(code: "not_found", message: "Remote operation not found", data: nil)
        }
        return .ok(["operation": payload])
    }

    private static func tasksRemoteCreate(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let title = nonEmptyParam(params, "title") else {
            return .err(code: "invalid_params", message: "Missing or empty title", data: nil)
        }
        let body = nonEmptyParam(params, "body_markdown") ?? nonEmptyParam(params, "brief")
        let issueType = nonEmptyParam(params, "issue_type")
        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        let opId = RemoteMobileOperationRegistry.begin(kind: "remote_create", projectId: store.projectId)
        Task { @MainActor in
            do {
                let taskId = try await remoteSync.createRemoteWorkItemAsync(
                    title: title,
                    bodyMarkdown: body,
                    issueType: issueType
                )
                guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
                    throw TaskRemoteWorkItemCreateError("Created remote item, but local task is missing.")
                }
                RemoteMobileOperationRegistry.succeed(
                    opId,
                    result: [
                        "task": taskPayload(task, columnTitle: store.columnTitle(for: task.columnId)),
                        "context": remoteContextPayload(store: store, remoteSync: remoteSync)
                    ]
                )
            } catch {
                RemoteMobileOperationRegistry.fail(opId, error: error)
            }
        }
        return .ok(["operation": RemoteMobileOperationRegistry.payload(opId) ?? [:]])
    }

    private static func tasksRemoteLink(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let taskId = uuidParam(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        guard let input = nonEmptyParam(params, "input") else {
            return .err(code: "invalid_params", message: "Missing remote item key or URL", data: nil)
        }
        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        let opId = RemoteMobileOperationRegistry.begin(kind: "remote_link", projectId: store.projectId, taskId: taskId)
        Task { @MainActor in
            do {
                try await remoteSync.linkRemoteWorkItemAsync(taskId: taskId, rawInput: input)
                guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
                    throw TaskRemoteWorkItemCreateError("Linked remote item, but local task is missing.")
                }
                RemoteMobileOperationRegistry.succeed(
                    opId,
                    result: [
                        "task": taskPayload(task, columnTitle: store.columnTitle(for: task.columnId)),
                        "context": remoteContextPayload(store: store, remoteSync: remoteSync)
                    ]
                )
            } catch {
                RemoteMobileOperationRegistry.fail(opId, error: error)
            }
        }
        return .ok(["operation": RemoteMobileOperationRegistry.payload(opId) ?? [:]])
    }

    private static func tasksRemoteUnlink(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let taskId = uuidParam(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        do {
            try remoteSync.unlinkRemoteWorkItem(taskId: taskId)
            guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
                return .err(code: "not_found", message: "Task not found", data: nil)
            }
            return .ok([
                "task": taskPayload(task, columnTitle: store.columnTitle(for: task.columnId)),
                "context": remoteContextPayload(store: store, remoteSync: remoteSync)
            ])
        } catch {
            return .err(code: "remote_operation_failed", message: error.localizedDescription, data: nil)
        }
    }

    private static func tasksRemoteRefresh(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        guard let taskId = uuidParam(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        let opId = RemoteMobileOperationRegistry.begin(kind: "remote_refresh", projectId: store.projectId, taskId: taskId)
        Task { @MainActor in
            do {
                try await remoteSync.refreshRemoteWorkItemAsync(taskId: taskId)
                guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
                    throw TaskRemoteWorkItemCreateError("Refreshed remote item, but local task is missing.")
                }
                RemoteMobileOperationRegistry.succeed(
                    opId,
                    result: [
                        "task": taskPayload(task, columnTitle: store.columnTitle(for: task.columnId)),
                        "context": remoteContextPayload(store: store, remoteSync: remoteSync)
                    ]
                )
            } catch {
                RemoteMobileOperationRegistry.fail(opId, error: error)
            }
        }
        return .ok(["operation": RemoteMobileOperationRegistry.payload(opId) ?? [:]])
    }

    private static func tasksRemoteSyncAssigned(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        let opId = RemoteMobileOperationRegistry.begin(kind: "remote_sync_assigned", projectId: store.projectId)
        Task { @MainActor in
            do {
                try await remoteSync.syncAssignedToMeAsync(reason: "tasks.mobile.syncAssigned")
                let snapshots = store.columnSnapshots
                let titlesByColumn = columnTitlesMap(store: store, snapshots: snapshots)
                let tasks = store.fileSnapshot().tasks
                    .filter { $0.archivedAt == nil }
                    .map { taskPayload($0, columnTitle: titlesByColumn[$0.columnId] ?? store.columnTitle(for: $0.columnId)) }
                RemoteMobileOperationRegistry.succeed(
                    opId,
                    result: [
                        "tasks": tasks,
                        "context": remoteContextPayload(store: store, remoteSync: remoteSync)
                    ]
                )
            } catch {
                RemoteMobileOperationRegistry.fail(opId, error: error)
            }
        }
        return .ok(["operation": RemoteMobileOperationRegistry.payload(opId) ?? [:]])
    }

    private static func tasksRemoteRefreshLinked(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let storeResult = resolveStore(params)
        guard case .success(let store) = storeResult else {
            if case .failure(let err) = storeResult { return err }
            return .err(code: "internal_error", message: "Could not resolve store", data: nil)
        }
        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        let taskIds = store.fileSnapshot().tasks.compactMap { task -> UUID? in
            guard task.archivedAt == nil, task.remoteWorkItem != nil else { return nil }
            return task.id
        }
        guard !taskIds.isEmpty else {
            return .err(code: "not_found", message: "No linked remote tasks to refresh", data: nil)
        }
        let opId = RemoteMobileOperationRegistry.begin(kind: "remote_refresh_linked", projectId: store.projectId)
        Task { @MainActor in
            var failures: [String] = []
            for taskId in taskIds {
                do {
                    try await remoteSync.refreshRemoteWorkItemAsync(taskId: taskId)
                } catch {
                    failures.append(error.localizedDescription)
                }
            }
            if failures.count == taskIds.count {
                RemoteMobileOperationRegistry.fail(
                    opId,
                    error: TaskRemoteWorkItemCreateError(failures.first ?? "Remote refresh failed.")
                )
                return
            }
            let snapshots = store.columnSnapshots
            let titlesByColumn = columnTitlesMap(store: store, snapshots: snapshots)
            let tasks = store.fileSnapshot().tasks
                .filter { $0.archivedAt == nil }
                .map { taskPayload($0, columnTitle: titlesByColumn[$0.columnId] ?? store.columnTitle(for: $0.columnId)) }
            RemoteMobileOperationRegistry.succeed(
                opId,
                result: [
                    "tasks": tasks,
                    "refreshed_count": taskIds.count - failures.count,
                    "failed_count": failures.count,
                    "context": remoteContextPayload(store: store, remoteSync: remoteSync)
                ]
            )
        }
        return .ok(["operation": RemoteMobileOperationRegistry.payload(opId) ?? [:]])
    }

    private static func tasksRemoteUpdateStatus(_ params: [String: Any]) -> TerminalController.V2CallResult {
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
        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        let opId = RemoteMobileOperationRegistry.begin(kind: "remote_update_status", projectId: store.projectId, taskId: taskId)
        Task { @MainActor in
            do {
                let message = try await remoteSync.updateRemoteStatusAsync(taskId: taskId, to: column)
                guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
                    throw TaskRemoteWorkItemCreateError("Updated remote status, but local task is missing.")
                }
                RemoteMobileOperationRegistry.succeed(
                    opId,
                    result: [
                        "message": message,
                        "task": taskPayload(task, columnTitle: store.columnTitle(for: task.columnId)),
                        "context": remoteContextPayload(store: store, remoteSync: remoteSync)
                    ]
                )
            } catch {
                RemoteMobileOperationRegistry.fail(opId, error: error)
            }
        }
        return .ok(["operation": RemoteMobileOperationRegistry.payload(opId) ?? [:]])
    }

    private static func tasksRemoteCapabilities(_ params: [String: Any]) -> TerminalController.V2CallResult {
        switch resolvePromotionContext(params, commandName: "tasks.remote_capabilities") {
        case .success(let context):
            return .ok(remotePromotionCapabilityPayload(context: context))
        case .failure(let error):
            return .ok([
                "enabled": false,
                "can_create": false,
                "reason": errorMessage(error),
                "error": errorPayload(error)
            ])
        }
    }

    private static func tasksPromoteFromAgent(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let title = nonEmptyParam(params, "title") else {
            return .err(code: "invalid_params", message: "Missing or empty title", data: nil)
        }
        guard let description = nonEmptyParam(params, "description") else {
            return .err(code: "invalid_params", message: "Missing or empty description", data: nil)
        }

        let context: PromotionContext
        switch resolvePromotionContext(params, commandName: "tasks.promote_from_agent") {
        case .success(let resolved):
            context = resolved
        case .failure(let error):
            return error
        }

        guard let capability = remotePromotionCapability(context: context) else {
            return .err(
                code: "remote_task_promotion_unavailable",
                message: "Remote task promotion is not available for this workspace.",
                data: remotePromotionCapabilityPayload(context: context)
            )
        }

        let promotionId = uuidParam(params, "promotion_id") ?? UUID()
        let draftStore = RemoteTaskPromotionDraftStoreProvider.shared.store(
            projectId: context.store.projectId,
            projectRoot: context.store.projectRoot
        )
        if let existing = draftStore.draft(id: promotionId) {
            return .ok(promotionPayload(existing))
        }

        let draft = RemoteTaskPromotionDraft(
            id: promotionId,
            projectId: context.store.projectId,
            sourceWorkspaceId: context.workspaceId,
            title: title,
            descriptionMarkdown: description,
            provider: context.settings.provider,
            container: capability.container,
            status: .awaitingConfirmation
        )
        do {
            let saved = try draftStore.upsert(draft)
            guard RemoteTaskPromotionConfirmationPresenter.present(
                draft: saved,
                store: draftStore
            ) else {
                return .err(
                    code: "confirmation_unavailable",
                    message: "Could not show the remote task confirmation sheet.",
                    data: promotionPayload(draftStore.draft(id: saved.id) ?? saved)
                )
            }
            return .ok(promotionPayload(saved))
        } catch {
            return .err(code: "draft_persist_failed", message: error.localizedDescription, data: nil)
        }
    }

    // MARK: - Helpers

    private struct PromotionContext {
        let workspaceId: UUID
        let store: TaskBoardStore
        let remoteSync: TaskRemoteSyncCoordinator
        let settings: TaskRemoteSyncSettings
    }

    private struct RemotePromotionCapability {
        let container: String
    }

    private enum StoreResolution {
        case success(TaskBoardStore)
        case failure(TerminalController.V2CallResult)
    }

    private enum PromotionContextResolution {
        case success(PromotionContext)
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

    private static func resolvePromotionContext(
        _ params: [String: Any],
        commandName: String
    ) -> PromotionContextResolution {
        let workspaceId: UUID
        switch TermLoopSocketCommands.resolveAgentToolWorkspaceId(from: params, commandName: commandName) {
        case .found(let id, _):
            workspaceId = id
        case .missing(let error):
            return .failure(error)
        }

        let metadata = WorkspaceMetadataStore.shared
        let projectId = metadata.projectId(forWorkspaceId: workspaceId)
            ?? AppDelegate.shared?
                .workspaceFor(tabId: workspaceId)
                .flatMap { ProjectStore.shared.project(containingPath: $0.currentDirectory)?.id }
        guard let projectId else {
            return .failure(.err(
                code: "project_unresolved",
                message: "Could not resolve a project from the calling workspace. Remote task promotion does not use active-project fallback.",
                data: ["workspace_id": workspaceId.uuidString]
            ))
        }
        guard let store = TaskBoardStoreProvider.shared.store(for: projectId) else {
            return .failure(.err(
                code: "store_unavailable",
                message: "Could not load task board for the calling workspace project.",
                data: ["workspace_id": workspaceId.uuidString, "project_id": projectId.uuidString]
            ))
        }
        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        return .success(PromotionContext(
            workspaceId: workspaceId,
            store: store,
            remoteSync: remoteSync,
            settings: remoteSync.settings
        ))
    }

    private static func remotePromotionCapability(
        context: PromotionContext
    ) -> RemotePromotionCapability? {
        guard context.settings.isEnabled else {
            return nil
        }
        guard let container = context.settings.container?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !container.isEmpty else {
            return nil
        }
        let cliStatus = remotePromotionCLIStatus(context: context)
        guard cliStatus.isAvailable else {
            return nil
        }
        return RemotePromotionCapability(
            container: container
        )
    }

    private static func remotePromotionCapabilityPayload(context: PromotionContext) -> [String: Any] {
        let settings = context.settings
        let container = settings.container?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let cliStatus = settings.isEnabled && !container.isEmpty
            ? remotePromotionCLIStatus(context: context)
            : context.remoteSync.cliStatus(for: settings.provider)
        let enabled = settings.isEnabled && !container.isEmpty && cliStatus.isAvailable
        let reason: String? = {
            if !settings.isEnabled { return "remote_items_disabled" }
            if container.isEmpty { return "remote_container_missing" }
            if !cliStatus.isAvailable { return "provider_cli_unavailable" }
            return nil
        }()
        return [
            "enabled": enabled,
            "can_create": enabled,
            "project_id": context.store.projectId.uuidString,
            "workspace_id": context.workspaceId.uuidString,
            "provider": settings.provider.rawValue,
            "container": container.isEmpty ? NSNull() : container,
            "cli_available": cliStatus.isAvailable,
            "cli_executable": cliStatus.executable,
            "cli_checking": cliStatus.isChecking,
            "cli_checked_at": cliStatus.checkedAt.map { ISO8601DateFormatter().string(from: $0) } as Any? ?? NSNull(),
            "cli_summary": cliStatus.summary,
            "cli_setup_hint": context.remoteSync.cliSetupHint(for: settings.provider),
            "reason": reason as Any? ?? NSNull()
        ]
    }

    private static func remotePromotionCLIStatus(
        context: PromotionContext
    ) -> TaskRemoteCLIStatus {
        let cached = context.remoteSync.cliStatus(for: context.settings.provider)
        guard cached.checkedAt == nil || cached.isChecking else {
            return cached
        }
        return context.remoteSync.refreshCLIStatusSynchronously(for: context.settings.provider)
    }

    private static func promotionPayload(_ draft: RemoteTaskPromotionDraft) -> [String: Any] {
        var payload: [String: Any] = [
            "promotion_id": draft.id.uuidString,
            "project_id": draft.projectId.uuidString,
            "source_workspace_id": draft.sourceWorkspaceId.uuidString,
            "title": draft.title,
            "description": draft.descriptionMarkdown,
            "issue_type": draft.issueType as Any? ?? NSNull(),
            "create_worktree_and_attach_agent": draft.shouldCreateWorktreeAndAttachAgent,
            "provider": draft.provider.rawValue,
            "container": draft.container,
            "status": draft.status.rawValue,
            "task_id": draft.taskId?.uuidString as Any? ?? NSNull(),
            "target_workspace_id": draft.targetWorkspaceId?.uuidString as Any? ?? NSNull(),
            "worktree_path": draft.worktreePath as Any? ?? NSNull(),
            "error_message": draft.errorMessage as Any? ?? NSNull(),
            "created_at": draft.createdAt.timeIntervalSince1970,
            "updated_at": draft.updatedAt.timeIntervalSince1970
        ]
        if let remote = draft.remoteWorkItem {
            payload["remote_provider"] = remote.provider.rawValue
            payload["remote_key"] = remote.key
            payload["remote_url"] = remote.url as Any? ?? NSNull()
        } else {
            payload["remote_provider"] = NSNull()
            payload["remote_key"] = NSNull()
            payload["remote_url"] = NSNull()
        }
        return payload
    }

    private static func errorMessage(_ result: TerminalController.V2CallResult) -> String {
        guard case .err(let code, let message, _) = result else { return "unavailable" }
        return "\(code): \(message)"
    }

    private static func errorPayload(_ result: TerminalController.V2CallResult) -> Any {
        guard case .err(let code, let message, let data) = result else { return NSNull() }
        return [
            "code": code,
            "message": message,
            "data": data ?? NSNull()
        ]
    }

    private static func taskPayload(
        _ task: TaskRecord,
        columnTitle: String,
        gitChangeCount providedGitChangeCount: Int? = nil,
        pullRequests providedPullRequests: [[String: Any]]? = nil
    ) -> [String: Any] {
        let gitChangeCount = providedGitChangeCount ?? taskGitChangeCount(for: task)
        let pullRequests = providedPullRequests ?? taskOpenPullRequests(for: task)
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
            "remote_description": orNull(remoteDescription(for: task)),
            "task_file_path": orNull(task.taskFilePath),
            "git_dirty": gitChangeCount > 0,
            "git_change_count": gitChangeCount,
            "pull_requests": pullRequests,
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

    private static func taskGitChangeCount(for task: TaskRecord) -> Int {
        guard let path = task.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines),
              !path.isEmpty else { return 0 }
        return GitWorktreePresentationStore.shared.files(for: path).count
    }

    private static func taskGitChangeCounts(for tasks: [TaskRecord]) -> [UUID: Int] {
        var countsByPath: [String: Int] = [:]
        var result: [UUID: Int] = [:]
        for task in tasks {
            guard let path = task.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !path.isEmpty else {
                result[task.id] = 0
                continue
            }
            if countsByPath[path] == nil {
                countsByPath[path] = GitWorktreePresentationStore.shared.files(for: path).count
            }
            result[task.id] = countsByPath[path] ?? 0
        }
        return result
    }

    private static func taskOpenPullRequests(for task: TaskRecord) -> [[String: Any]] {
        TermLoopMobilePullRequestPayloads.openPayloads(
            directory: task.worktreePath,
            branch: task.branch,
            reason: "mobile.tasks.payload"
        )
    }

    private static func taskOpenPullRequests(for tasks: [TaskRecord]) -> [UUID: [[String: Any]]] {
        var payloadsByKey: [String: [[String: Any]]] = [:]
        var result: [UUID: [[String: Any]]] = [:]
        for task in tasks {
            let path = task.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let branch = task.branch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !path.isEmpty, !branch.isEmpty else {
                result[task.id] = []
                continue
            }
            let key = "\(path)\u{1f}|\(branch)"
            if payloadsByKey[key] == nil {
                payloadsByKey[key] = taskOpenPullRequests(for: task)
            }
            result[task.id] = payloadsByKey[key] ?? []
        }
        return result
    }

    private static func remoteDescription(for task: TaskRecord) -> String? {
        guard task.remoteWorkItem != nil else { return nil }
        if let reference = task.remoteWorkItem,
           let body = RemoteWorkItemSnapshotStore.shared.snapshot(for: reference)?.bodyMarkdown?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !body.isEmpty {
            return body
        }
        guard let path = task.taskFilePath,
              let markdown = try? String(contentsOfFile: path, encoding: .utf8) else {
            return nil
        }
        return remoteDescription(fromMaterializedMarkdown: markdown)
    }

    static func remoteDescription(fromMaterializedMarkdown markdown: String) -> String? {
        let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        guard let bodyStart = descriptionBodyStart(in: normalized) else { return nil }
        let bodyEnd = normalized[bodyStart...].range(of: "<!-- termloop:remote-work-item:end -->")?.lowerBound
            ?? normalized.endIndex
        let body = normalized[bodyStart..<bodyEnd]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, body != "_No description._" else { return nil }
        return body
    }

    private static func descriptionBodyStart(in markdown: String) -> String.Index? {
        var searchStart = markdown.startIndex
        while let range = markdown.range(of: "## Description", range: searchStart..<markdown.endIndex) {
            let lineStart = markdown[..<range.lowerBound]
                .lastIndex(of: "\n")
                .map { markdown.index(after: $0) }
                ?? markdown.startIndex
            let lineEnd = markdown[range.upperBound...]
                .firstIndex(of: "\n")
                ?? markdown.endIndex
            let line = markdown[lineStart..<lineEnd]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if line == "## Description" {
                return lineEnd == markdown.endIndex
                    ? lineEnd
                    : markdown.index(after: lineEnd)
            }
            searchStart = range.upperBound
        }
        return nil
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

    private static func remoteContextPayload(
        store: TaskBoardStore,
        remoteSync: TaskRemoteSyncCoordinator
    ) -> [String: Any] {
        let settings = remoteSync.settings
        let container = settings.container?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let cachedCLIStatus = remoteSync.cliStatus(for: settings.provider)
        let cliStatus = settings.isEnabled && !container.isEmpty && cachedCLIStatus.checkedAt == nil && !cachedCLIStatus.isChecking
            ? remoteSync.refreshCLIStatusSynchronously(for: settings.provider)
            : cachedCLIStatus
        let columns = store.settingsSnapshot.columns.map { column in
            [
                "id": column.columnId.rawValue,
                "title": column.title,
                "remote_status_label": orNull(column.remoteStatusLabel)
            ] as [String: Any]
        }
        let canCreate = settings.isEnabled && !container.isEmpty && cliStatus.isAvailable
        return [
            "project_id": store.projectId.uuidString,
            "enabled": settings.isEnabled,
            "provider": settings.provider.rawValue,
            "provider_label": settings.provider.displayLabel,
            "container": orNull(settings.container),
            "sync_assigned_enabled": settings.isAssignedSyncEnabled,
            "limit": settings.limit,
            "last_synced_at": settings.lastSyncedAt.map { $0.timeIntervalSince1970 as Any } ?? NSNull(),
            "last_error": orNull(settings.lastError),
            "is_syncing": remoteSync.isSyncing,
            "last_message": orNull(remoteSync.lastMessage),
            "can_create": canCreate,
            "can_sync_assigned": settings.isAssignedSyncEnabled && cliStatus.isAvailable,
            "cli_available": cliStatus.isAvailable,
            "cli_checking": cliStatus.isChecking,
            "cli_executable": cliStatus.executable,
            "cli_summary": cliStatus.summary,
            "cli_detail": orNull(cliStatus.detail),
            "cli_setup_hint": remoteSync.cliSetupHint(for: settings.provider),
            "columns": columns
        ]
    }

    @MainActor
    private enum RemoteMobileOperationRegistry {
        private static var operations: [UUID: [String: Any]] = [:]
        private static let maxOperations = 80

        static func begin(kind: String, projectId: UUID, taskId: UUID? = nil) -> UUID {
            let id = UUID()
            trimIfNeeded()
            operations[id] = [
                "operation_id": id.uuidString,
                "kind": kind,
                "status": "running",
                "project_id": projectId.uuidString,
                "task_id": taskId?.uuidString as Any? ?? NSNull(),
                "created_at": Date().timeIntervalSince1970,
                "updated_at": Date().timeIntervalSince1970,
                "result": NSNull(),
                "error_message": NSNull()
            ]
            return id
        }

        static func payload(_ id: UUID) -> [String: Any]? {
            operations[id]
        }

        static func succeed(_ id: UUID, result: [String: Any]) {
            update(id) { payload in
                payload["status"] = "succeeded"
                payload["result"] = result
                payload["error_message"] = NSNull()
            }
        }

        static func fail(_ id: UUID, error: Error) {
            update(id) { payload in
                payload["status"] = "failed"
                payload["error_message"] = error.localizedDescription
                payload["result"] = NSNull()
            }
        }

        private static func update(_ id: UUID, _ mutate: (inout [String: Any]) -> Void) {
            guard var payload = operations[id] else { return }
            mutate(&payload)
            payload["updated_at"] = Date().timeIntervalSince1970
            operations[id] = payload
        }

        private static func trimIfNeeded() {
            guard operations.count >= maxOperations else { return }
            let sorted = operations
                .map { ($0.key, (($0.value["updated_at"] as? TimeInterval) ?? 0)) }
                .sorted { $0.1 < $1.1 }
            for (key, _) in sorted.prefix(max(1, operations.count - maxOperations + 1)) {
                operations.removeValue(forKey: key)
            }
        }
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
