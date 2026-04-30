// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Plan-accepting overloads for `TerminalAgentLifecycle`. Each extracts
/// launch fields from the plan and delegates to the existing parameter
/// API. Uses the plan's `launchSystemInstructions` (joined form first,
/// falling back to user-only) paired with `launchProvidedFullContext`
/// so wrappers know whether to skip their own socket fetch.
extension TerminalAgentLifecycle {

    enum PlanLaunchError: Error, LocalizedError {
        case agentNotInCatalog(String)
        case nativeForkUnavailable(String)

        var errorDescription: String? {
            switch self {
            case .agentNotInCatalog(let id):
                return "Plan references agent '\(id)' which is not in the catalog."
            case .nativeForkUnavailable(let id):
                return "Native fork is no longer available for agent '\(id)'."
            }
        }
    }

    /// Fresh workspace creation driven by an `AgentInvocationPlan`.
    /// Mirrors `createFreshWorkspace(tabManager:agent:title:cwd:…)` but
    /// sources all composition-relevant inputs from the plan.
    static func createFreshWorkspace(
        tabManager: TabManager,
        plan: AgentInvocationPlan,
        title: String? = nil,
        worktreeExpectation: TermLoopWorktreeExpectation? = nil,
        baselineHead: String? = nil
    ) throws -> Workspace {
        guard let agent = AgentCatalogStore.shared.agent(id: plan.agentId) else {
            throw PlanLaunchError.agentNotInCatalog(plan.agentId)
        }
        ProjectSkillMaterializer.materializeForLaunch(plan)
        return try createFreshWorkspace(
            tabManager: tabManager,
            agent: agent,
            title: title ?? plan.previewSummary.title,
            cwd: plan.runCwd?.path,
            worktreeExpectation: worktreeExpectation,
            baselineHead: baselineHead,
            initialPrompt: plan.resolvedPromptBody ?? "",
            projectId: plan.projectId,
            permission: plan.resolvedPermission,
            systemPrompt: plan.launchSystemInstructions,
            model: plan.resolvedModel,
            reasoning: plan.resolvedReasoning,
            launchProvidedFullContext: plan.launchProvidedFullContext
        )
    }

    /// Helper-workspace fork driven by an `AgentInvocationPlan`. Used by
    /// bridge ask-agent paths, ability creator/refiner, and any future
    /// helper launch that sources prompts from a preset catalog.
    static func forkWorkspace(
        tabManager: TabManager,
        from source: Workspace,
        plan: AgentInvocationPlan,
        title: String? = nil
    ) throws -> Workspace {
        guard let agent = AgentCatalogStore.shared.agent(id: plan.agentId) else {
            throw PlanLaunchError.agentNotInCatalog(plan.agentId)
        }
        ProjectSkillMaterializer.materializeForLaunch(plan)
        switch plan.source {
        case .claudeNativeFork, .codexNativeFork:
            guard let reference = WorkspaceSessionReferenceResolver.resolve(for: source),
                  reference.agentId == agent.id else {
                throw PlanLaunchError.nativeForkUnavailable(plan.agentId)
            }
            return try forkWorkspace(
                tabManager: tabManager,
                from: source,
                with: agent,
                parentSessionId: reference.sessionId,
                title: title,
                initialPrompt: plan.resolvedPromptBody,
                systemPrompt: plan.launchSystemInstructions,
                permission: plan.resolvedPermission,
                model: plan.resolvedModel,
                reasoning: plan.resolvedReasoning,
                launchProvidedFullContext: plan.launchProvidedFullContext
            )
        default:
            return try forkWorkspace(
                tabManager: tabManager,
                from: source,
                with: agent,
                title: title,
                initialPrompt: plan.resolvedPromptBody,
                systemPrompt: plan.launchSystemInstructions,
                permission: plan.resolvedPermission,
                model: plan.resolvedModel,
                reasoning: plan.resolvedReasoning,
                launchProvidedFullContext: plan.launchProvidedFullContext
            )
        }
    }
}
