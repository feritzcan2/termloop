import Bonsplit
import Foundation
import os

/// Starts an interactive `claude` agent in a fresh termloop workspace with a
/// pre-loaded initial prompt. Hands the shell a single well-quoted command
/// line rather than piping text into the REPL — this avoids the race
/// between claude's REPL startup and the prompt bytes we send. See
/// `.termloop/AgentSystem/TerminalAgentRunner.md` for the full rationale.
@MainActor
enum TerminalAgentRunner {
    private static let logger = Logger(
        subsystem: "com.termloop.fork",
        category: "agent-lifecycle.runner"
    )

    /// Prompts up to this character count are passed to the agent's argv
    /// directly. Longer prompts are written to a temp file and the agent gets
    /// a one-line "read this file as the user's first turn" bootstrap — which
    /// the user briefly sees in the terminal. macOS ARG_MAX is ~256 KB, so we
    /// keep well under that while allowing domain-customizer prompts (~5–10 KB
    /// each) to flow through the inline path and stay invisible in the
    /// terminal.
    private static let inlinePromptArgvLimit = 20_000

    private static func lifecycleLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        let rendered = message()
        logger.debug("\(rendered, privacy: .public)")
        #endif
    }

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

    private static func debugWorkspaceTitle(_ workspace: Workspace) -> String {
        debugClean(workspace.customTitle ?? workspace.title)
    }
#endif

    private struct BootstrapLaunch {
        let initialCommand: String
        let initialEnvironment: [String: String]
    }

    struct AgentLaunchPlan {
        let workspaceId: UUID
        let initialCommand: String?
        let initialEnvironment: [String: String]
        let fallbackCommand: String?
    }

    static func pendingPlaceholderState(
        hasInitialPrompt: Bool
    ) -> TerminalAgentActivityStore.PendingPlaceholderState {
        hasInitialPrompt ? .running : .ready
    }

    /// Pure composition helper for fresh agent launches: builds the command,
    /// env, and fallback plan without touching TabManager, ActivityStore, or
    /// workspace metadata. Side effects limited to filesystem (hook script
    /// install + optional prompt tempfile). Used by `TerminalAgentLifecycle`
    /// to orchestrate fresh workspace creation; `spawnTerminalAgent` inlines
    /// the same logic for legacy callers that haven't moved to the lifecycle
    /// yet and will be deleted in the final cleanup commit.
    static func prepareLaunch(
        agent: TerminalAgent,
        cwd: String?,
        worktreeExpectation: TermLoopWorktreeExpectation?,
        baseEnv: [String: String] = [:],
        initialPrompt: String,
        permission: AgentTemplate.PermissionMode?,
        systemPrompt: String?,
        model: AgentModelOption? = nil,
        reasoning: AgentReasoningOption? = nil,
        /// True when `systemPrompt` is the composer's joined fresh-launch
        /// payload (abilities + reported context + user prompt). When
        /// false, the wrapper's socket fetch must still run so abilities
        /// and reported context aren't dropped from the agent's view.
        launchProvidedFullContext: Bool = false
    ) throws -> (plan: AgentLaunchPlan, hasInitialPrompt: Bool) {
        lifecycleLog(
            "runner.prepareLaunch agent=\(agent.id) cwd=\(cwd ?? "nil") hasWorktree=\(worktreeExpectation == nil ? 0 : 1) promptChars=\(initialPrompt.count)"
        )
        installAgentHooks(agent: agent, cwd: cwd)
        let effectiveArgv = launchArgv(
            for: agent,
            permission: permission,
            model: model,
            reasoning: reasoning
        )
        let injection = try AgentInvocationTransportAdapter.resolveSystemInstructions(
            agentId: agent.id,
            systemInstructions: systemPrompt
        )
        #if DEBUG
        dlog("runner.prepareLaunch agent=\(agent.id) systemPromptLen=\(systemPrompt?.count ?? 0) deliveredLen=\(injection.deliveredSystemInstructions?.count ?? 0) mode=\(injection.deliveryMode)")
        #endif
        var baseCommand = commandLine(
            for: agent,
            argv: effectiveArgv + injection.extraArgv
        )
        let combinedPrompt = (injection.promptPrefix ?? "") + initialPrompt
        let trimmed = combinedPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasInitialPrompt = !trimmed.isEmpty
        if hasInitialPrompt {
            if combinedPrompt.count <= inlinePromptArgvLimit {
                baseCommand += " " + TermLoopShell.quoteSingle(combinedPrompt)
            } else {
                let promptURL = try writePromptFile(combinedPrompt)
                let bootstrap = "The user's opening message is the exact contents of the file at \(promptURL.path). Treat those contents as the user's first turn verbatim and respond directly."
                baseCommand += " " + TermLoopShell.quoteSingle(bootstrap)
            }
        }
        let workspaceId = UUID()
        let launchBaseEnv = baseEnv.merging(worktreeExpectation?.environment ?? [:]) {
            current,
            _ in current
        }
        let launchEnv = agentEnvironment(
            base: launchBaseEnv,
            workspaceId: workspaceId,
            agentId: agent.id,
            launchProvidedContext: launchProvidedFullContext
        )
        let plan = planLaunch(
            agent: agent,
            baseCommand: baseCommand,
            cwd: cwd,
            env: launchEnv,
            workspaceId: workspaceId
        )
        lifecycleLog(
            "runner.prepareLaunch.done agent=\(agent.id) workspace=\(workspaceId.uuidString) hasInitialPrompt=\(hasInitialPrompt ? 1 : 0) initialCommand=\(plan.initialCommand == nil ? 0 : 1) fallback=\(plan.fallbackCommand == nil ? 0 : 1)"
        )
        return (plan, hasInitialPrompt)
    }

    /// Pure composition helper for native same-agent conversation forks.
    /// Reuses the standard launch argv/instruction injection plumbing, but
    /// swaps the base command to the provider's native fork surface.
    static func prepareNativeForkLaunch(
        agent: TerminalAgent,
        cwd: String?,
        worktreeExpectation: TermLoopWorktreeExpectation?,
        parentSessionId: String,
        initialPrompt: String,
        permission: AgentTemplate.PermissionMode?,
        systemPrompt: String?,
        model: AgentModelOption? = nil,
        reasoning: AgentReasoningOption? = nil,
        launchProvidedFullContext: Bool = false
    ) throws -> (plan: AgentLaunchPlan, hasInitialPrompt: Bool) {
        lifecycleLog(
            "runner.prepareNativeFork agent=\(agent.id) cwd=\(cwd ?? "nil") parentSession=\(parentSessionId) promptChars=\(initialPrompt.count)"
        )
        installAgentHooks(agent: agent, cwd: cwd)
        let workspaceId = UUID()
        let launchEnv = agentEnvironment(
            base: worktreeExpectation?.environment ?? [:],
            workspaceId: workspaceId,
            agentId: agent.id,
            launchProvidedContext: launchProvidedFullContext
        )
        let baseCommand = try nativeForkLaunchCommand(
            for: agent,
            parentSessionId: parentSessionId,
            initialPrompt: initialPrompt,
            env: launchEnv,
            cwd: cwd,
            permission: permission,
            systemPrompt: systemPrompt,
            model: model,
            reasoning: reasoning
        )
        let hasInitialPrompt = !initialPrompt
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
        let plan = planLaunch(
            agent: agent,
            baseCommand: baseCommand,
            cwd: cwd,
            env: launchEnv,
            workspaceId: workspaceId
        )
        lifecycleLog(
            "runner.prepareNativeFork.done agent=\(agent.id) workspace=\(workspaceId.uuidString) hasInitialPrompt=\(hasInitialPrompt ? 1 : 0) initialCommand=\(plan.initialCommand == nil ? 0 : 1) fallback=\(plan.fallbackCommand == nil ? 0 : 1)"
        )
        return (plan, hasInitialPrompt)
    }

    static func launchArgv(
        for agent: TerminalAgent,
        permission: AgentTemplate.PermissionMode?,
        model: AgentModelOption?,
        reasoning: AgentReasoningOption?
    ) -> [String] {
        let permissionArgv = permission.flatMap { argv(for: agent, permission: $0) } ?? agent.argv
        return permissionArgv
            + modelArgv(for: agent, model: model)
            + reasoningArgv(for: agent, reasoning: reasoning)
    }

    static func launchExecutable(for agent: TerminalAgent) -> String {
        if let bundled = bundledExecutablePath(for: agent) {
            return bundled
        }
        if agent.id == TerminalAgent.claudeId,
           let customClaudePath = ClaudeCodeIntegrationSettings.customClaudePath(),
           FileManager.default.isExecutableFile(atPath: customClaudePath) {
            return customClaudePath
        }
        return agent.executableName
    }

    private static func commandLine(
        for agent: TerminalAgent,
        argv: [String]
    ) -> String {
        TerminalCommandQuoter.join([launchExecutable(for: agent)] + argv)
    }

    private static func bundledExecutablePath(for agent: TerminalAgent) -> String? {
        guard let resourceURL = Bundle.main.resourceURL else { return nil }
        let candidate = resourceURL
            .appendingPathComponent("bin")
            .appendingPathComponent(agent.executableName)
            .path
        guard FileManager.default.isExecutableFile(atPath: candidate) else {
            return nil
        }
        return candidate
    }


    /// Hook install + default-launch dispatch + session-recovery schedule,
    /// without touching the pending-restore placeholder. Called by
    /// `TerminalAgentLifecycle.launchInExistingWorkspace` which owns the
    /// `markPendingRestore` write on its own ordering.
    static func dispatchAgentLaunchCommand(
        in workspace: Workspace,
        agent: TerminalAgent,
        cwd: String?,
        env: [String: String],
        permission: AgentTemplate.PermissionMode?
    ) {
        installAgentHooks(agent: agent, cwd: cwd)
        let resolvedPermission = permission
            ?? WorkspaceMetadataStore.shared
                .permissionMode(for: workspace.id)
                .flatMap { AgentTemplate.PermissionMode(rawValue: $0) }
        let command = defaultLaunchCommand(
            for: agent,
            cwd: cwd,
            env: agentEnvironment(
                base: env,
                workspaceId: workspace.id,
                agentId: agent.id
            ),
            workspaceId: workspace.id,
            permission: resolvedPermission
        )
        lifecycleLog(
            "runner.dispatchLaunch workspace=\(workspace.id.uuidString) agent=\(agent.id) cwd=\(cwd ?? "nil") permission=\(resolvedPermission?.rawValue ?? "nil") commandChars=\(command.count)"
        )
        sendCommandWhenReady(
            to: workspace,
            command: command,
            attempt: 0
        )
        scheduleCodexHookReviewProbeIfNeeded(agent: agent, in: workspace)
        TermLoopHooks.schedulePersistedAgentSessionRecoveryIfNeeded(agentId: agent.id)
    }

    /// Backend dispatch for a restored agent. Codex re-uses the persisted
    /// session id; others fall back to their normal launch command.
    /// Lifecycle owns markPendingRestore + policy; this is the dispatch tail.
    static func dispatchRestoredAgentCommand(
        in workspace: Workspace,
        agent: TerminalAgent,
        cwd: String?,
        env: [String: String] = [:]
    ) {
        let persistedSession = WorkspaceMetadataStore.shared.persistedAgentSession(for: workspace.id)
        let worktreeExpectation = try? workspace.termLoopWorktreeExpectation()
        let preferredCwd = preferredRestoreCwd(
            for: agent,
            fallbackCwd: cwd,
            persistedSession: persistedSession,
            worktreeExpectation: worktreeExpectation
        )
        var launchEnv = agentEnvironment(
            base: env,
            workspaceId: workspace.id,
            agentId: agent.id
        )
        if agent.id == "codex",
           let persistedSession,
           persistedSession.agentId == agent.id {
            let sessionId = persistedSession.sessionId
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !sessionId.isEmpty {
                launchEnv["TERMLOOP_CODEX_RESTORE_SESSION_ID"] = sessionId
            }
            let restoreCwd = preferredCwd?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let restoreCwd, !restoreCwd.isEmpty {
                launchEnv["TERMLOOP_CODEX_RESTORE_CWD"] = restoreCwd
            }
        }
        installAgentHooks(agent: agent, cwd: preferredCwd)
        let restoredCommand = restoreLaunchCommand(
            for: agent,
            cwd: preferredCwd,
            env: launchEnv,
            workspaceId: workspace.id,
            persistedSession: persistedSession
        )
        let commandToDispatch: String = {
            guard agent.usesStartupBootstrap,
                  let wrapped = wrapInlineShellCommandForDispatch(
                    restoredCommand,
                    prefix: "termloop-restore-dispatch"
                  ) else {
                return restoredCommand
            }
            return wrapped
        }()
        lifecycleLog(
            "runner.dispatchRestore workspace=\(workspace.id.uuidString) agent=\(agent.id) cwd=\(preferredCwd ?? "nil") persistedSession=\(persistedSession?.sessionId ?? "nil") commandChars=\(commandToDispatch.count)"
        )
#if DEBUG
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspace.id)
        dlog(
            "runner.dispatchRestore.detail ws=\(workspace.id.uuidString) title=\(debugWorkspaceTitle(workspace)) " +
            "agent=\(agent.id) preferredCwd=\(debugClean(preferredCwd)) fallbackCwd=\(debugClean(cwd)) " +
            "project=\(debugProject(metadata.projectId)) branch=\(debugClean(metadata.branch)) worktree=\(debugClean(metadata.worktreePath)) " +
            "persistedAgent=\(debugClean(persistedSession?.agentId)) sid=\(debugClean(persistedSession?.sessionId)) " +
            "persistedCwd=\(debugClean(persistedSession?.cwd)) commandChars=\(commandToDispatch.count)"
        )
#endif
        sendCommandWhenReady(
            to: workspace,
            command: commandToDispatch,
            attempt: 0
        )
        scheduleCodexHookReviewProbeIfNeeded(agent: agent, in: workspace)
        TermLoopHooks.schedulePersistedAgentSessionRecoveryIfNeeded(agentId: agent.id)
    }


    /// Maps the caller's model choice to the agent's CLI flag. Empty for
    /// `.default` (filtered by the guard) and for agents without model
    /// selection.
    private static func modelArgv(
        for agent: TerminalAgent,
        model: AgentModelOption?
    ) -> [String] {
        guard let model, model != .default else { return [] }
        switch agent.id {
        case "claude":
            switch model {
            case .opus: return ["--model", "opus"]
            case .sonnet: return ["--model", "sonnet"]
            case .default,
                 .gpt55, .gpt54, .gpt54Mini, .gpt53Codex, .gpt53CodexSpark, .gpt52:
                return []  // unreachable / unsupported for claude
            }
        case AgentCatalogStore.codexId:
            return ["--model", model.rawValue]
        default:
            return []
        }
    }

    /// Maps a normalized reasoning effort onto the provider's current CLI
    /// surface. Empty means "use the provider default" or "provider does not
    /// expose a reasoning selector".
    private static func reasoningArgv(
        for agent: TerminalAgent,
        reasoning: AgentReasoningOption?
    ) -> [String] {
        guard let reasoning, reasoning != .default else { return [] }
        switch agent.id {
        case "claude":
            return ["--effort", reasoning.rawValue]
        case "codex":
            return ["-c", "model_reasoning_effort=\"\(reasoning.rawValue)\""]
        default:
            return []
        }
    }

    /// Maps QuickAction's claude-centric permission vocabulary onto
    /// per-agent CLI flags. When the caller doesn't supply a permission,
    /// callers fall back to `agent.argv` (registry defaults).
    private static func argv(
        for agent: TerminalAgent,
        permission: AgentTemplate.PermissionMode
    ) -> [String]? {
        switch agent.id {
        case "claude":
            switch permission {
            case .bypassPermissions, .auto:
                return ["--dangerously-skip-permissions"]
            case .default, .ask, .dontAsk:
                return ["--permission-mode", "default"]
            case .acceptEdits:
                return ["--permission-mode", "acceptEdits"]
            case .plan:
                return ["--permission-mode", "plan"]
            }
        case "codex":
            switch permission {
            case .bypassPermissions, .auto:
                return ["--dangerously-bypass-approvals-and-sandbox"]
            case .plan:
                return [
                    "-c", "sandbox_mode=\"read-only\"",
                    "-c", "approval_policy=\"on-request\"",
                ]
            case .acceptEdits:
                return [
                    "-c", "sandbox_mode=\"workspace-write\"",
                    "-c", "approval_policy=\"on-failure\"",
                ]
            case .default, .ask, .dontAsk:
                return [
                    "-c", "sandbox_mode=\"workspace-write\"",
                    "-c", "approval_policy=\"on-request\"",
                ]
            }
        default:
            return nil
        }
    }

    /// Generic variant for any shell command (not just claude). Creates a
    /// fresh workspace on `tabManager` and sends `shellCommand + "\n"` to
    /// the focused terminal panel once it mounts. The command runs as a
    /// child of the shell, so the user stays at the shell prompt when it
    /// exits — see `.termloop/AgentSystem/TerminalAgentRunner.md` for why
    /// `initialTerminalCommand` is deliberately avoided.
    @discardableResult
    static func spawnShell(
        tabManager: TabManager,
        title: String? = nil,
        cwd: String?,
        shellCommand: String
    ) -> Workspace {
        let ws = tabManager.addWorkspace(
            title: title,
            workingDirectory: cwd,
            select: true,
            eagerLoadTerminal: true
        )
        sendCommandWhenReady(to: ws, command: shellCommand, attempt: 0)
        return ws
    }

    static func defaultLaunchCommand(
        for agent: TerminalAgent,
        cwd: String?,
        env: [String: String] = [:],
        workspaceId: UUID,
        permission: AgentTemplate.PermissionMode? = nil
    ) -> String {
        let baseCommand: String
        if let permission, let overrideArgv = argv(for: agent, permission: permission) {
            baseCommand = commandLine(for: agent, argv: overrideArgv)
        } else {
            baseCommand = commandLine(for: agent, argv: agent.argv)
        }
        installClaudeProjectMCPServersIfNeeded(
            agent: agent,
            cwd: cwd,
            env: env,
            workspaceId: workspaceId
        )
        return composeLaunchCommand(
            agent: agent,
            baseCommand: baseCommand,
            cwd: cwd,
            env: env,
            workspaceId: workspaceId
        )
    }

    static func restoreLaunchCommand(
        for agent: TerminalAgent,
        cwd: String?,
        env: [String: String] = [:],
        workspaceId: UUID,
        persistedSession: PersistedAgentSession?
    ) -> String {
        let baseCommand = restoredBaseCommand(
            for: agent,
            persistedSession: persistedSession,
            restoreCwd: cwd
        )
            ?? commandLine(for: agent, argv: agent.argv)
        installClaudeProjectMCPServersIfNeeded(
            agent: agent,
            cwd: cwd,
            env: env,
            workspaceId: workspaceId
        )
        return composeLaunchCommand(
            agent: agent,
            baseCommand: baseCommand,
            cwd: cwd,
            env: env,
            workspaceId: workspaceId
        )
    }

    static func nativeForkLaunchCommand(
        for agent: TerminalAgent,
        parentSessionId: String,
        initialPrompt: String,
        env: [String: String] = [:],
        cwd: String?,
        permission: AgentTemplate.PermissionMode?,
        systemPrompt: String?,
        model: AgentModelOption? = nil,
        reasoning: AgentReasoningOption? = nil
    ) throws -> String {
        let effectiveArgv = launchArgv(
            for: agent,
            permission: permission,
            model: model,
            reasoning: reasoning
        )
        let injection = try AgentInvocationTransportAdapter.resolveSystemInstructions(
            agentId: agent.id,
            systemInstructions: systemPrompt
        )
        let sessionId = parentSessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        var baseCommand: String
        switch agent.id {
        case TerminalAgent.claudeId:
            baseCommand = commandLine(
                for: agent,
                argv: ["--resume", sessionId, "--fork-session"]
                    + effectiveArgv
                    + injection.extraArgv
            )
        case "codex":
            let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
            let cwdArgv: [String]
            if let trimmedCwd, !trimmedCwd.isEmpty {
                cwdArgv = ["--cd", trimmedCwd]
            } else {
                cwdArgv = []
            }
            baseCommand = commandLine(
                for: agent,
                argv: ["fork"] + effectiveArgv + injection.extraArgv + cwdArgv + [sessionId]
            )
        default:
            baseCommand = commandLine(for: agent, argv: effectiveArgv + injection.extraArgv)
        }

        let combinedPrompt = (injection.promptPrefix ?? "") + initialPrompt
        let trimmedPrompt = combinedPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedPrompt.isEmpty {
            if combinedPrompt.count <= inlinePromptArgvLimit {
                baseCommand += " " + TermLoopShell.quoteSingle(combinedPrompt)
            } else {
                let promptURL = try writePromptFile(combinedPrompt)
                let bootstrap = "The user's opening message is the exact contents of the file at \(promptURL.path). Treat those contents as the user's first turn verbatim and respond directly."
                baseCommand += " " + TermLoopShell.quoteSingle(bootstrap)
            }
        }
        return baseCommand
    }

    static func applyWorktreeBinding(
        _ expectation: TermLoopWorktreeExpectation?,
        to workspace: Workspace,
        baselineHead: String? = nil
    ) {
        guard let expectation else { return }
        let metadataStore = WorkspaceMetadataStore.shared
        metadataStore.setBranch(
            expectation.branch,
            worktreePath: expectation.path,
            for: workspace
        )
        let resolvedBaseline = baselineHead
            ?? (try? GitWorktreeService().headRevision(worktreePath: expectation.path))
        metadataStore.setWorktreeBaselineHead(
            resolvedBaseline,
            forWorkspaceId: workspace.id
        )
    }

    private static func planLaunch(
        agent: TerminalAgent?,
        baseCommand: String,
        cwd: String?,
        env: [String: String],
        workspaceId: UUID
    ) -> AgentLaunchPlan {
        if let agent {
            installClaudeProjectMCPServersIfNeeded(
                agent: agent,
                cwd: cwd,
                env: env,
                workspaceId: workspaceId
            )
            if agent.usesStartupBootstrap,
               let bootstrapLaunch = prepareBootstrapLaunch(
                agent: agent,
                baseCommand: baseCommand,
                env: env,
                workspaceId: workspaceId
               ) {
                return AgentLaunchPlan(
                    workspaceId: workspaceId,
                    initialCommand: bootstrapLaunch.initialCommand,
                    initialEnvironment: bootstrapLaunch.initialEnvironment,
                    fallbackCommand: nil
                )
            }
        }
        let fallback = composeLaunchCommand(
            agent: agent,
            baseCommand: baseCommand,
            cwd: cwd,
            env: env,
            workspaceId: workspaceId
        )
        return AgentLaunchPlan(
            workspaceId: workspaceId,
            initialCommand: nil,
            initialEnvironment: [:],
            fallbackCommand: fallback
        )
    }

    static func dispatchFallbackLaunchIfNeeded(
        _ plan: AgentLaunchPlan,
        to workspace: Workspace
    ) {
        guard let command = plan.fallbackCommand else { return }
        sendCommandWhenReady(to: workspace, command: command, attempt: 0)
    }

    static func scheduleCodexHookReviewProbeIfNeeded(
        agent: TerminalAgent,
        in workspace: Workspace
    ) {
        guard agent.id == AgentCatalogStore.codexId else { return }
        guard CodexHooksStatus.shared.claimReviewProbeSession(workspaceId: workspace.id) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + codexHookReviewProbeInitialDelay) {
            runCodexHookReviewProbe(in: workspace, attempt: 0)
        }
    }

    private static func installClaudeProjectMCPServersIfNeeded(
        agent: TerminalAgent,
        cwd: String?,
        env: [String: String],
        workspaceId: UUID
    ) {
        guard agent.id == TerminalAgent.claudeId,
              let cwd, !cwd.isEmpty else { return }
        let prepared = prepareLaunchContext(
            baseEnv: env,
            workspaceId: workspaceId
        ).prepared
        guard let mcpConfigURL = prepared.mcpConfigURL else { return }
        TermLoopClaudeHooks.installProjectMCPServers(
            workspaceCwd: cwd,
            mcpConfigURL: mcpConfigURL
        )
    }

    static func writePromptFile(_ prompt: String) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("termloop-terminal-agents", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fileURL = dir.appendingPathComponent("prompt-\(UUID().uuidString).md")
        try prompt.write(to: fileURL, atomically: true, encoding: .utf8)
        return fileURL
    }

    private static let shellScriptMaxRetainedPerPrefix = 64
    private static let shellScriptMaxAge: TimeInterval = 24 * 60 * 60

    private static func writeShellScript(_ script: String, prefix: String) -> URL? {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("termloop-terminal-agents", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            pruneShellScripts(in: dir, prefix: prefix)
            let fileURL = dir.appendingPathComponent("\(prefix)-\(UUID().uuidString).sh")
            try script.write(to: fileURL, atomically: true, encoding: .utf8)
            return fileURL
        } catch {
            return nil
        }
    }

    private static func pruneShellScripts(in dir: URL, prefix: String) {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        let now = Date()
        let stem = "\(prefix)-"
        let scripts: [(url: URL, modifiedAt: Date)] = urls.compactMap { url in
            let name = url.lastPathComponent
            guard name.hasPrefix(stem), url.pathExtension == "sh" else {
                return nil
            }
            guard let values = try? url.resourceValues(
                forKeys: [.contentModificationDateKey, .isRegularFileKey]
            ), values.isRegularFile == true else {
                return nil
            }
            return (url, values.contentModificationDate ?? .distantPast)
        }
            .sorted(by: { $0.modifiedAt > $1.modifiedAt })

        for (index, item) in scripts.enumerated() {
            let isOverflow = index >= shellScriptMaxRetainedPerPrefix
            let isStale = now.timeIntervalSince(item.modifiedAt) > shellScriptMaxAge
            if isOverflow || isStale {
                try? fm.removeItem(at: item.url)
            }
        }
    }

    private static let commandDispatchMaxAttempts = 30
    private static let commandDispatchPollInterval: TimeInterval = 0.25
    private static let shellReadyStableSamplesRequired = 3
    private static let shellEchoStableSamplesRequired = 2
    private static let visibleTextLineLimit = 60
    private static let codexHookReviewProbeInitialDelay: TimeInterval = 0.8
    private static let codexHookReviewProbeInterval: TimeInterval = 0.7
    private static let codexHookReviewProbeMaxAttempts = 18

    private final class ShellEnterGuard {
        var didSendEnter = false
    }

    private static func sendCommandWhenReady(
        to workspace: Workspace,
        command: String,
        attempt: Int
    ) {
        guard attempt < commandDispatchMaxAttempts else { return }
        lifecycleLog(
            "runner.sendCommandWhenReady workspace=\(workspace.id.uuidString) attempt=\(attempt) commandChars=\(command.count)"
        )

        if let panel = targetTerminalPanel(in: workspace) {
            if panel.surface.surface != nil {
                lifecycleLog(
                    "runner.sendCommandWhenReady.dispatch workspace=\(workspace.id.uuidString) panel=\(panel.id.uuidString) attempt=\(attempt)"
                )
                dispatchShellCommandWhenReady(command, on: panel)
                return
            }
            panel.surface.requestBackgroundSurfaceStartIfNeeded()
        } else {
            workspace.requestBackgroundTerminalSurfaceStartIfNeeded()
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + commandDispatchPollInterval) {
            sendCommandWhenReady(to: workspace, command: command, attempt: attempt + 1)
        }
    }

    static func dispatchShellCommandWhenReady(
        _ command: String,
        on panel: TerminalPanel,
        enterFallbackDelay: TimeInterval? = nil
    ) {
        lifecycleLog(
            "runner.dispatchShellCommandWhenReady panel=\(panel.id.uuidString) commandChars=\(command.count)"
        )
        waitForShellQuiescenceBeforeTyping(
            command,
            on: panel,
            enterFallbackDelay: enterFallbackDelay,
            enterGuard: ShellEnterGuard(),
            attempt: 0,
            previousVisibleText: nil,
            stableSamples: 0
        )
    }

    private static func waitForShellQuiescenceBeforeTyping(
        _ command: String,
        on panel: TerminalPanel,
        enterFallbackDelay: TimeInterval?,
        enterGuard: ShellEnterGuard,
        attempt: Int,
        previousVisibleText: String?,
        stableSamples: Int
    ) {
        guard attempt < commandDispatchMaxAttempts else {
            panel.sendText(command)
            sendEnterIfNeeded(on: panel, guard: enterGuard, reason: "shellReadyTimeout")
            return
        }

        guard panel.surface.surface != nil else {
            panel.surface.requestBackgroundSurfaceStartIfNeeded()
            DispatchQueue.main.asyncAfter(deadline: .now() + commandDispatchPollInterval) {
                waitForShellQuiescenceBeforeTyping(
                    command,
                    on: panel,
                    enterFallbackDelay: enterFallbackDelay,
                    enterGuard: enterGuard,
                    attempt: attempt + 1,
                    previousVisibleText: previousVisibleText,
                    stableSamples: stableSamples
                )
            }
            return
        }

        let visibleText = currentVisibleTerminalText(for: panel)
        let nextStableSamples = visibleText == previousVisibleText ? stableSamples + 1 : 0
        if nextStableSamples >= shellReadyStableSamplesRequired,
           terminalLooksReadyForCommand(visibleText) {
            let lastLine = visibleText
                .split(separator: "\n", omittingEmptySubsequences: false)
                .last
                .map(String.init) ?? ""
            lifecycleLog(
                "runner.shellReady panel=\(panel.id.uuidString) attempt=\(attempt) stableSamples=\(nextStableSamples) lastLine=\(lastLine)"
            )
            panel.sendText(command)
            scheduleEnterFallbackIfNeeded(
                on: panel,
                guard: enterGuard,
                command: command,
                delay: enterFallbackDelay
            )
            waitForCommandEchoQuiescenceBeforeEnter(
                on: panel,
                enterGuard: enterGuard,
                baselineVisibleText: visibleText,
                attempt: 0,
                previousVisibleText: nil,
                observedEcho: false,
                stableSamples: 0
            )
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + commandDispatchPollInterval) {
            waitForShellQuiescenceBeforeTyping(
                command,
                on: panel,
                enterFallbackDelay: enterFallbackDelay,
                enterGuard: enterGuard,
                attempt: attempt + 1,
                previousVisibleText: visibleText,
                stableSamples: nextStableSamples
            )
        }
    }

    private static func waitForCommandEchoQuiescenceBeforeEnter(
        on panel: TerminalPanel,
        enterGuard: ShellEnterGuard,
        baselineVisibleText: String,
        attempt: Int,
        previousVisibleText: String?,
        observedEcho: Bool,
        stableSamples: Int
    ) {
        guard attempt < commandDispatchMaxAttempts else {
            sendEnterIfNeeded(on: panel, guard: enterGuard, reason: "echoTimeout")
            return
        }

        guard panel.surface.surface != nil else {
            panel.surface.requestBackgroundSurfaceStartIfNeeded()
            DispatchQueue.main.asyncAfter(deadline: .now() + commandDispatchPollInterval) {
                waitForCommandEchoQuiescenceBeforeEnter(
                    on: panel,
                    enterGuard: enterGuard,
                    baselineVisibleText: baselineVisibleText,
                    attempt: attempt + 1,
                    previousVisibleText: previousVisibleText,
                    observedEcho: observedEcho,
                    stableSamples: stableSamples
                )
            }
            return
        }

        let visibleText = currentVisibleTerminalText(for: panel)
        let nextObservedEcho = observedEcho || visibleText != baselineVisibleText
        let nextStableSamples = visibleText == previousVisibleText ? stableSamples + 1 : 0
        if nextObservedEcho && nextStableSamples >= shellEchoStableSamplesRequired {
            lifecycleLog(
                "runner.shellEnter panel=\(panel.id.uuidString) attempt=\(attempt) observedEcho=\(nextObservedEcho ? 1 : 0) stableSamples=\(nextStableSamples)"
            )
            sendEnterIfNeeded(on: panel, guard: enterGuard, reason: "echoStable")
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + commandDispatchPollInterval) {
            waitForCommandEchoQuiescenceBeforeEnter(
                on: panel,
                enterGuard: enterGuard,
                baselineVisibleText: baselineVisibleText,
                attempt: attempt + 1,
                previousVisibleText: visibleText,
                observedEcho: nextObservedEcho,
                stableSamples: nextStableSamples
            )
        }
    }

    private static func scheduleEnterFallbackIfNeeded(
        on panel: TerminalPanel,
        guard enterGuard: ShellEnterGuard,
        command: String,
        delay: TimeInterval?
    ) {
        guard let delay, delay.isFinite, delay > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard terminalStillShowsPendingCommand(panel: panel, command: command) else {
#if DEBUG
                lifecycleLog("runner.shellEnter.skip panel=\(panel.id.uuidString) reason=commandChanged")
#endif
                return
            }
            sendEnterIfNeeded(on: panel, guard: enterGuard, reason: "fallback")
        }
    }

    private static func terminalStillShowsPendingCommand(
        panel: TerminalPanel,
        command: String
    ) -> Bool {
        let visibleText = currentVisibleTerminalText(for: panel)
        let lastLine = visibleText
            .split(separator: "\n", omittingEmptySubsequences: false)
            .last?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !lastLine.isEmpty && lastLine.hasSuffix(command)
    }

    private static func sendEnterIfNeeded(
        on panel: TerminalPanel,
        guard enterGuard: ShellEnterGuard,
        reason: String
    ) {
        guard !enterGuard.didSendEnter else { return }
        enterGuard.didSendEnter = true
        lifecycleLog("runner.shellEnter.send panel=\(panel.id.uuidString) reason=\(reason)")
        panel.sendInput("\r")
    }

    private static func currentVisibleTerminalText(for panel: TerminalPanel) -> String {
        TerminalController.shared.readTerminalTextForSnapshot(
            terminalPanel: panel,
            lineLimit: visibleTextLineLimit
        ) ?? ""
    }

    private static func terminalLooksReadyForCommand(_ visibleText: String) -> Bool {
        let lines = visibleText
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        guard let lastNonEmptyLine = lines.last(where: {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        })?.trimmingCharacters(in: .whitespacesAndNewlines),
              !lastNonEmptyLine.isEmpty else {
            return false
        }

        if lastNonEmptyLine.hasPrefix("Last login:") {
            return false
        }
        return true
    }

    private static func sendInputWhenReady(
        to workspace: Workspace,
        text: String,
        attempt: Int
    ) {
        guard attempt < commandDispatchMaxAttempts else { return }

        if let panel = targetTerminalPanel(in: workspace) {
            if panel.surface.surface != nil {
                panel.sendInput(text)
                return
            }
            // Relaunch restores can keep detached workspaces surface-less
            // until something explicitly asks Ghostty to materialize them.
            panel.surface.requestBackgroundSurfaceStartIfNeeded()
        } else {
            workspace.requestBackgroundTerminalSurfaceStartIfNeeded()
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + commandDispatchPollInterval) {
            sendInputWhenReady(to: workspace, text: text, attempt: attempt + 1)
        }
    }

    private static func targetTerminalPanel(in workspace: Workspace) -> TerminalPanel? {
        if let focused = workspace.focusedTerminalPanel {
            return focused
        }
        if let panelId = workspace.focusedPanelId,
           let panel = workspace.terminalPanel(for: panelId) {
            return panel
        }
        return workspace.panels.values
            .compactMap { $0 as? TerminalPanel }
            .sorted { $0.id.uuidString < $1.id.uuidString }
            .first
    }

    private static func runCodexHookReviewProbe(
        in workspace: Workspace,
        attempt: Int
    ) {
        guard attempt < codexHookReviewProbeMaxAttempts else { return }
        guard !CodexHooksStatus.shared.reviewRequired else { return }

        guard let panel = targetTerminalPanel(in: workspace) else {
            workspace.requestBackgroundTerminalSurfaceStartIfNeeded()
            scheduleNextCodexHookReviewProbe(in: workspace, attempt: attempt)
            return
        }
        guard panel.surface.surface != nil else {
            panel.surface.requestBackgroundSurfaceStartIfNeeded()
            scheduleNextCodexHookReviewProbe(in: workspace, attempt: attempt)
            return
        }

        let visibleText = currentVisibleTerminalText(for: panel)
        if CodexHooksStatus.outputIndicatesReviewRequired(visibleText) {
            CodexHooksStatus.shared.markReviewRequired(workspaceId: workspace.id)
            return
        }
        scheduleNextCodexHookReviewProbe(in: workspace, attempt: attempt)
    }

    private static func scheduleNextCodexHookReviewProbe(
        in workspace: Workspace,
        attempt: Int
    ) {
        DispatchQueue.main.asyncAfter(deadline: .now() + codexHookReviewProbeInterval) {
            runCodexHookReviewProbe(in: workspace, attempt: attempt + 1)
        }
    }

    private static func shellEnvironmentPrefix(_ env: [String: String]) -> String {
        env
            .sorted(by: { $0.key < $1.key })
            .map { "\($0.key)=\(TermLoopShell.quoteSingle($0.value))" }
            .joined(separator: " ")
    }

    private static func composeLaunchCommand(
        agent: TerminalAgent?,
        baseCommand: String,
        cwd: String?,
        env: [String: String],
        workspaceId: UUID
    ) -> String {
        let context = prepareLaunchContext(baseEnv: env, workspaceId: workspaceId)
        let injectedBaseCommand = context.prepared.injectFlagsIfSupported(into: baseCommand)
        let launched: String = {
            if let agent {
                let wrapped = prepareWrappedLaunch(
                    for: agent,
                    baseCommand: injectedBaseCommand,
                    env: context.env
                )
                let envPrefix = shellEnvironmentPrefix(wrapped.env)
                if envPrefix.isEmpty { return wrapped.command }
                return envPrefix + " " + wrapped.command
            }
            let envPrefix = shellEnvironmentPrefix(context.env)
            if envPrefix.isEmpty { return injectedBaseCommand }
            return envPrefix + " " + injectedBaseCommand
        }()

        var cmd = ""
        if let cwd, !cwd.isEmpty {
            cmd += "cd \(TermLoopShell.quoteSingle(cwd)) && "
        }
        cmd += launched
        return cmd
    }

    private static func prepareBootstrapLaunch(
        agent: TerminalAgent,
        baseCommand: String,
        env: [String: String],
        workspaceId: UUID
    ) -> BootstrapLaunch? {
        let context = prepareLaunchContext(baseEnv: env, workspaceId: workspaceId)
        let injectedBaseCommand = context.prepared.injectFlagsIfSupported(into: baseCommand)
        let wrapped = prepareWrappedLaunch(
            for: agent,
            baseCommand: injectedBaseCommand,
            env: context.env
        )
        guard let bootstrapScript = writeBootstrapCommandScript(command: wrapped.command) else {
            return nil
        }
        return BootstrapLaunch(
            initialCommand: "sh \(TermLoopShell.quoteSingle(bootstrapScript.path))",
            initialEnvironment: wrapped.env
        )
    }

    private static func prepareLaunchContext(
        baseEnv: [String: String],
        workspaceId: UUID
    ) -> (env: [String: String], prepared: IntegrationsSpawnPrep.Prepared) {
        var attachedItems = IntegrationsStore.shared.items.filter(\.attachedToActiveSpawn)
        let builtIn = TermLoopBuiltInMCP.item()
        if !attachedItems.contains(where: { $0.id == builtIn.id }) {
            attachedItems.append(builtIn)
        }

        var dedupedById: [String: IntegrationItem] = [:]
        for item in attachedItems {
            dedupedById[item.id] = item
        }

        let prepared = IntegrationsSpawnPrep.prepare(
            items: dedupedById.values.sorted { $0.id < $1.id },
            workspaceId: workspaceId.uuidString,
            launchEnvironment: baseEnv
        )

        var mergedEnv = prepared.envVars
        for (key, value) in baseEnv {
            mergedEnv[key] = value
        }
        let workspaceIdString = workspaceId.uuidString
        // Snapshot restore can carry a stale TermLoop identity env from the
        // previous app process. The current workspace id is authoritative for
        // hook routing.
        mergedEnv["TERMLOOP_WORKSPACE_ID"] = workspaceIdString
        return (mergedEnv, prepared)
    }

    private static func preferredRestoreCwd(
        for agent: TerminalAgent,
        fallbackCwd: String?,
        persistedSession: PersistedAgentSession?,
        worktreeExpectation: TermLoopWorktreeExpectation?
    ) -> String? {
        if let worktreePath = worktreeExpectation?.path
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !worktreePath.isEmpty,
           FileManager.default.fileExists(atPath: worktreePath) {
            return worktreePath
        }
        guard let persistedSession,
              persistedSession.agentId == agent.id,
              let cwd = persistedSession.cwd?.trimmingCharacters(in: .whitespacesAndNewlines),
              !cwd.isEmpty,
              FileManager.default.fileExists(atPath: cwd) else {
            return fallbackCwd
        }
        return cwd
    }

    static func supportsResume(agentId: String) -> Bool {
        switch agentId {
        case "claude", "codex":
            return true
        default:
            return false
        }
    }

    private static func restoredBaseCommand(
        for agent: TerminalAgent,
        persistedSession: PersistedAgentSession?,
        restoreCwd: String?
    ) -> String? {
        guard let persistedSession,
              persistedSession.agentId == agent.id else {
            return nil
        }
        let sessionId = persistedSession.sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sessionId.isEmpty else { return nil }
        switch agent.id {
        case "codex":
            let trimmedRestoreCwd = restoreCwd?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return TerminalCommandQuoter.join(
                [launchExecutable(for: agent), "resume"]
                + agent.argv
                + (trimmedRestoreCwd.map { ["--cd", $0] } ?? [])
                + [sessionId]
            )
        default:
            return nil
        }
    }

    private static func prepareWrappedLaunch(
        for agent: TerminalAgent,
        baseCommand: String,
        env: [String: String]
    ) -> (command: String, env: [String: String]) {
        guard agent.id == "codex",
              let workspaceId = env["TERMLOOP_WORKSPACE_ID"]?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !workspaceId.isEmpty else {
            return (baseCommand, env)
        }

        var launchEnv = env
        let readyMarker = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("termloop-codex-ready-\(workspaceId).flag")
            .path
        launchEnv["TERMLOOP_CODEX_READY_MARKER"] = readyMarker
        let failurePreview = failurePreview(
            for: agent,
            baseCommand: baseCommand
        )
        guard let launcherScript = writeCodexReadyLaunchScript(
            baseCommand: baseCommand,
            workspaceId: workspaceId,
            failurePreview: failurePreview
        ) else {
            return (baseCommand, launchEnv)
        }

        let launchCommand = "sh \(TermLoopShell.quoteSingle(launcherScript.path))"
        return (launchCommand, launchEnv)
    }

    /// Re-exports the project-selected Claude OAuth token from its private
    /// mirror env var (`TERMLOOP_CLAUDE_OAUTH_OVERRIDE`) onto
    /// `CLAUDE_CODE_OAUTH_TOKEN` *after* `zsh -ilc` has sourced `~/.zshrc`.
    /// Without this, a user's rc-file `export CLAUDE_CODE_OAUTH_TOKEN=…`
    /// silently shadows the resolver-injected token and the spawned agent
    /// authenticates with the wrong account.
    private static let claudeOauthPostRcOverride = """
    if [ -n "$TERMLOOP_CLAUDE_OAUTH_OVERRIDE" ]; then
        export CLAUDE_CODE_OAUTH_TOKEN="$TERMLOOP_CLAUDE_OAUTH_OVERRIDE"
    fi
    """

    private static func writeBootstrapCommandScript(command: String) -> URL? {
        let delimiter = hereDocDelimiter(prefix: "TERMLOOP_TERMLOOP_BOOTSTRAP_EOF")
        // `TERMLOOP_LAUNCH_PROVIDED_CONTEXT` is the runner→wrapper signal
        // "I already inlined the joined system prompt for THIS agent
        // invocation; skip the socket fetch." It must NOT survive into the
        // post-agent interactive shell, otherwise the next `claude` /
        // `codex` typed by the user in the same panel matches the skip
        // gate in `termloop_context_should_skip` and silently launches
        // with no abilities and no reported-context block. Unset it
        // between the agent line and the exec'd interactive shell so the
        // shell (and every subsequent agent invocation under it) sees a
        // clean environment.
        let script = """
        #!/bin/sh
        cmux_termloop_shell="${SHELL:-/bin/zsh}"
        cmux_termloop_command="$(cat <<'\(delimiter)'
        \(claudeOauthPostRcOverride)
        exec \(command)
        \(delimiter)
        )"
        "$cmux_termloop_shell" -ilc "$cmux_termloop_command"
        unset TERMLOOP_LAUNCH_PROVIDED_CONTEXT
        unset TERMLOOP_CLAUDE_OAUTH_OVERRIDE
        exec "$cmux_termloop_shell" -il
        """
        return writeShellScript(script, prefix: "termloop-bootstrap")
    }

    private static func wrapInlineShellCommandForDispatch(
        _ command: String,
        prefix: String
    ) -> String? {
        let delimiter = hereDocDelimiter(prefix: "TERMLOOP_TERMLOOP_INLINE_DISPATCH_EOF")
        let script = """
        #!/bin/sh
        cmux_termloop_shell="${SHELL:-/bin/zsh}"
        cmux_termloop_command="$(cat <<'\(delimiter)'
        \(claudeOauthPostRcOverride)
        \(command)
        \(delimiter)
        )"
        exec "$cmux_termloop_shell" -ilc "$cmux_termloop_command"
        """
        guard let scriptURL = writeShellScript(script, prefix: prefix) else {
            return nil
        }
        return "sh \(TermLoopShell.quoteSingle(scriptURL.path))"
    }

    private static func hereDocDelimiter(prefix: String) -> String {
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "_")
        return "\(prefix)_\(token)"
    }

    private static func writeCodexReadyLaunchScript(
        baseCommand: String,
        workspaceId: String,
        failurePreview: String
    ) -> URL? {
        let isResumeLaunch = baseCommand.contains(" resume ")
        let reportsReadyBeforeLaunch = !isResumeLaunch
        let readyBlock: String = {
            guard reportsReadyBeforeLaunch else { return "" }
            let readyPayload = TermLoopShell.quoteSingle("""
            {"workspace_id":"\(workspaceId)","agent_id":"codex","phase":"ready"}
            """)
            return """
            if [ -n "$cmux_termloop_cli" ]; then
                "$cmux_termloop_cli" rpc workspace.report_agent_activity \(readyPayload) >/dev/null 2>&1 || true
            fi
            """
        }()
        let clearPayload = TermLoopShell.quoteSingle("""
        {"workspace_id":"\(workspaceId)"}
        """)
        let failedPayload = TermLoopShell.quoteSingle("""
        {"workspace_id":"\(workspaceId)","agent_id":"codex","phase":"failed","message_preview":"\(failurePreview)"}
        """)

        let script = """
        #!/bin/sh
        cmux_termloop_cli="${TERMLOOP_BUNDLED_CLI_PATH:-}"
        if [ -z "$cmux_termloop_cli" ]; then
            cmux_termloop_cli="$(command -v termloop 2>/dev/null || true)"
        fi
        if [ -n "${TERMLOOP_SHELL_INTEGRATION_DIR:-}" ]; then
            cmux_termloop_bundle_dir="${TERMLOOP_SHELL_INTEGRATION_DIR%/shell-integration}"
            cmux_termloop_bundle_bin="$cmux_termloop_bundle_dir/bin"
            if [ -d "$cmux_termloop_bundle_bin" ]; then
                case ":${PATH:-}:" in
                    *:"$cmux_termloop_bundle_bin":*) ;;
                    *) PATH="$cmux_termloop_bundle_bin${PATH:+:$PATH}" ;;
                esac
                export PATH
            fi
        fi
        cmux_restore_monitor_pid=""
        cmux_fresh_monitor_pid=""
        cmux_codex_launch_started="$(date +%s)"

        codex_fresh_session_monitor() {
            [ -n "$cmux_termloop_cli" ] || return 0
            [ -z "${TERMLOOP_CODEX_RESTORE_SESSION_ID:-}" ] || return 0
            command -v /usr/bin/python3 >/dev/null 2>&1 || return 0
            TERMLOOP_TERMLOOP_WORKSPACE_ID="\(workspaceId)" TERMLOOP_TERMLOOP_LAUNCH_STARTED="${cmux_codex_launch_started:-0}" TERMLOOP_TERMLOOP_CLI="$cmux_termloop_cli" TERMLOOP_TERMLOOP_READY_MARKER="${TERMLOOP_CODEX_READY_MARKER:-}" /usr/bin/python3 - <<'PY' >/dev/null 2>&1
        import json, os, subprocess, time
        from datetime import datetime, timedelta
        from pathlib import Path

        workspace_id = os.environ.get("TERMLOOP_TERMLOOP_WORKSPACE_ID", "").strip()
        cli = os.environ.get("TERMLOOP_TERMLOOP_CLI", "").strip()
        ready_marker = os.environ.get("TERMLOOP_TERMLOOP_READY_MARKER", "").strip()
        cwd = os.getcwd()
        try:
            started = float(os.environ.get("TERMLOOP_TERMLOOP_LAUNCH_STARTED", "0") or "0")
        except Exception:
            started = 0.0
        cutoff = max(0.0, started - 5.0)
        sessions_dir = Path.home() / ".codex" / "sessions"
        if not workspace_id or not cli or not sessions_dir.exists():
            raise SystemExit(0)

        days = [datetime.now(), datetime.now() - timedelta(days=1)]
        search_roots = []
        for day in days:
            root = sessions_dir / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}"
            if root.exists():
                search_roots.append(root)

        def report(payload):
            subprocess.run(
                [cli, "rpc", "workspace.report_agent_activity", payload],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )

        def fresh_lifecycle_activity(path):
            last = ""
            try:
                with path.open("r", encoding="utf-8") as handle:
                    for raw_line in handle:
                        try:
                            obj = json.loads(raw_line)
                        except Exception:
                            continue
                        if obj.get("type") != "event_msg":
                            continue
                        payload = obj.get("payload") or {}
                        event_type = payload.get("type")
                        if event_type == "task_started":
                            last = "running"
                        elif event_type == "task_complete":
                            last = "completed"
                        elif event_type == "turn_aborted" and payload.get("reason") == "interrupted":
                            last = "ready"
            except Exception:
                return "ready"
            return last or "ready"

        def fresh_activity_payload(session_id, session_cwd, activity):
            payload = {
                "workspace_id": workspace_id,
                "agent_id": "codex",
                "session_id": session_id,
                "cwd": session_cwd,
            }
            if activity == "running":
                payload["phase"] = "running"
            elif activity == "completed":
                payload["phase"] = "waiting"
                payload["attention_kind"] = "completion"
            else:
                payload["phase"] = "ready"
            return json.dumps(payload, separators=(",", ":"))

        def recent_session():
            matches = []
            for root in search_roots:
                for path in root.glob("*.jsonl"):
                    try:
                        stat = path.stat()
                    except Exception:
                        continue
                    created_at = getattr(stat, "st_birthtime", stat.st_mtime)
                    if created_at < cutoff:
                        continue
                    session_id = ""
                    session_cwd = ""
                    try:
                        with path.open("r", encoding="utf-8") as handle:
                            for raw_line in handle:
                                try:
                                    obj = json.loads(raw_line)
                                except Exception:
                                    continue
                                if obj.get("type") != "session_meta":
                                    continue
                                meta = obj.get("payload") or {}
                                session_id = str(meta.get("id") or "").strip()
                                session_cwd = str(meta.get("cwd") or "").strip()
                                break
                    except Exception:
                        continue
                    if not session_id:
                        continue
                    if session_cwd and session_cwd != cwd:
                        continue
                    matches.append((created_at, stat.st_mtime, path, session_id, session_cwd or cwd))
            if not matches:
                return None
            _, _, path, session_id, session_cwd = max(matches)
            return path, session_id, session_cwd

        session = None

        for _ in range(40):
            if ready_marker and not Path(ready_marker).exists():
                raise SystemExit(0)
            session = recent_session()
            if session:
                break
            time.sleep(0.5)

        if not session:
            raise SystemExit(0)

        path, session_id, session_cwd = session
        last_mtime = None
        last_activity = None

        while True:
            if ready_marker and not Path(ready_marker).exists():
                raise SystemExit(0)
            try:
                mtime = path.stat().st_mtime
            except Exception:
                raise SystemExit(0)
            if mtime != last_mtime:
                last_mtime = mtime
                activity = fresh_lifecycle_activity(path)
                if activity != last_activity:
                    report(fresh_activity_payload(session_id, session_cwd, activity))
                    last_activity = activity
            time.sleep(1)
        PY
        }

        codex_restore_report_phase() {
            phase="$1"
            [ -n "$cmux_termloop_cli" ] || return 0
            [ -n "${TERMLOOP_CODEX_RESTORE_SESSION_ID:-}" ] || return 0
            command -v /usr/bin/python3 >/dev/null 2>&1 || return 0
            payload="$(TERMLOOP_TERMLOOP_WORKSPACE_ID="\(workspaceId)" TERMLOOP_TERMLOOP_RESTORE_PHASE="$phase" TERMLOOP_TERMLOOP_RESTORE_SESSION_ID="${TERMLOOP_CODEX_RESTORE_SESSION_ID:-}" TERMLOOP_TERMLOOP_RESTORE_CWD="${TERMLOOP_CODEX_RESTORE_CWD:-}" /usr/bin/python3 - <<'PY'
        import json, os
        payload = {
            "workspace_id": os.environ.get("TERMLOOP_TERMLOOP_WORKSPACE_ID", ""),
            "agent_id": "codex",
            "phase": os.environ.get("TERMLOOP_TERMLOOP_RESTORE_PHASE", ""),
            "session_id": os.environ.get("TERMLOOP_TERMLOOP_RESTORE_SESSION_ID", ""),
        }
        cwd = os.environ.get("TERMLOOP_TERMLOOP_RESTORE_CWD", "")
        if cwd:
            payload["cwd"] = cwd
        print(json.dumps(payload, separators=(",", ":")))
        PY
            )"
            [ -n "$payload" ] || return 0
            "$cmux_termloop_cli" rpc workspace.report_agent_activity "$payload" >/dev/null 2>&1 || true
        }

        codex_restore_report_completion() {
            [ -n "$cmux_termloop_cli" ] || return 0
            [ -n "${TERMLOOP_CODEX_RESTORE_SESSION_ID:-}" ] || return 0
            command -v /usr/bin/python3 >/dev/null 2>&1 || return 0
            payload="$(TERMLOOP_TERMLOOP_WORKSPACE_ID="\(workspaceId)" TERMLOOP_TERMLOOP_RESTORE_SESSION_ID="${TERMLOOP_CODEX_RESTORE_SESSION_ID:-}" TERMLOOP_TERMLOOP_RESTORE_CWD="${TERMLOOP_CODEX_RESTORE_CWD:-}" /usr/bin/python3 - <<'PY'
        import json, os
        payload = {
            "workspace_id": os.environ.get("TERMLOOP_TERMLOOP_WORKSPACE_ID", ""),
            "agent_id": "codex",
            "phase": "waiting",
            "attention_kind": "completion",
            "session_id": os.environ.get("TERMLOOP_TERMLOOP_RESTORE_SESSION_ID", ""),
        }
        cwd = os.environ.get("TERMLOOP_TERMLOOP_RESTORE_CWD", "")
        if cwd:
            payload["cwd"] = cwd
        print(json.dumps(payload, separators=(",", ":")))
        PY
            )"
            [ -n "$payload" ] || return 0
            "$cmux_termloop_cli" rpc workspace.report_agent_activity "$payload" >/dev/null 2>&1 || true
        }

        codex_restore_session_file() {
            [ -n "${TERMLOOP_CODEX_RESTORE_SESSION_ID:-}" ] || return 1
            command -v /usr/bin/python3 >/dev/null 2>&1 || return 1
            TERMLOOP_TERMLOOP_RESTORE_SESSION_ID="${TERMLOOP_CODEX_RESTORE_SESSION_ID:-}" TERMLOOP_TERMLOOP_RESTORE_CWD="${TERMLOOP_CODEX_RESTORE_CWD:-}" /usr/bin/python3 - <<'PY'
        import json, os
        from pathlib import Path

        session_id = (os.environ.get("TERMLOOP_TERMLOOP_RESTORE_SESSION_ID") or "").strip()
        cwd = (os.environ.get("TERMLOOP_TERMLOOP_RESTORE_CWD") or "").strip()
        if not session_id:
            raise SystemExit(1)

        sessions_dir = Path.home() / ".codex" / "sessions"
        if not sessions_dir.exists():
            raise SystemExit(1)

        for path in sessions_dir.rglob("*.jsonl"):
            try:
                with path.open("r", encoding="utf-8") as handle:
                    for raw_line in handle:
                        try:
                            obj = json.loads(raw_line)
                        except Exception:
                            continue
                        if obj.get("type") != "session_meta":
                            continue
                        payload = obj.get("payload") or {}
                        if payload.get("id") != session_id:
                            break
                        payload_cwd = (payload.get("cwd") or "").strip()
                        if cwd and payload_cwd and payload_cwd != cwd:
                            break
                        print(path)
                        raise SystemExit(0)
                        break
            except Exception:
                continue

        raise SystemExit(1)
        PY
        }

        codex_restore_file_mtime() {
            [ -n "$1" ] || return 1
            command -v /usr/bin/python3 >/dev/null 2>&1 || return 1
            TERMLOOP_TERMLOOP_SESSION_FILE="$1" /usr/bin/python3 - <<'PY'
        import os
        from pathlib import Path

        path = Path(os.environ.get("TERMLOOP_TERMLOOP_SESSION_FILE", ""))
        if not path.exists():
            raise SystemExit(1)
        print(f"{path.stat().st_mtime:.6f}")
        PY
        }

        codex_restore_session_activity() {
            [ -n "$1" ] || return 1
            command -v /usr/bin/python3 >/dev/null 2>&1 || return 1
            TERMLOOP_TERMLOOP_SESSION_FILE="$1" /usr/bin/python3 - <<'PY'
        import json, os
        from pathlib import Path

        path = Path(os.environ.get("TERMLOOP_TERMLOOP_SESSION_FILE", ""))
        if not path.exists():
            raise SystemExit(1)

        last = ""
        with path.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                try:
                    obj = json.loads(raw_line)
                except Exception:
                    continue
                if obj.get("type") != "event_msg":
                    continue
                payload = obj.get("payload") or {}
                event_type = payload.get("type")
                if event_type == "task_started":
                    last = "running"
                elif event_type == "task_complete":
                    last = "completed"
                elif event_type == "turn_aborted" and payload.get("reason") == "interrupted":
                    last = "interrupted"

        if last:
            print(last)
        PY
        }

        codex_restore_apply_activity() {
            activity="$1"
            case "$activity" in
                running)
                    codex_restore_report_phase running
                    ;;
                interrupted)
                    codex_restore_report_phase ready
                    ;;
                completed)
                    codex_restore_report_completion
                    ;;
            esac
        }

        codex_restore_fallback_monitor() {
            [ -n "${TERMLOOP_CODEX_READY_MARKER:-}" ] || return 0
            session_file="$(codex_restore_session_file 2>/dev/null || true)"
            [ -n "$session_file" ] || return 0
            baseline_mtime="$(codex_restore_file_mtime "$session_file" 2>/dev/null || true)"
            [ -n "$baseline_mtime" ] || baseline_mtime="0"

            codex_restore_report_phase running

            sleep 2
            [ -f "$TERMLOOP_CODEX_READY_MARKER" ] || return 0
            next_mtime="$(codex_restore_file_mtime "$session_file" 2>/dev/null || true)"
            [ -n "$next_mtime" ] || next_mtime="$baseline_mtime"
            if [ "$next_mtime" = "$baseline_mtime" ]; then
                codex_restore_report_phase ready
            else
                baseline_mtime="$next_mtime"
                current_activity="$(codex_restore_session_activity "$session_file" 2>/dev/null || true)"
                codex_restore_apply_activity "$current_activity"
            fi

            while [ -f "$TERMLOOP_CODEX_READY_MARKER" ]; do
                sleep 1
                next_mtime="$(codex_restore_file_mtime "$session_file" 2>/dev/null || true)"
                [ -n "$next_mtime" ] || continue
                [ "$next_mtime" = "$baseline_mtime" ] && continue
                baseline_mtime="$next_mtime"
                current_activity="$(codex_restore_session_activity "$session_file" 2>/dev/null || true)"
                codex_restore_apply_activity "$current_activity"
            done
        }

        if [ -n "${TERMLOOP_CODEX_READY_MARKER:-}" ]; then
            : > "$TERMLOOP_CODEX_READY_MARKER" 2>/dev/null || true
        fi
        \(readyBlock)
        if [ -n "${TERMLOOP_CODEX_RESTORE_SESSION_ID:-}" ]; then
            codex_restore_fallback_monitor &
            cmux_restore_monitor_pid="$!"
        else
            codex_fresh_session_monitor &
            cmux_fresh_monitor_pid="$!"
        fi
        \(baseCommand)
        cmux_termloop_status=$?
        if [ -n "$cmux_restore_monitor_pid" ]; then
            kill "$cmux_restore_monitor_pid" >/dev/null 2>&1 || true
            wait "$cmux_restore_monitor_pid" >/dev/null 2>&1 || true
        fi
        if [ -n "$cmux_fresh_monitor_pid" ]; then
            kill "$cmux_fresh_monitor_pid" >/dev/null 2>&1 || true
            wait "$cmux_fresh_monitor_pid" >/dev/null 2>&1 || true
        fi
        if [ -n "${TERMLOOP_CODEX_READY_MARKER:-}" ] && [ -f "$TERMLOOP_CODEX_READY_MARKER" ] && [ -n "$cmux_termloop_cli" ]; then
            if [ "$cmux_termloop_status" -eq 0 ]; then
                "$cmux_termloop_cli" rpc workspace.clear_agent_activity \(clearPayload) >/dev/null 2>&1 || true
            else
                "$cmux_termloop_cli" rpc workspace.report_agent_activity \(failedPayload) >/dev/null 2>&1 || true
            fi
        fi
        if [ -n "${TERMLOOP_CODEX_READY_MARKER:-}" ]; then
            rm -f "$TERMLOOP_CODEX_READY_MARKER" >/dev/null 2>&1 || true
        fi
        exit "$cmux_termloop_status"
        """

        return writeShellScript(script, prefix: "termloop-codex-launch")
    }

    private static func failurePreview(
        for agent: TerminalAgent,
        baseCommand: String
    ) -> String {
        switch agent.id {
        case "codex":
            if baseCommand.contains(" resume ") {
                return "Codex resume failed"
            }
            return "Codex launch failed"
        default:
            return "\(agent.displayName) failed"
        }
    }

    /// Adds TermLoop-managed env vars on top of any caller-supplied ones.
    /// `TERMLOOP_WORKSPACE_ID` lets hook scripts (claude/codex/...) call
    /// `workspace.report_agent_activity` directly without a session-id
    /// reverse lookup. TermLoop-owned identity keys are always refreshed from
    /// the current workspace so restored sessions cannot report to stale ids.
    private static func agentEnvironment(
        base: [String: String],
        workspaceId: UUID,
        agentId: String? = nil,
        launchProvidedContext: Bool = false
    ) -> [String: String] {
        var merged = base
        let workspaceIdString = workspaceId.uuidString
        merged["TERMLOOP_WORKSPACE_ID"] = workspaceIdString
        if let agentId,
           !agentId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           merged["TERMLOOP_AGENT_ID"] == nil {
            merged["TERMLOOP_AGENT_ID"] = agentId
        }
        if merged["TERMLOOP_ENABLED_MCP_TOOLS"] == nil,
           let names = enabledAbilityMCPToolNames() {
            merged["TERMLOOP_ENABLED_MCP_TOOLS"] = names
        }
        if let agentId {
            let overlay = ClaudeCredentialEnvResolver.envOverlay(
                forWorkspaceId: workspaceId,
                agentId: agentId
            )
            // Project-level credential binding is an explicit user intent,
            // so the overlay must override parent-shell env (e.g. a stray
            // `CLAUDE_CODE_OAUTH_TOKEN` exported in ~/.zshrc would otherwise
            // shadow the selected profile and the spawned `claude` would
            // authenticate as the wrong account). When the resolver returns
            // an empty overlay (no profile bound, or token missing), we
            // intentionally don't touch `merged` so the parent-env fallback
            // still works.
            for (key, value) in overlay {
                merged[key] = value
            }
            ClaudeCredentialEnvResolver.stampResolvedProfileIfNeeded(
                forWorkspaceId: workspaceId,
                agentId: agentId
            )
        }
        // Set ONLY when the caller actually delivered the full per-
        // workspace context (abilities + reported state) inline via
        // --append-system-prompt / model_instructions_file. Wrappers
        // honor it as "skip socket fetch — runner already covered it".
        // Restart / restore / default-launch paths must leave it false
        // so the wrapper still picks up ability + reported context
        // from the socket. False positives here silently strip context.
        if launchProvidedContext, merged["TERMLOOP_LAUNCH_PROVIDED_CONTEXT"] == nil {
            merged["TERMLOOP_LAUNCH_PROVIDED_CONTEXT"] = "1"
        }
        return merged
    }

    /// Comma-separated names of TermLoop built-in MCP tools that currently-
    /// active abilities have opted into (activation != .off). The bundled MCP
    /// server (`TermLoopMCPServer`) reads this at startup and filters its
    /// built-in tool registry. Returns nil when nothing is opted in.
    private static func enabledAbilityMCPToolNames() -> String? {
        // AbilityStore is lazy-loaded by AbilitiesPanel.onAppear; agent launches
        // can fire before the panel ever rendered, so kick a start() defensively.
        AbilityStore.shared.start()
        let allAbilities = AbilityStore.shared.abilities
        let active = allAbilities.filter { $0.activation != .off }
        var names = Set(active.flatMap { $0.enabledMCPToolNames })
        // Same defense for Running Your Application: if the ability is
        // active, expose the run-target tools regardless of
        // `termLoopMCPTools` — otherwise the sidebar chip pipeline silently
        // has no producer.
        if active.contains(where: { $0.id == TermLoopBuiltInMCP.runningYourApplicationAbilityId }) {
            names.insert(TermLoopBuiltInMCP.setRunTargetsToolName)
            names.insert(TermLoopBuiltInMCP.getRunTargetsToolName)
        }
        let sorted = names.sorted()
        lifecycleLog(
            "mcp.tools.gather abilities=\(allAbilities.count) enabledTools=\(sorted.count) names=\(sorted.joined(separator: ","))"
        )
        guard !sorted.isEmpty else { return nil }
        return sorted.joined(separator: ",")
    }

    /// Per-agent hook installation. Ensures user-scope hooks are current,
    /// then cleans up any TermLoop entries older versions wrote into the
    /// workspace's project-scope config.
    static func installAgentHooks(agent: TerminalAgent, cwd: String?) {
        if let sync = HookManagedAgent(rawValue: agent.id) {
            UserScopeHookSync.ensureInstalled(for: sync)
        }
        if let cwd, !cwd.isEmpty {
            let projectURL = URL(fileURLWithPath: cwd, isDirectory: true)
            UserScopeHookSync.cleanupProjectScopeAllAgents(at: projectURL)
        }
    }
}
