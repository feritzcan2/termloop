// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import Bonsplit
import os

// Write-side orchestration center for terminal-agent create / launch / restore /
// relaunch / reopen. Owns agent resolution, metadata ordering, restore policy,
// pending placeholder seeding, and critical restore persistence. Runner is the
// low-level launch backend underneath; this layer decides what to call and in
// what order.
@MainActor
final class TerminalAgentLifecycle {

    private init() {}

    private static let logger = Logger(subsystem: "com.termloop.fork", category: "lifecycle")

#if DEBUG
    private static func debugClean(_ value: String?) -> String {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty
            ? "nil"
            : trimmed
                .replacingOccurrences(of: "\n", with: " ")
                .replacingOccurrences(of: "\r", with: " ")
    }

    private static func debugShort(_ id: UUID?) -> String {
        guard let id else { return "nil" }
        return String(id.uuidString.prefix(8))
    }

    private static func debugProject(_ id: UUID?) -> String {
        guard let id else { return "nil" }
        guard let project = ProjectStore.shared.project(id: id) else {
            return "missing:\(debugShort(id))"
        }
        return "\(debugClean(project.name))[\(debugShort(id))] path=\(debugClean(project.folderPath))"
    }

    private static func debugSession(_ session: PersistedAgentSession?) -> String {
        guard let session else { return "nil" }
        return "agent=\(session.agentId) sid=\(session.sessionId) cwd=\(debugClean(session.cwd))"
    }

    private static func debugWorkspaceTitle(_ workspace: Workspace) -> String {
        debugClean(workspace.customTitle ?? workspace.title)
    }

    private static func debugPathRelation(_ candidate: String?, to root: String?) -> String {
        let rawCandidate = (candidate ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let rawRoot = (root ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawCandidate.isEmpty, !rawRoot.isEmpty else { return "unknown" }
        let candidatePath = URL(fileURLWithPath: rawCandidate).standardizedFileURL.path
        let rootPath = URL(fileURLWithPath: rawRoot).standardizedFileURL.path
        return candidatePath == rootPath || candidatePath.hasPrefix(rootPath + "/")
            ? "inside"
            : "outside"
    }

    private static func debugMetadata(
        _ metadata: WorkspaceMetadataStore.Metadata,
        workspace: Workspace
    ) -> String {
        [
            "ws=\(workspace.id.uuidString)",
            "title=\(debugWorkspaceTitle(workspace))",
            "workspaceCwd=\(debugClean(workspace.currentDirectory))",
            "project=\(debugProject(metadata.projectId))",
            "terminalAgent=\(debugClean(metadata.terminalAgentId))",
            "branch=\(debugClean(metadata.branch))",
            "worktree=\(debugClean(metadata.worktreePath))",
            "persisted={\(debugSession(metadata.persistedAgentSession))}",
            "persistedVsWorktree=\(debugPathRelation(metadata.persistedAgentSession?.cwd, to: metadata.worktreePath))",
            "workspaceVsWorktree=\(debugPathRelation(workspace.currentDirectory, to: metadata.worktreePath))"
        ].joined(separator: " ")
    }

    private static func debugGenericIneligibilityReason(
        agentId: String?,
        persistedSession: PersistedAgentSession?
    ) -> String {
        guard let normalizedAgentId = agentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !normalizedAgentId.isEmpty else {
            return "missing-agent-id"
        }
        guard let persistedSession else { return "missing-persisted-session" }
        let persistedAgentId = persistedSession.agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let persistedSessionId = persistedSession.sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        if persistedAgentId != normalizedAgentId {
            return "persisted-agent-mismatch:\(persistedAgentId)"
        }
        if persistedSessionId.isEmpty {
            return "missing-session-id"
        }
        if normalizedAgentId == TerminalAgent.claudeId {
            return "claude-backend"
        }
        return "unknown"
    }
#endif

    // MARK: - Public types

    enum RestoreBackend {
        case claudeCoordinator
        case genericRunner
    }

    enum HoldReason {
        case claudeAutoRestoreDisabled
    }

    enum RejectReason {
        case liveAgentRunning
        case agentMismatch
        case freshLaunchPayloadRequiresFreshSession
        case launchPreparationFailed
    }

    enum RestoreDecision {
        case restore(backend: RestoreBackend)
        case fresh
        case hold(HoldReason)
        case reject(RejectReason)
    }

    enum LaunchMode {
        case fresh
        case restore
    }

    enum LaunchOutcome {
        case launched(mode: LaunchMode)
        case held(HoldReason)
        case rejected(RejectReason)
    }

    struct PreparedFreshWorkspaceLaunch {
        let agent: TerminalAgent
        let plan: TerminalAgentRunner.AgentLaunchPlan
        let hasInitialPrompt: Bool
        let worktreeExpectation: TermLoopWorktreeExpectation?
        let baselineHead: String?
    }

    // MARK: - Public API

    // Canonical fresh-create sequence: Runner.prepareLaunch composes the
    // command, then addWorkspace -> markPendingRestore -> worktree binding ->
    // fallback dispatch -> session recovery schedule. Runner stays the
    // composition backend; ordering lives here.
    static func createFreshWorkspace(
        tabManager: TabManager,
        agent: TerminalAgent,
        title: String? = nil,
        cwd: String?,
        worktreeExpectation: TermLoopWorktreeExpectation? = nil,
        baselineHead: String? = nil,
        baseEnv: [String: String] = [:],
        initialPrompt: String,
        projectId: UUID? = nil,
        placementOverride: NewWorkspacePlacement? = nil,
        permission: AgentTemplate.PermissionMode? = nil,
        systemPrompt: String? = nil,
        model: AgentModelOption? = nil,
        reasoning: AgentReasoningOption? = nil,
        launchProvidedFullContext: Bool = false,
        select: Bool = true
    ) throws -> Workspace {
        let (plan, hasInitialPrompt) = try TerminalAgentRunner.prepareLaunch(
            agent: agent,
            cwd: cwd,
            worktreeExpectation: worktreeExpectation,
            baseEnv: baseEnv,
            initialPrompt: initialPrompt,
            permission: permission,
            systemPrompt: systemPrompt,
            model: model,
            reasoning: reasoning,
            launchProvidedFullContext: launchProvidedFullContext
        )
        return _createWorkspaceAndPrepareLaunch(
            tabManager: tabManager,
            agent: agent,
            title: title,
            cwd: cwd,
            plan: plan,
            hasInitialPrompt: hasInitialPrompt,
            worktreeExpectation: worktreeExpectation,
            projectId: projectId,
            placementOverride: placementOverride,
            baselineHead: baselineHead,
            select: select
        )
    }

    static func prepareFreshWorkspaceLaunch(
        agent: TerminalAgent,
        cwd: String?,
        worktreeExpectation: TermLoopWorktreeExpectation? = nil,
        baselineHead: String? = nil,
        baseEnv: [String: String] = [:],
        initialPrompt: String = "",
        permission: AgentTemplate.PermissionMode? = nil,
        systemPrompt: String? = nil,
        model: AgentModelOption? = nil,
        reasoning: AgentReasoningOption? = nil,
        launchProvidedFullContext: Bool = false
    ) throws -> PreparedFreshWorkspaceLaunch {
        let (plan, hasInitialPrompt) = try TerminalAgentRunner.prepareLaunch(
            agent: agent,
            cwd: cwd,
            worktreeExpectation: worktreeExpectation,
            baseEnv: baseEnv,
            initialPrompt: initialPrompt,
            permission: permission,
            systemPrompt: systemPrompt,
            model: model,
            reasoning: reasoning,
            launchProvidedFullContext: launchProvidedFullContext
        )
        return PreparedFreshWorkspaceLaunch(
            agent: agent,
            plan: plan,
            hasInitialPrompt: hasInitialPrompt,
            worktreeExpectation: worktreeExpectation,
            baselineHead: baselineHead
        )
    }

    static func attachFreshLaunchToCreatedWorkspace(
        _ launch: PreparedFreshWorkspaceLaunch,
        to workspace: Workspace,
        beforeDispatch: ((Workspace) -> Void)? = nil
    ) {
        TerminalAgentActivityStore.shared.markPendingRestore(
            workspaceId: workspace.id,
            state: TerminalAgentRunner.pendingPlaceholderState(
                hasInitialPrompt: launch.hasInitialPrompt
            )
        )
        WorkspaceMetadataStore.shared.setTerminalAgentModel(
            launch.plan.model,
            for: workspace.id
        )
        TerminalAgentRunner.applyWorktreeBinding(
            launch.worktreeExpectation,
            to: workspace,
            baselineHead: launch.baselineHead
        )
        beforeDispatch?(workspace)
        TerminalAgentRunner.dispatchFallbackLaunchIfNeeded(launch.plan, to: workspace)
        TerminalAgentRunner.scheduleCodexHookReviewProbeIfNeeded(
            agent: launch.agent,
            in: workspace
        )
        TermLoopHooks.schedulePersistedAgentSessionRecoveryIfNeeded(
            agentId: launch.agent.id
        )
    }

    // Mirrors createFreshWorkspace but sources title/cwd/worktreeExpectation/
    // projectId/baselineHead from a sibling workspace. When the source isn't
    // worktree-bound, the fork inherits the source's branch pin + baseline so
    // UI filters still see the new workspace.
    static func forkWorkspace(
        tabManager: TabManager,
        from source: Workspace,
        with agent: TerminalAgent,
        title: String? = nil,
        initialPrompt: String? = nil,
        systemPrompt: String? = nil,
        permission: AgentTemplate.PermissionMode? = nil,
        model: AgentModelOption? = nil,
        reasoning: AgentReasoningOption? = nil,
        launchProvidedFullContext: Bool = false
    ) throws -> Workspace {
        let context = inheritedForkContext(
            from: source,
            agent: agent,
            title: title
        )

        let (plan, hasInitialPrompt) = try TerminalAgentRunner.prepareLaunch(
            agent: agent,
            cwd: context.cwd,
            worktreeExpectation: context.worktreeExpectation,
            initialPrompt: initialPrompt ?? "",
            permission: permission,
            systemPrompt: systemPrompt,
            model: model,
            reasoning: reasoning,
            launchProvidedFullContext: launchProvidedFullContext
        )

        let ws = _createWorkspaceAndPrepareLaunch(
            tabManager: tabManager,
            agent: agent,
            title: context.title,
            cwd: context.cwd,
            plan: plan,
            hasInitialPrompt: hasInitialPrompt,
            worktreeExpectation: context.worktreeExpectation,
            projectId: context.metadata.projectId,
            baselineHead: context.metadata.worktreeBaselineHead
        )

        applyInheritedBranchBindingIfNeeded(context, to: ws)
        return ws
    }

    // Native same-agent fork that preserves the provider's conversation graph
    // (Claude `--fork-session`, Codex `fork`). Reuses the same sibling-
    // workspace metadata inheritance as the handoff path; only the launch
    // command differs.
    static func forkWorkspace(
        tabManager: TabManager,
        from source: Workspace,
        with agent: TerminalAgent,
        parentSessionId: String,
        title: String? = nil,
        initialPrompt: String? = nil,
        systemPrompt: String? = nil,
        permission: AgentTemplate.PermissionMode? = nil,
        model: AgentModelOption? = nil,
        reasoning: AgentReasoningOption? = nil,
        launchProvidedFullContext: Bool = false,
        select: Bool = true
    ) throws -> Workspace {
        let context = inheritedForkContext(
            from: source,
            agent: agent,
            title: title
        )

        let (plan, hasInitialPrompt) = try TerminalAgentRunner.prepareNativeForkLaunch(
            agent: agent,
            cwd: context.cwd,
            worktreeExpectation: context.worktreeExpectation,
            parentSessionId: parentSessionId,
            initialPrompt: initialPrompt ?? "",
            permission: permission,
            systemPrompt: systemPrompt,
            model: model,
            reasoning: reasoning,
            launchProvidedFullContext: launchProvidedFullContext
        )

        let ws = _createWorkspaceAndPrepareLaunch(
            tabManager: tabManager,
            agent: agent,
            title: context.title,
            cwd: context.cwd,
            plan: plan,
            hasInitialPrompt: hasInitialPrompt,
            worktreeExpectation: context.worktreeExpectation,
            projectId: context.metadata.projectId,
            baselineHead: context.metadata.worktreeBaselineHead,
            select: select,
            beforeDispatch: { workspace in
                WorkspaceMetadataStore.shared.beginPendingNativeFork(
                    agentId: agent.id,
                    parentSessionId: parentSessionId,
                    forWorkspaceId: workspace.id
                )
            }
        )

        applyInheritedBranchBindingIfNeeded(context, to: ws)
        return ws
    }

    private struct InheritedForkContext {
        let title: String
        let cwd: String?
        let worktreeExpectation: TermLoopWorktreeExpectation?
        let metadata: WorkspaceMetadataStore.Metadata
    }

    private static func inheritedForkContext(
        from source: Workspace,
        agent: TerminalAgent,
        title: String?
    ) -> InheritedForkContext {
        let rawTitle = source.customTitle?.trimmingCharacters(in: .whitespaces) ?? ""
        let sourceTitle = rawTitle.isEmpty ? source.title : rawTitle
        let inheritedTitle = title ?? "\(sourceTitle) (\(agent.id))"
        let inheritedCwd: String? = (try? source.termLoopSpawnCwd()) ?? {
            let rawCwd = source.currentDirectory
            return rawCwd.isEmpty ? nil : rawCwd
        }()
        return InheritedForkContext(
            title: inheritedTitle,
            cwd: inheritedCwd,
            worktreeExpectation: try? source.termLoopWorktreeExpectation(),
            metadata: WorkspaceMetadataStore.shared.metadata(forWorkspaceId: source.id)
        )
    }

    private static func applyInheritedBranchBindingIfNeeded(
        _ context: InheritedForkContext,
        to workspace: Workspace
    ) {
        guard context.worktreeExpectation == nil,
              let branch = context.metadata.branch else {
            return
        }
        let metadataStore = WorkspaceMetadataStore.shared
        metadataStore.setBranch(
            branch,
            worktreePath: context.metadata.worktreePath,
            for: workspace
        )
        metadataStore.setWorktreeBaselineHead(
            context.metadata.worktreeBaselineHead,
            forWorkspaceId: workspace.id
        )
    }

    // Sole public entry for launching into an already-materialized workspace.
    // _decideExistingLaunch picks restore vs fresh; live-agent attachment
    // returns .rejected(.liveAgentRunning) — migration paths bypass via their
    // own purpose-built method (see relaunchAfterWorktreeMigration).
    static func launchInExistingWorkspace(
        in workspace: Workspace,
        agent: TerminalAgent,
        cwd: String?,
        env: [String: String] = [:],
        permission: AgentTemplate.PermissionMode? = nil,
        initialPrompt: String? = nil,
        systemPrompt: String? = nil,
        model: AgentModelOption? = nil,
        reasoning: AgentReasoningOption? = nil,
        launchProvidedFullContext: Bool = false,
        onCommandSubmitted: TerminalAgentRunner.CommandDispatchCompletion? = nil
    ) -> LaunchOutcome {
        switch _decideExistingLaunch(workspace: workspace, agent: agent) {
        case .reject(let reason):
            return .rejected(reason)
        case .hold(let reason):
            return .held(reason)
        case .restore(let backend):
            if hasFreshLaunchPayload(
                initialPrompt: initialPrompt,
                systemPrompt: systemPrompt,
                permission: permission,
                model: model,
                reasoning: reasoning
            ) {
                return .rejected(.freshLaunchPayloadRequiresFreshSession)
            }
            return _runRestoreInExistingWorkspace(
                workspace: workspace,
                agent: agent,
                cwd: cwd,
                env: env,
                backend: backend,
                onCommandSubmitted: onCommandSubmitted
            )
        case .fresh:
            let hasInitialPrompt = !(initialPrompt ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .isEmpty
            TerminalAgentActivityStore.shared.markPendingRestore(
                workspaceId: workspace.id,
                state: TerminalAgentRunner.pendingPlaceholderState(
                    hasInitialPrompt: hasInitialPrompt
                )
            )
            WorkspaceMetadataStore.shared.setTerminalAgentModel(model, for: workspace.id)
            let accepted = TerminalAgentRunner.dispatchAgentLaunchCommand(
                in: workspace,
                agent: agent,
                cwd: cwd,
                env: env,
                permission: permission,
                initialPrompt: initialPrompt,
                systemPrompt: systemPrompt,
                model: model,
                reasoning: reasoning,
                launchProvidedFullContext: launchProvidedFullContext,
                onCommandSubmitted: { result in
                    if case .failure = result {
                        TerminalAgentActivityStore.shared.clearPendingRestore(
                            workspaceId: workspace.id
                        )
                    }
                    onCommandSubmitted?(result)
                }
            )
            guard accepted else {
                TerminalAgentActivityStore.shared.clearPendingRestore(
                    workspaceId: workspace.id
                )
                return .rejected(.launchPreparationFailed)
            }
            return .launched(mode: .fresh)
        }
    }

    private static func hasFreshLaunchPayload(
        initialPrompt: String?,
        systemPrompt: String?,
        permission: AgentTemplate.PermissionMode?,
        model: AgentModelOption?,
        reasoning: AgentReasoningOption?
    ) -> Bool {
        if let initialPrompt,
           !initialPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        if let systemPrompt,
           !systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        return permission != nil || model != nil || reasoning != nil
    }

    // Trigger-agnostic batch restore. Per-workspace policy (Claude auto-restore
    // vs generic restored launch vs skip) routes through _selectRestoreBackend
    // so it can't drift from the worktree-relaunch path. autoRestoreClaude is
    // a UserDefaults flag, threaded in by the caller.
    static func restoreWorkspaces(
        _ workspaces: [Workspace],
        autoRestoreClaude: Bool
    ) {
#if DEBUG
        restoreAuditLog("agent-restore.batch count=\(workspaces.count) autoRestoreClaude=\(autoRestoreClaude ? 1 : 0)")
#endif
        for (index, workspace) in workspaces.enumerated() {
            if workspaces.count > 1, index > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + TimeInterval(index) * 0.75) {
                    restoreWorkspaces([workspace], autoRestoreClaude: autoRestoreClaude)
                }
                continue
            }
            let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspace.id)
            let bridgeRestoreContext = WorkspaceBridgeStore.shared.agentRestoreContext(
                forWorkspaceId: workspace.id
            )
            let bridgeAgentId = bridgeRestoreContext?.agentId
            guard let agentId = bridgeAgentId
                ?? metadata.persistedAgentSession?.agentId
                ?? metadata.terminalAgentId else {
#if DEBUG
                restoreAuditLog("agent-restore.skip reason=no-agent \(debugMetadata(metadata, workspace: workspace))")
#endif
                continue
            }
            let minimumSessionDate: Date? = {
                guard bridgeRestoreContext?.isAskToHelper == true,
                      TerminalAgentRunner.supportsResume(agentId: agentId) else {
                    return nil
                }
                return bridgeRestoreContext?.minimumSessionDate
            }()
            let persistedForRestore = persistedSessionForRestore(
                metadata.persistedAgentSession,
                agentId: agentId,
                bridgeAgentOverride: bridgeRestoreContext != nil,
                minimumSessionDate: minimumSessionDate
            )
            let requiresExactAskToSession = bridgeRestoreContext?.isAskToHelper == true
                && TerminalAgentRunner.supportsResume(agentId: agentId)

#if DEBUG
            restoreAuditLog(
                "agent-restore.evaluate agent=\(agentId) bridgeOverride=\(bridgeAgentId ?? "nil") " +
                "bridge=\(bridgeRestoreContext?.bridgeId.uuidString ?? "nil") " +
                "bridgeRole=\(bridgeRestoreContext?.role.rawValue ?? "nil") " +
                "askToHelper=\(bridgeRestoreContext?.isAskToHelper == true ? 1 : 0) " +
                "persistedForRestore=\(persistedForRestore?.sessionId ?? "nil") " +
                debugMetadata(metadata, workspace: workspace)
            )
#endif

            if requiresExactAskToSession, persistedForRestore == nil {
#if DEBUG
                restoreAuditLog(
                    "agent-restore.skip reason=ask-to-exact-session-unavailable agent=\(agentId) " +
                    "bridge=\(bridgeRestoreContext?.bridgeId.uuidString ?? "nil") " +
                    "persisted=\(metadata.persistedAgentSession?.sessionId ?? "nil") " +
                    debugMetadata(metadata, workspace: workspace)
                )
#endif
                continue
            }

            if bridgeRestoreContext != nil, persistedForRestore == nil {
                guard let agent = TerminalAgentRegistry.shared.agent(id: agentId) else {
#if DEBUG
                    restoreAuditLog("agent-restore.skip bridge-fresh reason=unknown-agent agent=\(agentId) \(debugMetadata(metadata, workspace: workspace))")
#endif
                    continue
                }
                let worktreeExpectation = try? workspace.termLoopWorktreeExpectation()
                let cwd: String? = (try? workspace.termLoopSpawnCwd()) ?? {
                    let raw = workspace.currentDirectory
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    return raw.isEmpty ? nil : raw
                }()
                let env = restoreEnvironment(
                    worktreeExpectation: worktreeExpectation,
                    bridgeRestoreContext: bridgeRestoreContext
                )
                TerminalAgentActivityStore.shared.markPendingRestore(workspaceId: workspace.id)
#if DEBUG
                restoreAuditLog(
                    "agent-restore.dispatch bridge-fresh agent=\(agent.id) cwd=\(debugClean(cwd)) " +
                    "expectationPath=\(debugClean(worktreeExpectation?.path)) " +
                    "cwdVsExpectation=\(debugPathRelation(cwd, to: worktreeExpectation?.path)) " +
                    debugMetadata(metadata, workspace: workspace)
                )
#endif
                TermLoopHooks.restoredTerminalLauncher(workspace, agent, cwd, env)
                continue
            }

            switch _selectRestoreBackend(agentId: agentId) {
            case .claudeCoordinator:
                guard autoRestoreClaude else {
#if DEBUG
                    restoreAuditLog("agent-restore.skip backend=claude reason=auto-restore-disabled \(debugMetadata(metadata, workspace: workspace))")
#endif
                    continue
                }
                guard let persisted = persistedForRestore else {
#if DEBUG
                    restoreAuditLog("agent-restore.skip backend=claude reason=missing-persisted-session \(debugMetadata(metadata, workspace: workspace))")
#endif
                    continue
                }
                guard persisted.agentId == TerminalAgent.claudeId else {
#if DEBUG
                    restoreAuditLog("agent-restore.skip backend=claude reason=persisted-agent-mismatch persistedAgent=\(persisted.agentId) \(debugMetadata(metadata, workspace: workspace))")
#endif
                    continue
                }
                TerminalAgentActivityStore.shared.markPendingRestore(workspaceId: workspace.id)
#if DEBUG
                restoreAuditLog("agent-restore.dispatch backend=claude sid=\(persisted.sessionId) \(debugMetadata(metadata, workspace: workspace))")
#endif
                ClaudeRestoreCoordinator.shared.restoreAfterSessionLoad(
                    workspaceId: workspace.id,
                    session: persisted
                )

            case .genericRunner:
                guard isEligibleForGenericRestoredLaunch(
                    agentId: agentId,
                    persistedSession: persistedForRestore
                ) else {
#if DEBUG
                    restoreAuditLog(
                        "agent-restore.skip backend=generic reason=\(debugGenericIneligibilityReason(agentId: agentId, persistedSession: persistedForRestore)) " +
                        debugMetadata(metadata, workspace: workspace)
                    )
#endif
                    continue
                }
                guard let agent = TerminalAgentRegistry.shared.agent(id: agentId) else {
                    Self.logger.error("restore skipped unknown terminal agent id")
#if DEBUG
                    restoreAuditLog("agent-restore.skip backend=generic reason=unknown-agent agent=\(agentId) \(debugMetadata(metadata, workspace: workspace))")
#endif
                    continue
                }
                let worktreeExpectation = try? workspace.termLoopWorktreeExpectation()
                let cwd: String? = (try? workspace.termLoopSpawnCwd()) ?? {
                    let raw = workspace.currentDirectory
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    return raw.isEmpty ? nil : raw
                }()
                let env = restoreEnvironment(
                    worktreeExpectation: worktreeExpectation,
                    bridgeRestoreContext: bridgeRestoreContext
                )
                TerminalAgentActivityStore.shared.markPendingRestore(workspaceId: workspace.id)
#if DEBUG
                restoreAuditLog(
                    "agent-restore.dispatch backend=generic agent=\(agent.id) cwd=\(debugClean(cwd)) " +
                    "expectationPath=\(debugClean(worktreeExpectation?.path)) " +
                    "expectationBranch=\(debugClean(worktreeExpectation?.branch)) " +
                    "cwdVsExpectation=\(debugPathRelation(cwd, to: worktreeExpectation?.path)) " +
                    "envKeys=\(env.keys.sorted().joined(separator: ",")) \(debugMetadata(metadata, workspace: workspace))"
                )
#endif
                TermLoopHooks.restoredTerminalLauncher(workspace, agent, cwd, env)
            }
        }
    }

    private static func restoreEnvironment(
        worktreeExpectation: TermLoopWorktreeExpectation?,
        bridgeRestoreContext: WorkspaceBridgeAgentRestoreContext?
    ) -> [String: String] {
        (worktreeExpectation?.environment ?? [:])
            .merging(bridgeRestoreContext?.launchEnvironment ?? [:]) { _, bridgeValue in
                bridgeValue
            }
    }

    private static func persistedSessionForRestore(
        _ persisted: PersistedAgentSession?,
        agentId: String,
        bridgeAgentOverride: Bool,
        minimumSessionDate: Date?
    ) -> PersistedAgentSession? {
        guard let persisted else { return nil }
        let persistedAgent = persisted.agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate: PersistedAgentSession
        if persistedAgent == agentId {
            candidate = persisted
        } else if bridgeAgentOverride {
            return nil
        } else {
            candidate = persisted
        }
        guard let minimumSessionDate else { return candidate }
        guard AskToHelperRestorePolicy.accepts(
            sessionFileCreationDate: persistedSessionFileCreationDate(candidate),
            persistedUpdatedAt: candidate.updatedAt,
            minimumSessionDate: minimumSessionDate
        ) else {
            return nil
        }
        return candidate
    }

    private static func persistedSessionFileCreationDate(
        _ persisted: PersistedAgentSession
    ) -> Date? {
        let fileURL: URL?
        switch persisted.agentId {
        case TerminalAgent.claudeId:
            fileURL = ClaudeSessionScanner.shared.sessionFileURL(
                sessionId: persisted.sessionId,
                cwd: persisted.cwd
            )
        case "codex":
            fileURL = CodexSessionScanner.shared.sessionFileURL(
                sessionId: persisted.sessionId,
                cwd: persisted.cwd
            )
        default:
            fileURL = nil
        }
        guard let fileURL,
              let attributes = try? FileManager.default.attributesOfItem(
                atPath: fileURL.path
              ) else {
            return nil
        }
        return (attributes[.creationDate] as? Date)
            ?? (attributes[.modificationDate] as? Date)
    }

    // Worktree migration relaunch. Caller does the worktree primitives
    // (close old panel, create newPanel at toPath, copy Claude session files
    // for the resumable case). This method runs the canonical sequence:
    //
    //   setPersistedAgentSession -> saveCriticalAgentRestoreStateSync
    //   -> clearClaudeSession    -> ActivityStore.clear
    //   -> ActivityStore.markPendingRestore
    //   -> backend dispatch
    //
    // Dispatch is delayed 0.5s — the new panel needs a tick to settle before
    // we send the command (matches the pre-lifecycle timing; removing it
    // races with the freshly-mounted shell).
    static func relaunchAfterWorktreeMigration(
        workspace: Workspace,
        agent: TerminalAgent,
        project: Project,
        persistedSession: PersistedAgentSession,
        newPanel: TerminalPanel,
        toPath: String,
        additionalSystemPrompt: String? = nil
    ) {
        let metadata = WorkspaceMetadataStore.shared
        let backend = _selectRestoreBackend(agentId: agent.id)
        let commandText = _composeRestoreCommand(
            agent: agent,
            workspaceId: workspace.id,
            persistedSession: persistedSession,
            project: project,
            toPath: toPath,
            backend: backend,
            additionalSystemPrompt: additionalSystemPrompt
        )

        _ = metadata.setPersistedAgentSession(persistedSession, for: workspace.id)
        TermLoopHooks.saveCriticalAgentRestoreStateSync()
        metadata.clearClaudeSession(workspaceId: workspace.id.uuidString)
        TerminalAgentActivityStore.shared.clear(workspaceId: workspace.id)
        TerminalAgentActivityStore.shared.markPendingRestore(workspaceId: workspace.id)
#if DEBUG
        restoreAuditLog(
            "agent-restore.worktreeRelaunch backend=\(backend == .claudeCoordinator ? "claude" : "generic") " +
            "agent=\(agent.id) sid=\(persistedSession.sessionId) toPath=\(debugClean(toPath)) project=\(debugProject(project.id)) " +
            debugMetadata(metadata.metadata(forWorkspaceId: workspace.id), workspace: workspace)
        )
#endif

        switch backend {
        case .claudeCoordinator:
            let tail = commandText + "\r"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                newPanel.sendText(tail)
            }
        case .genericRunner:
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                TerminalAgentRunner.dispatchShellCommandWhenReady(commandText, on: newPanel)
            }
        }
    }

    // Mints a new workspace that inherits the hidden one's cwd/agent/metadata,
    // clears isHidden/suppressAgentsOnClose, drops the old metadata record,
    // and — when persisted session data is present — restores via the batch
    // policy. autoRestoreClaude is forced true: the global setting governs
    // passive startup, not explicit reopen.
    @discardableResult
    static func reopenHiddenWorkspace(
        oldWorkspaceId: UUID,
        tabManager: TabManager
    ) -> Workspace? {
        let metadataStore = WorkspaceMetadataStore.shared
        let oldMetadata = metadataStore.metadata(forWorkspaceId: oldWorkspaceId)
        guard oldMetadata.isHidden == true else { return nil }

        let cwd = oldMetadata.persistedAgentSession?.cwd
        let bridgeAgentId = WorkspaceBridgeStore.shared
            .agentRestoreContext(forWorkspaceId: oldWorkspaceId)?
            .agentId
        let terminalAgentId = bridgeAgentId
            ?? oldMetadata.persistedAgentSession?.agentId
            ?? oldMetadata.terminalAgentId

        let restoredTitle = oldMetadata.collapsedDisplayTitle?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let newWorkspace = tabManager.addWorkspace(
            title: (restoredTitle?.isEmpty == false) ? restoredTitle : nil,
            workingDirectory: cwd,
            select: true,
            projectId: oldMetadata.projectId,
            terminalAgentId: terminalAgentId
        )

        var rebuilt = oldMetadata
        rebuilt.collapsedDisplayTitle = nil
        rebuilt.isHidden = nil
        rebuilt.suppressAgentsOnClose = nil
        let resolvedAfterAdd = metadataStore.metadata(forWorkspaceId: newWorkspace.id)
        rebuilt.projectId = resolvedAfterAdd.projectId
        rebuilt.terminalAgentId = bridgeAgentId
            ?? resolvedAfterAdd.terminalAgentId
        metadataStore.restoreMetadata(rebuilt, forWorkspaceId: newWorkspace.id)
        metadataStore.removeMetadataForId(oldWorkspaceId)

        restoreWorkspaces([newWorkspace], autoRestoreClaude: true)

        TermLoopHooks.saveCriticalAgentRestoreStateSync()
        return newWorkspace
    }

    // MARK: - Internal helpers

    // Atomic "move persisted agent session + flush critical restore state".
    // Idle-move counterpart to relaunchAfterWorktreeMigration; pairs the
    // metadata move with the saveCriticalAgentRestoreStateSync flush so
    // callers can't accidentally skip one half.
    @discardableResult
    static func persistMovedAgentSession(workspaceId: UUID, toCwd: String) -> Bool {
        guard WorkspaceMetadataStore.shared
            .movePersistedAgentSession(for: workspaceId, toCwd: toCwd) else {
            return false
        }
        TermLoopHooks.saveCriticalAgentRestoreStateSync()
        return true
    }

    // Eligibility predicate for the generic (non-Claude) restored-launch path.
    // Claude sessions go through ClaudeRestoreCoordinator; if there's a
    // persisted Claude session this returns false so we don't also start a
    // fresh `claude` process on top.
    static func isEligibleForGenericRestoredLaunch(
        agentId: String?,
        persistedSession: PersistedAgentSession?
    ) -> Bool {
        guard let normalizedAgentId = agentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !normalizedAgentId.isEmpty,
              let persistedSession else {
            return false
        }
        let persistedAgentId = persistedSession.agentId
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let persistedSessionId = persistedSession.sessionId
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard persistedAgentId == normalizedAgentId,
              !persistedSessionId.isEmpty else {
            return false
        }
        return normalizedAgentId != TerminalAgent.claudeId
    }

    // Chain: explicit id (if registered) -> TerminalAgentResolver heuristic
    // -> default agent from settings. The hook bindTerminalAgentOnWorkspaceCreate
    // delegates here so resolution stays centralized regardless of caller.
    static func resolveAgentId(explicit: String?, workspaceId: UUID) -> String {
        if let explicit,
           TerminalAgentRegistry.shared.agent(id: explicit) != nil {
            return explicit
        }
        if let fallback = TerminalAgentResolver.resolve(workspaceId: workspaceId) {
            return fallback.id
        }
        return TermLoopSettings.shared.defaultTerminalAgentId
    }

    // Single source of truth for Claude vs generic restore backend.
    // Both batch restore and worktree relaunch route through this helper so the
    // branching never drifts across methods.
    private static func _selectRestoreBackend(agentId: String) -> RestoreBackend {
        agentId == TerminalAgent.claudeId ? .claudeCoordinator : .genericRunner
    }

    // Compose the restore command for the chosen backend. Delegates to Runner
    // helpers — Lifecycle never composes shell commands itself, it only orders
    // who calls what.
    private static func _composeRestoreCommand(
        agent: TerminalAgent,
        workspaceId: UUID,
        persistedSession: PersistedAgentSession,
        project: Project,
        toPath: String,
        backend: RestoreBackend,
        additionalSystemPrompt: String? = nil
    ) -> String {
        let restoreEnvironment = ["TERMLOOP_WORKSPACE_ID": workspaceId.uuidString]
            .merging(
                WorkspaceBridgeStore.shared
                    .agentRestoreContext(forWorkspaceId: workspaceId)?
                    .launchEnvironment ?? [:]
            ) { _, bridgeValue in
                bridgeValue
            }
        switch backend {
        case .claudeCoordinator:
            return ClaudeResumeCommandBuilder.buildCommand(
                sessionId: persistedSession.sessionId,
                additionalSystemPrompt: additionalSystemPrompt,
                env: restoreEnvironment,
                projectFolderPath: project.folderPath,
                runCwd: toPath,
                cdIntoRunCwd: false
            )
        case .genericRunner:
            TerminalAgentRunner.installAgentHooks(agent: agent, cwd: toPath)
            return TerminalAgentRunner.restoreLaunchCommand(
                for: agent,
                cwd: toPath,
                env: restoreEnvironment,
                workspaceId: workspaceId,
                persistedSession: persistedSession
            )
        }
    }

    // Single-workspace in-place restore. Mirrors the restoreWorkspaces dispatch
    // shape for one workspace whose persisted session was just resolved by
    // _decideExistingLaunch. Same backend split (Claude coordinator vs generic
    // restored launcher closure) so both batch and in-place restore agree.
    private static func _runRestoreInExistingWorkspace(
        workspace: Workspace,
        agent: TerminalAgent,
        cwd: String?,
        env: [String: String],
        backend: RestoreBackend,
        onCommandSubmitted: TerminalAgentRunner.CommandDispatchCompletion?
    ) -> LaunchOutcome {
        guard let persisted = WorkspaceMetadataStore.shared
            .metadata(forWorkspaceId: workspace.id).persistedAgentSession else {
            return .rejected(.agentMismatch)
        }
        let restoreEnvironment = env.merging(
            WorkspaceBridgeStore.shared
                .agentRestoreContext(forWorkspaceId: workspace.id)?
                .launchEnvironment ?? [:]
        ) { _, bridgeValue in
            bridgeValue
        }
        TerminalAgentActivityStore.shared.markPendingRestore(workspaceId: workspace.id)
        let completion: TerminalAgentRunner.CommandDispatchCompletion? = onCommandSubmitted.map { callback in
            { result in
                if case .failure = result {
                    TerminalAgentActivityStore.shared.clearPendingRestore(
                        workspaceId: workspace.id
                    )
                }
                callback(result)
            }
        }
        let accepted: Bool
        switch backend {
        case .claudeCoordinator:
            accepted = ClaudeRestoreCoordinator.shared.restoreAfterSessionLoad(
                workspaceId: workspace.id,
                session: persisted,
                onCommandSubmitted: completion
            )
        case .genericRunner:
            if completion != nil {
                accepted = TerminalAgentRunner.dispatchRestoredAgentCommand(
                    in: workspace,
                    agent: agent,
                    cwd: cwd,
                    env: restoreEnvironment,
                    onCommandSubmitted: completion
                )
            } else {
                TermLoopHooks.restoredTerminalLauncher(
                    workspace,
                    agent,
                    cwd,
                    restoreEnvironment
                )
                accepted = true
            }
        }
        guard accepted else {
            TerminalAgentActivityStore.shared.clearPendingRestore(
                workspaceId: workspace.id
            )
            return .rejected(.launchPreparationFailed)
        }
        return .launched(mode: .restore)
    }

    // Existing-workspace launch policy: persisted-session check, agent mismatch,
    // auto-restore disabled, live-agent reject — all collapse here.
    private static func _decideExistingLaunch(
        workspace: Workspace,
        agent: TerminalAgent
    ) -> RestoreDecision {
        if TerminalAgentActivityStore.shared.isAgentRunning(
            forWorkspace: workspace,
            agentId: agent.id
        ) {
            return .reject(.liveAgentRunning)
        }
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspace.id)
        guard let persisted = metadata.persistedAgentSession else {
            return .fresh
        }
        if persisted.agentId != agent.id {
            return .reject(.agentMismatch)
        }
        if agent.id == TerminalAgent.claudeId,
           !TermLoopHooks.isClaudeAutoRestoreEnabled() {
            return .hold(.claudeAutoRestoreDisabled)
        }
        return .restore(backend: _selectRestoreBackend(agentId: agent.id))
    }

    // Shared creation core for createFreshWorkspace + forkWorkspace.
    // Owns the canonical ordering: addWorkspace -> markPendingRestore ->
    // worktree binding -> fallback dispatch -> session recovery schedule.
    private static func _createWorkspaceAndPrepareLaunch(
        tabManager: TabManager,
        agent: TerminalAgent,
        title: String?,
        cwd: String?,
        plan: TerminalAgentRunner.AgentLaunchPlan,
        hasInitialPrompt: Bool,
        worktreeExpectation: TermLoopWorktreeExpectation?,
        projectId: UUID?,
        placementOverride: NewWorkspacePlacement? = nil,
        baselineHead: String? = nil,
        select: Bool = true,
        beforeDispatch: ((Workspace) -> Void)? = nil
    ) -> Workspace {
        let ws = tabManager.addWorkspace(
            title: title,
            workingDirectory: cwd,
            initialTerminalCommand: plan.initialCommand,
            initialTerminalEnvironment: plan.initialEnvironment,
            workspaceId: plan.workspaceId,
            select: select,
            eagerLoadTerminal: true,
            placementOverride: placementOverride,
            projectId: projectId,
            terminalAgentId: agent.id
        )
        TerminalAgentActivityStore.shared.markPendingRestore(
            workspaceId: ws.id,
            state: TerminalAgentRunner.pendingPlaceholderState(hasInitialPrompt: hasInitialPrompt)
        )
        WorkspaceMetadataStore.shared.setTerminalAgentModel(plan.model, for: ws.id)
        TerminalAgentRunner.applyWorktreeBinding(
            worktreeExpectation,
            to: ws,
            baselineHead: baselineHead
        )
        beforeDispatch?(ws)
        TerminalAgentRunner.dispatchFallbackLaunchIfNeeded(plan, to: ws)
        TerminalAgentRunner.scheduleCodexHookReviewProbeIfNeeded(
            agent: agent,
            in: ws
        )
        TermLoopHooks.schedulePersistedAgentSessionRecoveryIfNeeded(agentId: agent.id)
        return ws
    }
}
