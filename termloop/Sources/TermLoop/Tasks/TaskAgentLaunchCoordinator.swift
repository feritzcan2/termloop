// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct TaskAgentLaunchRequest: Sendable {
    let taskId: UUID
    let agentId: String?
    let templateId: String
    let permissionMode: AgentTemplate.PermissionMode
    let variableValues: [String: String]
    let allowDirty: Bool
    let reasonTag: String

    init(
        taskId: UUID,
        agentId: String?,
        templateId: String,
        permissionMode: AgentTemplate.PermissionMode,
        variableValues: [String: String],
        allowDirty: Bool = false,
        reasonTag: String
    ) {
        self.taskId = taskId
        self.agentId = agentId
        self.templateId = templateId
        self.permissionMode = permissionMode
        self.variableValues = variableValues
        self.allowDirty = allowDirty
        self.reasonTag = reasonTag
    }
}

enum TaskAgentLaunchError: LocalizedError {
    case taskNotFound
    case workspaceUnavailable
    case agentUnavailable(String)
    case launchHeld(String)
    case launchRejected(String)
    case composeFailed(String)
    case runningAgentExists

    var errorDescription: String? {
        switch self {
        case .taskNotFound:
            return "Task not found."
        case .workspaceUnavailable:
            return "Task workspace is unavailable."
        case .agentUnavailable(let id):
            return "Agent is unavailable: \(id)"
        case .launchHeld(let message),
             .launchRejected(let message),
             .composeFailed(let message):
            return message
        case .runningAgentExists:
            return "Task workspace already has an active agent."
        }
    }
}

@MainActor
enum TaskAgentLaunchCoordinator {
    @discardableResult
    static func ensureWorktreeAndLaunch(
        store: TaskBoardStore,
        request: TaskAgentLaunchRequest
    ) async throws -> UUID {
        let lifecycle = TaskLifecycleCoordinator.makeForProject(store: store)
        var task = store.fileSnapshot().tasks.first { $0.id == request.taskId && $0.archivedAt == nil }
        guard task != nil else { throw TaskAgentLaunchError.taskNotFound }

        if task?.workspaceId == nil || task?.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            NSLog("[TaskAgentLaunch] binding worktree task=\(request.taskId.uuidString)")
            try await lifecycle.bindWorktree(taskId: request.taskId, allowDirty: request.allowDirty)
            task = store.fileSnapshot().tasks.first { $0.id == request.taskId && $0.archivedAt == nil }
        }

        guard let task, let workspaceId = task.workspaceId else {
            throw TaskAgentLaunchError.workspaceUnavailable
        }
        if hasActiveAgent(workspaceId: workspaceId) {
            throw TaskAgentLaunchError.runningAgentExists
        }
        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
            throw TaskAgentLaunchError.workspaceUnavailable
        }

        let plan: AgentInvocationPlan
        do {
            plan = try AgentInvocationComposer.compose(
                AgentInvocationRequest(
                    agentId: request.agentId,
                    templateId: request.templateId,
                    workspaceId: workspaceId,
                    projectId: store.projectId,
                    runCwd: task.worktreePath.map { URL(fileURLWithPath: $0, isDirectory: true) },
                    branchName: task.branch,
                    permissionOverride: request.permissionMode,
                    variableValues: request.variableValues,
                    source: .socket,
                    reasonTag: request.reasonTag
                )
            )
        } catch {
            throw TaskAgentLaunchError.composeFailed(String(describing: error))
        }

        let resolvedAgentId = plan.agentId
        guard let agent = TerminalAgentRegistry.shared.agent(id: resolvedAgentId) else {
            throw TaskAgentLaunchError.agentUnavailable(resolvedAgentId)
        }

        WorkspaceMetadataStore.shared.setTerminalAgentId(resolvedAgentId, for: workspaceId)
        ProjectSkillMaterializer.materializeForLaunch(plan)
        let outcome = TerminalAgentLifecycle.launchInExistingWorkspace(
            in: workspace,
            agent: agent,
            cwd: task.worktreePath ?? workspace.termLoopPresentationCwd(),
            permission: plan.resolvedPermission,
            initialPrompt: plan.resolvedPromptBody,
            systemPrompt: plan.launchSystemInstructions,
            model: plan.resolvedModel,
            reasoning: plan.resolvedReasoning,
            launchProvidedFullContext: plan.launchProvidedFullContext
        )
        switch outcome {
        case .launched:
            NSLog("[TaskAgentLaunch] launched task=\(request.taskId.uuidString) workspace=\(workspaceId.uuidString) agent=\(resolvedAgentId)")
            return workspaceId
        case .held(let reason):
            throw TaskAgentLaunchError.launchHeld("Agent launch held: \(reason)")
        case .rejected(let reason):
            throw TaskAgentLaunchError.launchRejected("Agent launch rejected: \(reason)")
        }
    }

    static func hasActiveAgent(workspaceId: UUID) -> Bool {
        if let pending = TerminalAgentActivityStore.shared.pendingPlaceholderByWorkspaceId[workspaceId] {
            switch pending {
            case .ready, .running:
                return true
            }
        }
        guard let state = TerminalAgentActivityStore.shared.state(forWorkspaceId: workspaceId) else {
            return false
        }
        switch state.phase {
        case .ready, .running, .waiting:
            return true
        case .inactive, .failed:
            return false
        }
    }
}
