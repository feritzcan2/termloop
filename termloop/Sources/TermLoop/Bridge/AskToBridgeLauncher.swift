// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Bonsplit
import Foundation

/// Programmatic entry for the "Ask To" bridge flow. Mirrors what
/// `AskToSheet.submit()` does after the user clicks Start: launch a fresh
/// hidden helper workspace, build the `.askAgent` bridge, kick off, and
/// return the bridge + helper ids. Used by the sheet and by the
/// `bridge.ask_to` socket command (and through it, the `ask_to` MCP tool).
@MainActor
enum AskToBridgeLauncher {
    struct Outcome {
        let bridgeId: UUID
        let helperWorkspaceId: UUID
    }

    enum LaunchError: Error {
        case sourceWorkspaceNotFound
        case targetNotSupported
        case targetAgentNotInCatalog
        case helperLaunchFailed(Error)
        case bridgeRejected
    }

    /// `targetPrompt` is the optional helper system-prompt override the user
    /// would type into AskToSheet's "Target system prompt" editor; pass empty
    /// string for default. `sourcePrompt` is the kickoff message.
    /// `firstSpeaker` controls which side receives the kickoff: `.left`
    /// (default — sheet path: source agent reads its own meta-prompt and
    /// composes the handoff) or `.right` (MCP path: caller already composed
    /// the question, send it directly to the helper).
    static func launch(
        sourceWorkspaceId: UUID,
        target: AskTargetAgent,
        sourcePrompt: String,
        targetPrompt: String,
        firstSpeaker: BridgeSender = .left,
        tabManager: TabManager
    ) throws -> Outcome {
        guard let sourceWorkspace = tabManager.tabs.first(where: { $0.id == sourceWorkspaceId }) else {
            throw LaunchError.sourceWorkspaceNotFound
        }
        guard target.isRuntimeSupported else {
            throw LaunchError.targetNotSupported
        }
        guard let agent = AgentCatalogStore.shared.agent(id: target.agentId) else {
            throw LaunchError.targetAgentNotInCatalog
        }

        let requestId = UUID()
        let sourceAgentId = resolveSourceAgentId(workspaceId: sourceWorkspaceId)
        let sourceProjectId = resolveSourceProjectId(sourceWorkspace)
        let kickoffMessage = BridgeHelperSystemPrompt.kickoffMessage(
            sourcePrompt,
            requestId: requestId,
            firstSpeaker: firstSpeaker
        )
        let deliverKickoffAtLaunch = firstSpeaker == .right

        let projectFolderPath = sourceProjectId
            .flatMap { ProjectStore.shared.project(id: $0)?.folderPath }

        // Delivery mode comes from the catalog-backed injector, not a hard-
        // coded agent-id split. Claude (flag) / Codex (instructions file)
        // can ship the Ask-To helper instructions + user override without it
        // touching the helper's first user turn. Prompt-prefix agents (Gemini / OpenCode)
        // have no such mechanism — anything we'd inject would arrive as the
        // helper's first input and get "answered" before the source's real
        // handoff. So for prompt-prefix targets we drop targetPrompt entirely
        // and rely on the forwarded handoff to carry context. The kickoff
        // template already mirrors the helper prompt's "do all your research
        // in one go and reply once" guidance.
        let deliveryMode = AgentSystemPromptInjector.deliveryMode(forAgentId: target.agentId)
        let trimmedTargetPrompt = targetPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let systemPromptOverride: String? = {
            switch deliveryMode {
            case .appendSystemPromptFlag, .instructionsFile:
                return BridgeHelperSystemPrompt.compose(
                    requestId: requestId,
                    target: target,
                    userOverride: targetPrompt,
                    projectFolderPath: projectFolderPath
                )
            case .promptPrefix, .none:
                #if DEBUG
                if !trimmedTargetPrompt.isEmpty {
                    dlog("askTo.launch dropping target_prompt for prompt-prefix agent=\(target.agentId)")
                }
                #endif
                return nil
            }
        }()

        let request = AgentInvocationRequest(
            agentId: target.agentId,
            userPrompt: deliverKickoffAtLaunch ? kickoffMessage : nil,
            workspaceId: sourceWorkspaceId,
            projectId: sourceProjectId,
            systemPromptOverride: systemPromptOverride,
            source: .askAgent,
            reasonTag: "askTo.directLaunch"
        )

        let helperWorkspace: Workspace
        do {
            let plan = try AgentInvocationComposer.compose(request)
            // Fresh workspace, NOT a fork. Forking inherits the source's
            // persistedAgentSession metadata; with two ask-to bridges in
            // parallel the stale session id makes the bridge scanner read
            // the wrong session file. Helper launches in the source's cwd
            // so it shares the worktree (git diff/log access).
            ProjectSkillMaterializer.materializeForLaunch(plan)
            helperWorkspace = try TerminalAgentLifecycle.createFreshWorkspace(
                tabManager: tabManager,
                agent: agent,
                title: target.defaultWorkspaceTitle,
                cwd: sourceWorkspace.currentDirectory,
                initialPrompt: plan.resolvedPromptBody ?? "",
                projectId: sourceProjectId,
                permission: plan.resolvedPermission,
                systemPrompt: plan.launchSystemInstructions,
                model: plan.resolvedModel,
                reasoning: plan.resolvedReasoning,
                launchProvidedFullContext: plan.launchProvidedFullContext
            )
        } catch {
            throw LaunchError.helperLaunchFailed(error)
        }

        WorkspaceMetadataStore.shared.setHideFromWorkspaceTree(
            true,
            forWorkspaceId: helperWorkspace.id
        )
        BridgeDebugTrace.log(
            "askTo.launch helper request=\(requestId.uuidString.prefix(8)) source=\(sourceWorkspaceId.uuidString.prefix(8)) " +
            "helper=\(helperWorkspace.id.uuidString.prefix(8)) target=\(target.agentId) " +
            "sourceProject=\(sourceProjectId?.uuidString.prefix(8) ?? "nil") " +
            "helperProject=\(helperWorkspace.projectId?.uuidString.prefix(8) ?? "nil")"
        )

        // targetPrompt is delivered as the helper's system prompt via
        // `systemPromptOverride`; do not also set `rightPrompt` or the
        // helper would "answer" its own system prompt before the real
        // handoff arrives.
        let bridge = WorkspaceBridge(
            id: requestId,
            leftWorkspaceId: sourceWorkspaceId,
            rightWorkspaceId: helperWorkspace.id,
            intent: .askAgent,
            leftAgentId: sourceAgentId,
            rightAgentId: target.agentId,
            rightWorkspaceTitleOverride: target.title,
            kickoffMessage: kickoffMessage,
            firstSpeaker: firstSpeaker,
            kickoffDeliveredAtLaunch: deliverKickoffAtLaunch
        )
        guard WorkspaceBridgeStore.shared.add(bridge) else {
            throw LaunchError.bridgeRejected
        }
        BridgeCoordinator.shared.kickoff(bridgeId: bridge.id)
        return Outcome(bridgeId: bridge.id, helperWorkspaceId: helperWorkspace.id)
    }

    private static func resolveSourceAgentId(workspaceId: UUID) -> String {
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
        return metadata.persistedAgentSession?.agentId
            ?? metadata.terminalAgentId
            ?? TerminalAgentResolver.resolve(workspaceId: workspaceId)?.id
            ?? TerminalAgent.claudeId
    }

    private static func resolveSourceProjectId(_ workspace: Workspace) -> UUID? {
        workspace.projectId
            ?? ProjectStore.shared.project(containingPath: workspace.currentDirectory)?.id
            ?? ProjectStore.shared.activeProjectId
            ?? ProjectStore.shared.fallbackProjectId
    }
}
