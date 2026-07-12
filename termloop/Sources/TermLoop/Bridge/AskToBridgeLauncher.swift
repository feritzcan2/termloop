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
        let requestId: UUID
        let helperWorkspaceId: UUID
        let helperAgentId: String
        let reusedHelper: Bool
    }

    enum LaunchError: Error {
        case sourceWorkspaceNotFound
        case targetNotSupported
        case targetAgentNotInCatalog
        case helperLaunchFailed(Error)
        case helperWorkspaceNotFound
        case bridgeRejected
        case bridgeNotFound
        case bridgeNotAskAgent
        case bridgeSourceMismatch
        case bridgeTargetMismatch
        case bridgeStopped
        case requestAlreadyOpen
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
        conversationId: UUID? = nil,
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

        if let conversationId {
            return try appendRequestToExistingBridge(
                bridgeId: conversationId,
                sourceWorkspaceId: sourceWorkspaceId,
                target: target,
                sourcePrompt: sourcePrompt,
                targetPrompt: targetPrompt,
                tabManager: tabManager
            )
        }

        // Reject before launching a helper when the caller should have reused
        // the existing conversation. The store still validates at commit time,
        // but this preflight prevents the common conflict path from stranding a
        // hidden agent process.
        guard WorkspaceBridgeStore.shared.activeBridge(forWorkspaceId: sourceWorkspaceId) == nil else {
            throw LaunchError.bridgeRejected
        }

        let bridgeId = UUID()
        let requestId = UUID()
        let askToReplyToken = UUID().uuidString
        let sourceAgentId = resolveSourceAgentId(workspaceId: sourceWorkspaceId)
        let sourceProjectId = resolveSourceProjectId(sourceWorkspace)
        BridgeDebugTrace.log(
            "askTo.launch begin bridge=\(bridgeId.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) " +
            "source=\(sourceWorkspaceId.uuidString.prefix(8)) target=\(target.agentId) first=\(firstSpeaker) " +
            "sourceAgent=\(sourceAgentId) msgChars=\(sourcePrompt.count) targetPromptChars=\(targetPrompt.count)"
        )
        let kickoffMessage = BridgeHelperSystemPrompt.kickoffMessage(
            requestMessage(sourcePrompt, targetPrompt: targetPrompt, isFollowUp: false),
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
                baseEnv: [
                    "TERMLOOP_ASK_TO_REQUEST_ID": requestId.uuidString,
                    "TERMLOOP_ASK_TO_REPLY_TOKEN": askToReplyToken
                ],
                initialPrompt: plan.resolvedPromptBody ?? "",
                projectId: sourceProjectId,
                permission: plan.resolvedPermission,
                systemPrompt: plan.launchSystemInstructions,
                model: plan.resolvedModel,
                reasoning: plan.resolvedReasoning,
                launchProvidedFullContext: plan.launchProvidedFullContext,
                // Ask-To helpers are internal endpoints. Selecting one makes it
                // the main-area workspace even though the sidebar hides it.
                select: false
            )
        } catch {
            BridgeDebugTrace.log(
                "askTo.launch helper-failed bridge=\(bridgeId.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) " +
                "source=\(sourceWorkspaceId.uuidString.prefix(8)) target=\(target.agentId) error=\(error)"
            )
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
            id: bridgeId,
            leftWorkspaceId: sourceWorkspaceId,
            rightWorkspaceId: helperWorkspace.id,
            intent: .askAgent,
            leftAgentId: sourceAgentId,
            rightAgentId: target.agentId,
            rightWorkspaceTitleOverride: target.title,
            askToRequests: [
                AskToRequest(
                    id: requestId,
                    message: sourcePrompt,
                    kickoffMessage: kickoffMessage
                )
            ],
            kickoffMessage: kickoffMessage,
            firstSpeaker: firstSpeaker,
            kickoffDeliveredAtLaunch: deliverKickoffAtLaunch,
            askToReplyToken: askToReplyToken
        )
        guard WorkspaceBridgeStore.shared.add(bridge) else {
            BridgeDebugTrace.log(
                "askTo.launch bridge-rejected bridge=\(bridgeId.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) " +
                "source=\(sourceWorkspaceId.uuidString.prefix(8)) helper=\(helperWorkspace.id.uuidString.prefix(8)) target=\(target.agentId)"
            )
            rollbackUncommittedHelper(helperWorkspace, tabManager: tabManager)
            throw LaunchError.bridgeRejected
        }
        // addWorkspace saves before helper-only metadata and bridge membership
        // are stamped. Persist the committed transaction so a fast restart
        // cannot restore this helper as an ordinary visible workspace.
        TermLoopHooks.saveCriticalAgentRestoreStateSync()
        BridgeDebugTrace.log(
            "askTo.launch bridge-added bridge=\(bridge.id.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) " +
            "source=\(sourceWorkspaceId.uuidString.prefix(8)) helper=\(helperWorkspace.id.uuidString.prefix(8)) target=\(target.agentId)"
        )
        BridgeCoordinator.shared.start(tabManager: tabManager)
        BridgeCoordinator.shared.kickoff(bridgeId: bridge.id)
        return Outcome(
            bridgeId: bridge.id,
            requestId: requestId,
            helperWorkspaceId: helperWorkspace.id,
            helperAgentId: target.agentId,
            reusedHelper: false
        )
    }

    private static func appendRequestToExistingBridge(
        bridgeId: UUID,
        sourceWorkspaceId: UUID,
        target: AskTargetAgent,
        sourcePrompt: String,
        targetPrompt: String,
        tabManager: TabManager
    ) throws -> Outcome {
        BridgeDebugTrace.log(
            "askTo.followup begin bridge=\(bridgeId.uuidString.prefix(8)) source=\(sourceWorkspaceId.uuidString.prefix(8)) " +
            "target=\(target.agentId) msgChars=\(sourcePrompt.count) targetPromptChars=\(targetPrompt.count)"
        )
        guard let bridge = WorkspaceBridgeStore.shared.bridge(id: bridgeId) else {
            BridgeDebugTrace.log("askTo.followup reject bridge=\(bridgeId.uuidString.prefix(8)) reason=not-found")
            throw LaunchError.bridgeNotFound
        }
        guard bridge.intent == .askAgent else {
            BridgeDebugTrace.log("askTo.followup reject bridge=\(bridgeId.uuidString.prefix(8)) reason=not-ask-agent intent=\(bridge.intent)")
            throw LaunchError.bridgeNotAskAgent
        }
        guard bridge.state == .running else {
            BridgeDebugTrace.log("askTo.followup reject bridge=\(bridgeId.uuidString.prefix(8)) reason=stopped state=\(bridge.state)")
            throw LaunchError.bridgeStopped
        }
        guard bridge.leftWorkspaceId == sourceWorkspaceId else {
            BridgeDebugTrace.log(
                "askTo.followup reject bridge=\(bridgeId.uuidString.prefix(8)) reason=source-mismatch " +
                "expected=\(bridge.leftWorkspaceId.uuidString.prefix(8)) actual=\(sourceWorkspaceId.uuidString.prefix(8))"
            )
            throw LaunchError.bridgeSourceMismatch
        }
        guard bridge.rightAgentId == nil || bridge.rightAgentId == target.agentId else {
            BridgeDebugTrace.log(
                "askTo.followup reject bridge=\(bridgeId.uuidString.prefix(8)) reason=target-mismatch " +
                "expected=\(bridge.rightAgentId ?? "nil") actual=\(target.agentId)"
            )
            throw LaunchError.bridgeTargetMismatch
        }
        guard tabManager.tabs.contains(where: { $0.id == bridge.rightWorkspaceId }) else {
            BridgeDebugTrace.log(
                "askTo.followup reject bridge=\(bridgeId.uuidString.prefix(8)) reason=helper-missing " +
                "helper=\(bridge.rightWorkspaceId.uuidString.prefix(8))"
            )
            throw LaunchError.helperWorkspaceNotFound
        }

        let requestId = UUID()
        let kickoffMessage = BridgeHelperSystemPrompt.kickoffMessage(
            requestMessage(sourcePrompt, targetPrompt: targetPrompt, isFollowUp: true),
            requestId: requestId,
            firstSpeaker: .right
        )
        let request = AskToRequest(
            id: requestId,
            message: sourcePrompt,
            kickoffMessage: kickoffMessage
        )
        switch WorkspaceBridgeStore.shared.appendAskToRequest(
            bridgeId: bridgeId,
            request: request
        ) {
        case .appended:
            BridgeDebugTrace.log(
                "askTo.followup appended bridge=\(bridgeId.uuidString.prefix(8)) request=\(requestId.uuidString.prefix(8)) " +
                "source=\(sourceWorkspaceId.uuidString.prefix(8)) helper=\(bridge.rightWorkspaceId.uuidString.prefix(8)) target=\(target.agentId)"
            )
            BridgeCoordinator.shared.start(tabManager: tabManager)
            BridgeCoordinator.shared.sendAskToRequest(
                bridgeId: bridgeId,
                requestId: requestId
            )
            return Outcome(
                bridgeId: bridgeId,
                requestId: requestId,
                helperWorkspaceId: bridge.rightWorkspaceId,
                helperAgentId: target.agentId,
                reusedHelper: true
            )
        case .notFound:
            BridgeDebugTrace.log("askTo.followup append-reject bridge=\(bridgeId.uuidString.prefix(8)) reason=not-found")
            throw LaunchError.bridgeNotFound
        case .notAskAgent:
            BridgeDebugTrace.log("askTo.followup append-reject bridge=\(bridgeId.uuidString.prefix(8)) reason=not-ask-agent")
            throw LaunchError.bridgeNotAskAgent
        case .notRunning:
            BridgeDebugTrace.log("askTo.followup append-reject bridge=\(bridgeId.uuidString.prefix(8)) reason=not-running")
            throw LaunchError.bridgeStopped
        case .requestAlreadyOpen:
            BridgeDebugTrace.log("askTo.followup append-reject bridge=\(bridgeId.uuidString.prefix(8)) reason=request-already-open")
            throw LaunchError.requestAlreadyOpen
        }
    }

    private static func rollbackUncommittedHelper(
        _ helperWorkspace: Workspace,
        tabManager: TabManager
    ) {
        if tabManager.tabs.contains(where: { $0.id == helperWorkspace.id }) {
            if tabManager.tabs.count == 1 {
                _ = tabManager.addWorkspace(
                    select: true,
                    eagerLoadTerminal: false,
                    projectId: ProjectStore.shared.activeProjectId
                )
            }
            tabManager.closeWorkspace(helperWorkspace)
        }
        _ = WorkspaceMetadataStore.shared.removeMetadataForId(helperWorkspace.id)
        TermLoopHooks.saveCriticalAgentRestoreStateSync()
    }

    private static func requestMessage(
        _ sourcePrompt: String,
        targetPrompt: String,
        isFollowUp: Bool
    ) -> String {
        let trimmedTargetPrompt = targetPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSourcePrompt = sourcePrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        var parts: [String] = []
        if isFollowUp {
            parts.append("Follow-up request on the existing TermLoop Ask-To conversation.")
        }
        parts.append(trimmedSourcePrompt.isEmpty ? sourcePrompt : trimmedSourcePrompt)
        if !trimmedTargetPrompt.isEmpty {
            parts.append("Additional guidance for this request:\n\(trimmedTargetPrompt)")
        }
        return parts.joined(separator: "\n\n")
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
