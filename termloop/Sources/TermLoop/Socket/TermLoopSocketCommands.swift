// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Foundation
import CryptoKit
#if canImport(Security)
import Security
#endif

/// TermLoop-side registry for v2 JSON socket commands that are owned by the
/// fork (currently all `project.*` methods). Upstream `TerminalController`
/// forwards the method name via a marker-wrapped hook; if this registry
/// returns `nil`, upstream continues its own dispatch.
///
/// Handlers execute on the main actor because they touch `ProjectStore`
/// (`@MainActor`) and `AppDelegate` window/tab state.
@MainActor
enum TermLoopSocketCommands {
    /// Dispatch a v2 socket method. Returns `nil` if the method is not owned
    /// by TermLoop (upstream should handle it).
    ///
    /// `isTcpClient` is set when the connection arrived via the mobile TCP
    /// bridge. TCP callers are limited to a read-only subset of `agent.*`
    /// methods — mutating calls receive a `forbidden` error.
    static func handle(method: String, params: [String: Any],
                       isTcpClient: Bool = false) -> TerminalController.V2CallResult? {
        if method.hasPrefix("agent.") {
            if isTcpClient && !AgentSocketCommands.tcpAllowed.contains(method) {
                return .err(code: "forbidden",
                           message: "agent.* writes require Unix socket", data: nil)
            }
            return AgentSocketCommands.handle(method: method, params: params)
        }
        switch method {
        case "auth.token":             return authToken(params)
        case "pairing.create":         return pairingCreate(params, isTcpClient: isTcpClient)
        case "pairing.claim":          return pairingClaim(params)
        case "pairing.list_devices":   return pairingListDevices(params)
        case "pairing.revoke_device":  return pairingRevokeDevice(params)
        case "project.list":           return projectList(params)
        case "project.current":        return projectCurrent(params)
        case "project.create":         return projectCreate(params)
        case "project.rename":         return projectRename(params)
        case "project.update_folder":  return projectUpdateFolder(params)
        case "project.delete":         return projectDelete(params)
        case "project.switch":         return projectSwitch(params)
        case "workspace.report_claude_session": return workspaceReportClaudeSession(params)
        case "workspace.clear_claude_session":  return workspaceClearClaudeSession(params)
        case "workspace.kill_claude_session":   return workspaceKillClaudeSession(params)
        case "workspace.prepare_claude_resume": return workspacePrepareClaudeResume(params)
        case "workspace.spawn_claude_session":  return workspaceSpawnClaudeSession(params)
        case "workspace.claude_system_prompt":  return workspaceAgentSystemPrompt(params, defaultAgentId: TerminalAgent.claudeId)
        case "workspace.agent_system_prompt":   return workspaceAgentSystemPrompt(params, defaultAgentId: TerminalAgent.claudeId)
        case "worktree.list":     return worktreeList(params)
        case "worktree.attach":   return worktreeAttach(params)
        case "worktree.detach":   return worktreeDetach(params)
        case "worktree.prune":    return worktreePrune(params)
        case "worktree.branches": return worktreeBranches(params)
        case "termloop.list_terminal_agents":       return listTerminalAgents(params)
        case "termloop.list_workspace_panes":       return listWorkspacePanes(params)
        case "termloop.set_project_default_agent":  return setProjectDefaultAgent(params)
        case "events.subscribe":   return eventsSubscribe(params)
        case "events.unsubscribe": return eventsUnsubscribe(params)
        case "workspace.report_agent_activity": return workspaceReportAgentActivity(params)
        case "workspace.report_agent_binding": return workspaceReportAgentBinding(params)
        case "workspace.get_jira_ticket": return workspaceGetJiraTicket(params)
        case "workspace.set_run_targets": return workspaceSetRunTargets(params)
        case "workspace.get_run_targets": return workspaceGetRunTargets(params)
        case "workspace.clear_agent_activity":  return workspaceClearAgentActivity(params)
        case "workspace.context_bank_propose_suggestion": return workspaceContextBankProposeSuggestion(params)
        case "workspace.context_bank_finalize_run":       return workspaceContextBankFinalizeRun(params)
        case "internal.hook_event":      return v2InternalHookEvent(params: params, isTcp: isTcpClient)
        case "workspace.clear_attention": return v2WorkspaceClearAttention(params: params)
        case "push.register":   return pushRegister(params)
        case "push.unregister": return pushUnregister(params)
        case "bridge.ask_to":   return bridgeAskTo(params)
        default:
            return nil
        }
    }

    // MARK: - Mobile pairing

    private static func authToken(_ params: [String: Any]) -> TerminalController.V2CallResult {
        TermLoopMobilePairingStore.authenticate(params: params)
    }

    private static func pairingCreate(_ params: [String: Any], isTcpClient: Bool) -> TerminalController.V2CallResult {
        guard !isTcpClient else {
            return .err(code: "forbidden", message: "pairing.create requires a local TermLoop client", data: nil)
        }
        return TermLoopMobilePairingStore.createPairing(params: params)
    }

    private static func pairingClaim(_ params: [String: Any]) -> TerminalController.V2CallResult {
        TermLoopMobilePairingStore.claim(params: params)
    }

    private static func pairingListDevices(_ params: [String: Any]) -> TerminalController.V2CallResult {
        TermLoopMobilePairingStore.listDevices()
    }

    private static func pairingRevokeDevice(_ params: [String: Any]) -> TerminalController.V2CallResult {
        TermLoopMobilePairingStore.revokeDevice(params: params)
    }

    // MARK: - Project commands

    private static func projectList(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let store = ProjectStore.shared
        let activeId = store.activeProjectId
        let activeIdString = activeId?.uuidString
        let openIdStrings = store.openProjectIds.map { $0.uuidString }
        let projects: [[String: Any]] = store.projects.map { project in
            projectSummaryPayload(
                project: project,
                active: project.id == activeId,
                open: store.openProjectIds.contains(project.id)
            )
        }
        return .ok([
            "projects": projects,
            "active_project_id": orNull(activeIdString),
            "open_project_ids": openIdStrings
        ])
    }

    private static func projectCurrent(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let store = ProjectStore.shared
        guard let activeId = store.activeProjectId, let project = store.project(id: activeId) else {
            return .err(code: "not_found", message: "No active project", data: nil)
        }
        let payload = projectSummaryPayload(
            project: project,
            active: true,
            open: store.openProjectIds.contains(activeId)
        )
        return .ok(payload)
    }

    private static func projectCreate(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let name = rawString(params, "name")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty else {
            return .err(code: "invalid_params", message: "Missing or empty name", data: nil)
        }
        guard let folderPath = rawString(params, "folder_path")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !folderPath.isEmpty else {
            return .err(code: "invalid_params", message: "Missing or empty folder_path", data: nil)
        }

        do {
            let project = try ProjectStore.shared.create(name: name, folderPath: folderPath)
            return .ok(projectSummaryPayload(project: project, active: true, open: true))
        } catch let error as ProjectStoreError {
            return projectStoreErrorToV2(error)
        } catch {
            return .err(code: "internal_error", message: error.localizedDescription, data: nil)
        }
    }

    private static func projectRename(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let projectId = uuid(params, "project_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid project_id", data: nil)
        }
        guard let name = rawString(params, "name")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty else {
            return .err(code: "invalid_params", message: "Missing or empty name", data: nil)
        }

        do {
            try ProjectStore.shared.rename(id: projectId, newName: name)
            let store = ProjectStore.shared
            if let project = store.project(id: projectId) {
                return .ok(projectSummaryPayload(
                    project: project,
                    active: store.activeProjectId == projectId,
                    open: store.openProjectIds.contains(projectId)
                ))
            } else {
                return .err(code: "not_found", message: "Project not found", data: nil)
            }
        } catch let error as ProjectStoreError {
            return projectStoreErrorToV2(error)
        } catch {
            return .err(code: "internal_error", message: error.localizedDescription, data: nil)
        }
    }

    private static func projectUpdateFolder(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let projectId = uuid(params, "project_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid project_id", data: nil)
        }
        guard let folderPath = rawString(params, "folder_path")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !folderPath.isEmpty else {
            return .err(code: "invalid_params", message: "Missing or empty folder_path", data: nil)
        }

        do {
            try ProjectStore.shared.updateFolder(id: projectId, newPath: folderPath)
            let store = ProjectStore.shared
            if let project = store.project(id: projectId) {
                return .ok(projectSummaryPayload(
                    project: project,
                    active: store.activeProjectId == projectId,
                    open: store.openProjectIds.contains(projectId)
                ))
            } else {
                return .err(code: "not_found", message: "Project not found", data: nil)
            }
        } catch let error as ProjectStoreError {
            return projectStoreErrorToV2(error)
        } catch {
            return .err(code: "internal_error", message: error.localizedDescription, data: nil)
        }
    }

    private static func projectDelete(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let projectId = uuid(params, "project_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid project_id", data: nil)
        }
        let reassignWorkspaces = (params["reassign_workspaces"] as? Bool) ?? true

        let store = ProjectStore.shared
        guard store.project(id: projectId) != nil else {
            return .err(code: "not_found", message: "Project not found", data: nil)
        }
        let workspacesAffected = AppDelegate.shared?.workspaceCount(forProjectId: projectId) ?? 0
        do {
            try store.delete(id: projectId)
            if reassignWorkspaces, let fallbackId = store.fallbackProjectId, workspacesAffected > 0 {
                AppDelegate.shared?.reassignWorkspaces(
                    fromProjectId: projectId,
                    toProjectId: fallbackId
                )
            }
            return .ok([
                "project_id": projectId.uuidString,
                "workspaces_affected": workspacesAffected,
                "workspaces_reassigned": reassignWorkspaces ? workspacesAffected : 0
            ])
        } catch let error as ProjectStoreError {
            return projectStoreErrorToV2(error)
        } catch {
            return .err(code: "internal_error", message: error.localizedDescription, data: nil)
        }
    }

    private static func projectSwitch(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let projectId = uuid(params, "project_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid project_id", data: nil)
        }
        do {
            try ProjectStore.shared.setActive(id: projectId)
            let store = ProjectStore.shared
            if let project = store.project(id: projectId) {
                return .ok(projectSummaryPayload(project: project, active: true, open: true))
            } else {
                return .err(code: "not_found", message: "Project not found", data: nil)
            }
        } catch let error as ProjectStoreError {
            return projectStoreErrorToV2(error)
        } catch {
            return .err(code: "internal_error", message: error.localizedDescription, data: nil)
        }
    }

    // MARK: - Payload helpers

    /// Produces the summary dict returned by every `project.*` method.
    /// Public because `TerminalController+TermLoop.workspaceSummaryFields`
    /// consumes the same shape for workspace summaries.
    static func projectSummaryPayload(project: Project, active: Bool, open: Bool) -> [String: Any] {
        [
            "id": project.id.uuidString,
            "name": project.name,
            "folder_path": project.folderPath,
            "created_at": project.createdAt.timeIntervalSince1970,
            "active": active,
            "open": open
        ]
    }

    private static func projectStoreErrorToV2(_ error: ProjectStoreError) -> TerminalController.V2CallResult {
        let code: String
        switch error {
        case .invalidName: code = "invalid_params"
        case .duplicateName: code = "duplicate"
        case .folderNotFound, .folderNotDirectory: code = "invalid_folder"
        case .notFound: code = "not_found"
        case .cannotDeleteLast: code = "cannot_delete_last"
        }
        return .err(code: code, message: error.errorDescription ?? "Project error", data: nil)
    }

    // MARK: - Param helpers (fork-local mirrors of TerminalController's
    // private v2 helpers so we stay decoupled from upstream visibility)

    static func rawString(_ params: [String: Any], _ key: String) -> String? {
        params[key] as? String
    }

    private static func uuid(_ params: [String: Any], _ key: String) -> UUID? {
        guard let s = nonEmptyString(params, key) else { return nil }
        return UUID(uuidString: s)
    }

    private static func nonEmptyString(_ params: [String: Any], _ key: String) -> String? {
        guard let s = rawString(params, key)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty else { return nil }
        return s
    }

    private static func orNull(_ value: Any?) -> Any {
        if let value { return value }
        return NSNull()
    }

    private static func isSafeSessionId(_ value: String) -> Bool {
        TermLoopShell.isSafeUnquotedIdentifier(value)
    }

    // MARK: - Workspace claude-session commands

    private static func workspaceReportClaudeSession(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let workspaceIdStr = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !workspaceIdStr.isEmpty else {
            return .err(code: "invalid_params", message: "Missing workspace_id", data: nil)
        }
        guard let sessionId = rawString(params, "session_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !sessionId.isEmpty else {
            return .err(code: "invalid_params", message: "Missing session_id", data: nil)
        }
        guard isSafeSessionId(sessionId) else {
            return .err(code: "invalid_params",
                        message: "session_id may only contain letters, digits, '-', '_'",
                        data: nil)
        }
        let cwd: String? = (params["cwd"] as? String).flatMap {
            let t = $0.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        let pid: pid_t? = {
            if let n = params["pid"] as? Int, n > 0 { return pid_t(n) }
            if let n = params["pid"] as? Int32, n > 0 { return n }
            return nil
        }()
        guard let workspaceId = UUID(uuidString: workspaceIdStr) else {
            return .err(code: "invalid_params", message: "Invalid workspace_id", data: nil)
        }
        // Liveness gate: drop late hook callbacks for workspaces that have
        // been closed in the UI. The earlier metadata-existence check was
        // too lax — `workspaceDidClose` clears the agent session but leaves
        // the metadata row in place for restore, so a stale agent could
        // still resurrect the ephemeral session and reverse-index entry.
        // `workspaceFor(tabId:)` is the canonical "is this workspace
        // currently open" check (used by every other socket handler that
        // touches workspace state).
        //
        // TODO(io-hardening): per-launch nonce so a stale agent that re-uses
        // a recycled workspace id can't impersonate the new launch.
        guard AppDelegate.shared?.workspaceFor(tabId: workspaceId) != nil else {
            return .ok([
                "workspace_id": workspaceIdStr,
                "session_id": sessionId,
                "cwd": orNull(cwd),
                "pid": pid.map { Int($0) as Any } ?? NSNull(),
                "ignored": true,
                "reason": "workspace_not_live"
            ])
        }
        guard let acceptedSessionId = WorkspaceMetadataStore.shared.acceptedObservedSessionId(
            agentId: TerminalAgent.claudeId,
            sessionId: sessionId,
            forWorkspaceId: workspaceId
        ) else {
            return .ok([
                "workspace_id": workspaceIdStr,
                "session_id": sessionId,
                "cwd": orNull(cwd),
                "pid": pid.map { Int($0) as Any } ?? NSNull(),
                "ignored": true
            ])
        }
        WorkspaceMetadataStore.shared.setClaudeSession(
            workspaceId: workspaceIdStr,
            sessionId: acceptedSessionId,
            cwd: cwd,
            pid: pid
        )
        let didUpdate = WorkspaceMetadataStore.shared.setPersistedAgentSession(
            agentId: TerminalAgent.claudeId,
            sessionId: acceptedSessionId,
            cwd: cwd,
            for: workspaceId
        )
        if didUpdate {
            TermLoopHooks.saveCriticalAgentRestoreStateSync()
        }
        return .ok([
            "workspace_id": workspaceIdStr,
            "session_id": acceptedSessionId,
            "cwd": orNull(cwd),
            "pid": pid.map { Int($0) as Any } ?? NSNull()
        ])
    }

    private static func workspaceClearClaudeSession(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let workspaceIdStr = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !workspaceIdStr.isEmpty else {
            return .err(code: "invalid_params", message: "Missing workspace_id", data: nil)
        }
        WorkspaceMetadataStore.shared.clearClaudeSession(workspaceId: workspaceIdStr)
        if let workspaceId = UUID(uuidString: workspaceIdStr),
           WorkspaceMetadataStore.shared.clearPersistedAgentSession(for: workspaceId) {
            TermLoopHooks.saveCriticalAgentRestoreStateSync()
        }
        return .ok(["workspace_id": workspaceIdStr])
    }

    // MARK: - Teleport: kill claude session on Mac

    /// SIGTERM the Mac-side claude process associated with a workspace. Used by
    /// the mobile teleport flow before opening an SSH `claude --resume` shell.
    /// Returns synchronously after the signal is sent; an async background task
    /// escalates to SIGKILL if the process hasn't exited after 2 seconds.
    private static func workspaceKillClaudeSession(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let workspaceIdStr = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !workspaceIdStr.isEmpty else {
            return .err(code: "invalid_params", message: "Missing workspace_id", data: nil)
        }
        guard let session = WorkspaceMetadataStore.shared.claudeSession(workspaceId: workspaceIdStr) else {
            return .ok(["killed": false, "reason": "no_session"])
        }
        guard let pid = session.pid, pid > 0 else {
            return .ok(["killed": false, "reason": "no_pid"])
        }
        let force = (params["force"] as? Bool) == true

        if !force,
           let wsUUID = UUID(uuidString: workspaceIdStr),
           let workspace = AppDelegate.shared?.workspaceFor(tabId: wsUUID),
           {
               return TerminalAgentActivityStore.shared.isAgentRunning(forWorkspace: workspace, agentId: "claude")
           }() {
            return .err(
                code: "not_idle",
                message: "claude_running is true — wait for turn to finish",
                data: nil
            )
        }

        _ = Darwin.kill(pid, SIGTERM)

        // Escalate to SIGKILL off-main after 2s if still alive.
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2.0) {
            if Darwin.kill(pid, 0) == 0 {
                _ = Darwin.kill(pid, SIGKILL)
            }
        }

        return .ok([
            "killed": true,
            "pid": Int(pid),
            "session_id": session.sessionId
        ])
    }

    // MARK: - Teleport: spawn claude session on Mac

    private static func workspacePrepareClaudeResume(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let workspaceIdStr = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !workspaceIdStr.isEmpty,
            let wsUUID = UUID(uuidString: workspaceIdStr) else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }
        guard let sessionId = rawString(params, "session_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !sessionId.isEmpty else {
            return .err(code: "invalid_params", message: "Missing session_id", data: nil)
        }
        guard isSafeSessionId(sessionId) else {
            return .err(code: "invalid_params",
                        message: "session_id may only contain letters, digits, '-', '_'",
                        data: nil)
        }

        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: wsUUID) else {
            return .err(code: "not_found", message: "Workspace not found", data: nil)
        }

        let requestedCwd = nonEmptyString(params, "cwd")
        let sourceCwd = nonEmptyString(params, "source_cwd")
        let preparation = prepareClaudeResumeContext(
            workspace: workspace,
            sessionId: sessionId,
            requestedCwd: requestedCwd,
            preferredSourceCwd: sourceCwd
        )
        return .ok([
            "prepared": preparation.prepared,
            "workspace_id": workspaceIdStr,
            "session_id": sessionId,
            "cwd": orNull(preparation.targetCwd),
            "reason": preparation.prepared ? NSNull() : "session_file_missing"
        ])
    }

    private static func workspaceAgentSystemPrompt(
        _ params: [String: Any],
        defaultAgentId: String
    ) -> TerminalController.V2CallResult {
        guard let wsUUID = uuid(params, "workspace_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }
        let agentId = nonEmptyString(params, "agent_id") ?? defaultAgentId
        let explicitCwd = nonEmptyString(params, "cwd")
        let resolvedCwd: String? = {
            if let explicitCwd { return explicitCwd }
            guard let workspace = AppDelegate.shared?.workspaceFor(tabId: wsUUID) else {
                return nil
            }
            return (try? workspace.termLoopSpawnCwd())
        }()
        let request = AgentInvocationRequest(
            agentId: agentId,
            workspaceId: wsUUID,
            runCwd: resolvedCwd.map { URL(fileURLWithPath: $0) },
            source: .socket
        )
        guard let plan = try? AgentInvocationComposer.compose(request) else {
            return .ok([
                "workspace_id": wsUUID.uuidString,
                "cwd": orNull(resolvedCwd),
                "append_system_prompt": NSNull(),
                "user_system_prompt": NSNull(),
                "resolved_system_instructions": NSNull(),
                "delivered_system_instructions": NSNull(),
                "delivery_mode": "none",
                "extra_argv": [],
                "prompt_prefix": NSNull(),
                "initial_prompt": NSNull(),
                "preview": [:] as [String: Any]
            ])
        }
        ProjectSkillMaterializer.materializeForLaunch(plan)
        let transport = (try? AgentInvocationTransportAdapter.resolve(plan))
        // `Resources/bin/claude` wrapper script ships this string via a
        // second `--append-system-prompt` flag at run time; the runner's
        // flag carries only the user override. Both reach the agent.
        let appendBlock = AgentInvocationComposer.joinSystemInstructions(
            plan.instructions.composedAppendSystemPrompt,
            plan.reportedContextBlock
        )
        return .ok([
            "workspace_id": wsUUID.uuidString,
            "cwd": orNull(resolvedCwd),
            "append_system_prompt": orNull(appendBlock),
            "user_system_prompt": orNull(plan.resolvedUserSystemPrompt),
            "resolved_system_instructions": orNull(plan.resolvedSystemInstructions),
            "delivered_system_instructions": orNull(transport?.deliveredSystemInstructions),
            "delivery_mode": transport?.deliveryMode.rawValue ?? "none",
            "extra_argv": transport?.extraArgv ?? [],
            "prompt_prefix": orNull(transport?.promptPrefix),
            "initial_prompt": orNull(transport?.initialPrompt),
            "preview": [
                "title": plan.previewSummary.title,
                "snippet": orNull(plan.previewSummary.snippet),
                "injected_abilities": plan.previewSummary.injectedAbilityNames,
                "listed_abilities": plan.previewSummary.listedAbilityNames,
                "referenced_skills": plan.previewSummary.referencedSkillNames
            ]
        ])
    }

    /// Types `claude --resume <sid>` into the workspace's focused terminal
    /// surface so the Mac can take over an iOS-owned session. Returns
    /// synchronously after the keystrokes are queued; the mobile client polls
    /// `workspace.list` for session-start hook confirmation.
    private static func workspaceSpawnClaudeSession(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let workspaceIdStr = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !workspaceIdStr.isEmpty,
            let wsUUID = UUID(uuidString: workspaceIdStr) else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }
        guard let sessionId = rawString(params, "session_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !sessionId.isEmpty else {
            return .err(code: "invalid_params", message: "Missing session_id", data: nil)
        }
        guard isSafeSessionId(sessionId) else {
            return .err(code: "invalid_params",
                        message: "session_id may only contain letters, digits, '-', '_'",
                        data: nil)
        }
        let cwd = nonEmptyString(params, "cwd")

        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: wsUUID) else {
            return .err(code: "not_found", message: "Workspace not found", data: nil)
        }
        guard let surfaceId = workspace.focusedPanelId,
              let terminalPanel = workspace.terminalPanel(for: surfaceId) else {
            return .err(code: "not_found", message: "No focused terminal surface", data: nil)
        }

        let preparation = prepareClaudeResumeContext(
            workspace: workspace,
            sessionId: sessionId,
            requestedCwd: cwd,
            preferredSourceCwd: nil
        )
        if let errorMessage = preparation.errorMessage {
            return .err(code: "invalid_params", message: errorMessage, data: nil)
        }
        let runCwd = preparation.targetCwd
        UserScopeHookSync.ensureInstalled(for: .claude)
        if let runCwd, !runCwd.isEmpty {
            UserScopeHookSync.cleanupProjectScope(
                at: URL(fileURLWithPath: runCwd, isDirectory: true),
                for: .claude
            )
        }
        let command = ClaudeResumeCommandBuilder.buildCommand(
            sessionId: sessionId,
            env: ["TERMLOOP_WORKSPACE_ID": workspaceIdStr]
                .merging(preparation.worktreeExpectation?.environment ?? [:]) { _, new in new },
            projectFolderPath: ProjectInstructionStore.resolvedProjectFolderPath(
                for: workspace,
                runCwd: runCwd
            ),
            runCwd: runCwd,
            cdIntoRunCwd: runCwd != nil
        ) + "\n"

        terminalPanel.sendText(command)

        return .ok([
            "spawned": true,
            "workspace_id": workspaceIdStr,
            "session_id": sessionId,
            "surface_id": surfaceId.uuidString,
            "resume_prepared": preparation.prepared
        ])
    }

    private struct ClaudeResumePreparation {
        let targetCwd: String?
        let prepared: Bool
        let errorMessage: String?
        let worktreeExpectation: TermLoopWorktreeExpectation?
    }

    private static func prepareClaudeResumeContext(
        workspace: Workspace,
        sessionId: String,
        requestedCwd: String?,
        preferredSourceCwd: String?
    ) -> ClaudeResumePreparation {
        let worktreeExpectation = try? workspace.termLoopWorktreeExpectation()
        let targetCwd: String?
        if let worktreeExpectation {
            if let requestedCwd {
                let requested = URL(fileURLWithPath: requestedCwd).standardizedFileURL.path
                let expected = URL(fileURLWithPath: worktreeExpectation.path).standardizedFileURL.path
                guard requested == expected else {
                    return ClaudeResumePreparation(
                        targetCwd: nil,
                        prepared: false,
                        errorMessage: "Requested cwd does not match attached worktree: \(worktreeExpectation.path)",
                        worktreeExpectation: worktreeExpectation
                    )
                }
            }
            targetCwd = worktreeExpectation.path
        } else {
            targetCwd = requestedCwd ?? (try? workspace.termLoopSpawnCwd())
        }
        guard let targetCwd else {
            return ClaudeResumePreparation(
                targetCwd: nil,
                prepared: false,
                errorMessage: nil,
                worktreeExpectation: worktreeExpectation
            )
        }
        let projectFolderPath = ProjectInstructionStore.resolvedProjectFolderPath(
            for: workspace,
            runCwd: targetCwd
        )
        let sourceCwds = claudeResumeSourceCwds(
            workspace: workspace,
            projectFolderPath: projectFolderPath,
            preferredSourceCwd: preferredSourceCwd
        )
        let prepared = ClaudeProjectFiles.ensureSessionAvailable(
            sessionId: sessionId,
            targetCwd: targetCwd,
            sourceCwds: sourceCwds
        )
        return ClaudeResumePreparation(
            targetCwd: targetCwd,
            prepared: prepared,
            errorMessage: nil,
            worktreeExpectation: worktreeExpectation
        )
    }

    private static func claudeResumeSourceCwds(
        workspace: Workspace,
        projectFolderPath: String?,
        preferredSourceCwd: String?
    ) -> [String] {
        let liveSession = WorkspaceMetadataStore.shared
            .claudeSession(workspaceId: workspace.id.uuidString)
        let normalizedProject = projectFolderPath.map {
            URL(fileURLWithPath: $0).standardizedFileURL.path
        }
        let rawCandidates =
            [preferredSourceCwd, liveSession?.cwd]
            + workspace.panelDirectories.values.map(Optional.some)
            + [projectFolderPath]

        var seen = Set<String>()
        var out: [String] = []
        for raw in rawCandidates {
            guard let raw,
                  case let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines),
                  !trimmed.isEmpty else { continue }
            let normalized = URL(fileURLWithPath: trimmed).standardizedFileURL.path
            guard seen.insert(normalized).inserted else { continue }
            if let normalizedProject {
                let insideProject = normalized == normalizedProject
                    || normalized.hasPrefix(normalizedProject + "/")
                guard insideProject else { continue }
            }
            out.append(normalized)
        }
        return out
    }

    // MARK: - Worktree commands

    private static func worktreeList(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let explicitProjectRequested = uuid(params, "project_id") != nil
        let scopedProjects: [Project]
        if let pid = uuid(params, "project_id") {
            guard let project = ProjectStore.shared.project(id: pid) else {
                return .err(code: "not_found", message: "Project not found", data: nil)
            }
            scopedProjects = [project]
        } else {
            scopedProjects = ProjectStore.shared.projects
        }
        let includeDirty = (params["include_dirty"] as? Bool) == true

        var payload: [[String: Any]] = []
        // When iterating every project (no `project_id` filter), we can't
        // let one broken folder (not a repo, permission denied, disk
        // ejected) wipe out the whole response — the sidebar and the
        // mobile view would render empty for all the healthy projects.
        // Collect per-project errors instead and surface them alongside
        // the data. Explicit single-project queries still fail loudly.
        var perProjectErrors: [[String: Any]] = []
        let svc = GitWorktreeService()
        for project in scopedProjects {
            let entries: [GitWorktreeService.ListEntry]
            do {
                entries = try svc.list(in: project.folderPath)
            } catch let error as WorktreeError {
                if explicitProjectRequested {
                    return worktreeErrorToV2(error)
                }
                perProjectErrors.append([
                    "project_id": project.id.uuidString,
                    "code": error.code,
                    "message": error.errorDescription ?? "\(error)"
                ])
                continue
            } catch {
                if explicitProjectRequested {
                    return .err(code: "git_command_failed", message: "\(error)", data: nil)
                }
                perProjectErrors.append([
                    "project_id": project.id.uuidString,
                    "code": "git_command_failed",
                    "message": "\(error)"
                ])
                continue
            }
            for entry in entries {
                let users: [String] = entry.branch.map { b in
                    WorkspaceMetadataStore.shared
                        .workspaceIds(withBranch: b, projectId: project.id)
                        .map(\.uuidString)
                } ?? []
                var row: [String: Any] = [
                    "branch": orNull(entry.branch),
                    "path": entry.path,
                    "project_id": project.id.uuidString,
                    "workspace_ids": users,
                    "is_main": entry.isMain,
                    "is_locked": entry.isLocked,
                    "is_prunable": entry.isPrunable
                ]
                if includeDirty {
                    row["is_dirty"] = (try? svc.isClean(worktreePath: entry.path)).map { !$0 } ?? NSNull()
                }
                payload.append(row)
            }
        }
        var response: [String: Any] = ["worktrees": payload]
        if !perProjectErrors.isEmpty {
            response["errors"] = perProjectErrors
        }
        return .ok(response)
    }

    private static func worktreeAttach(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let wsUUID = uuid(params, "workspace_id"),
              let workspace = AppDelegate.shared?.workspaceFor(tabId: wsUUID) else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }
        guard let branch = rawString(params, "branch")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !branch.isEmpty else {
            return .err(code: "invalid_params", message: "Missing branch", data: nil)
        }
        let baseRef = rawString(params, "base_ref")
        let create = params["create"] as? Bool
        let force = (params["force"] as? Bool) == true

        do {
            let result = try WorktreeCoordinator.shared.attach(
                workspace: workspace,
                branch: branch,
                baseRef: baseRef,
                createIfMissing: create,
                force: force
            )
            return .ok([
                "workspace_id": result.workspaceId.uuidString,
                "branch": result.branch,
                "path": result.path,
                "created_branch": result.createdBranch,
                "created_worktree": result.createdWorktree,
                "resolves_to_main": result.resolvesToMain,
                "migrated_agent": result.migratedAgent,
                "cd_idle_shells": result.cdIdleShells
            ])
        } catch let error as WorktreeError {
            return worktreeErrorToV2(error)
        } catch {
            return .err(code: "git_command_failed", message: "\(error)", data: nil)
        }
    }

    private static func worktreeDetach(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let wsUUID = uuid(params, "workspace_id"),
              let workspace = AppDelegate.shared?.workspaceFor(tabId: wsUUID) else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }
        let policyStr = (rawString(params, "prune") ?? "auto")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let policy = WorktreeCoordinator.PrunePolicy(rawValue: policyStr) else {
            return .err(code: "invalid_params",
                        message: "prune must be auto|keep|force", data: nil)
        }
        do {
            let result = try WorktreeCoordinator.shared.detach(
                workspace: workspace, prune: policy
            )
            return .ok([
                "workspace_id": result.workspaceId.uuidString,
                "previous_branch": orNull(result.previousBranch),
                "worktree_pruned": result.worktreePruned
            ])
        } catch let error as WorktreeError {
            return worktreeErrorToV2(error)
        } catch {
            return .err(code: "git_command_failed", message: "\(error)", data: nil)
        }
    }

    private static func worktreePrune(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let projectId = uuid(params, "project_id"),
              let project = ProjectStore.shared.project(id: projectId) else {
            return .err(code: "invalid_params", message: "Missing or invalid project_id", data: nil)
        }
        do {
            try GitWorktreeService().prune(folder: project.folderPath)
            return .ok(["removed": [], "skipped": []])
        } catch let error as WorktreeError {
            return worktreeErrorToV2(error)
        } catch {
            return .err(code: "git_command_failed", message: "\(error)", data: nil)
        }
    }

    private static func worktreeBranches(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let projectId = uuid(params, "project_id"),
              let project = ProjectStore.shared.project(id: projectId) else {
            return .err(code: "invalid_params", message: "Missing or invalid project_id", data: nil)
        }
        let query = rawString(params, "query")
        do {
            let entries = try GitWorktreeService()
                .branches(in: project.folderPath, query: query)
            let payload = entries.map { b -> [String: Any] in
                [
                    "name": b.name,
                    "is_current": b.isCurrent,
                    "is_checked_out_in": orNull(b.checkedOutPath),
                    "last_commit_at": orNull(b.lastCommitAt?.timeIntervalSince1970)
                ]
            }
            return .ok(["branches": payload])
        } catch let error as WorktreeError {
            return worktreeErrorToV2(error)
        } catch {
            return .err(code: "git_command_failed", message: "\(error)", data: nil)
        }
    }

    private static func worktreeErrorToV2(_ error: WorktreeError) -> TerminalController.V2CallResult {
        let message = error.errorDescription ?? "\(error)"
        if case let .agentMidTurn(wsId, sessionId) = error {
            return .err(
                code: error.code, message: message,
                data: ["workspace_id": wsId, "session_id": sessionId]
            )
        }
        return .err(code: error.code, message: message, data: nil)
    }

    // MARK: - Terminal agent lifecycle

    private static func listTerminalAgents(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let agents = TerminalAgentRegistry.shared.agents.map { a -> [String: Any] in
            [
                "id": a.id,
                "display_name": a.displayName,
                "icon": a.icon,
                "executable_name": a.executableName,
                "argv": a.argv
            ]
        }
        return .ok(["agents": agents])
    }

    private static func listWorkspacePanes(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let wsId = uuid(params, "workspace_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }
        guard let ws = AppDelegate.shared?.workspaceFor(tabId: wsId) else {
            return .err(code: "not_found", message: "workspace not attached", data: nil)
        }
        let panes: [[String: Any]] = ws.panels.values.map { panel in
            [
                "pane_id": panel.id.uuidString,
                "type": panel.panelType.rawValue
            ]
        }
        return .ok([
            "workspace_id": wsId.uuidString,
            "panes": panes
        ])
    }

    // MARK: - Event subscriptions

    /// Subscribe the current client socket to a filtered stream of EventBus
    /// events. Params:
    ///   `types`         – optional [String]  — filter by event type
    ///   `workspace_ids` – optional [String]  — filter by workspace UUID
    ///
    /// Returns `{"subscription_id": "<uuid>"}`.
    /// Works on both TCP and Unix sockets (TCP clients subscribe for push
    /// notifications over the long-lived connection).
    private static func eventsSubscribe(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let socket = TermLoopTCPBridge.currentSocketFd()

        let typeStrings  = params["types"] as? [String]
        let wsIdStrings  = params["workspace_ids"] as? [String]
        let workspaceIds: [UUID]? = wsIdStrings.map { list in list.compactMap(UUID.init(uuidString:)) }

        // Route through the tracker rather than EventBus.shared.subscribe
        // directly so the closure captures the subscription token instead of
        // the raw fd. After the connection is torn down the tracker drops
        // the token, the closure resolves to nil, and a publish that races
        // disconnect can't write to a recycled descriptor.
        let id = TermLoopSubscriptionTracker.shared.subscribePushFrames(
            types: typeStrings,
            workspaceIds: workspaceIds,
            socket: socket
        ) { event, fd in
            writeEventFrame(event, to: fd)
        }
        return .ok(["subscription_id": id.uuidString])
    }

    /// Unsubscribe from an event subscription.
    ///   `subscription_id` – optional String. When omitted, disposes ALL
    ///                        subscriptions for the current socket.
    private static func eventsUnsubscribe(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let socket = TermLoopTCPBridge.currentSocketFd()

        if let idStr = rawString(params, "subscription_id"),
           !idStr.isEmpty,
           let uuid = UUID(uuidString: idStr) {
            TermLoopSubscriptionTracker.shared.unsubscribeOne(id: uuid, socket: socket)
            return .ok(["subscription_id": idStr, "unsubscribed": true])
        } else {
            // Connection stays open; only drop subscriptions. Calling the
            // full disposeConnection here would retire TermLoopSocketIO
            // bookkeeping for a still-live fd and break subsequent
            // response writes on the same connection.
            TermLoopSubscriptionTracker.shared.unsubscribeAll(for: socket)
            return .ok(["unsubscribed": true, "all": true])
        }
    }

    /// Build an NDJSON push frame and write it directly to `socket`.
    ///
    /// Frame shape:
    /// ```json
    /// {"event": "<type>", "data": {"workspace_id": "<uuid>", ...payload}}
    /// ```
    ///
    /// Routed through `TermLoopSocketIO.writeFrame` so the write is
    /// SIGPIPE-safe, partial-write tolerant, and serialized with the
    /// keepalive ping on the same fd.
    static func writeEventFrame(_ event: EventBus.Event, to socket: Int32) {
        guard socket >= 0 else { return }
        var data: [String: Any] = ["workspace_id": event.workspaceId.uuidString]
        for (k, v) in event.payload { data[k] = v }
        let frame: [String: Any] = ["event": event.type, "data": data]
        guard let bytes = try? JSONSerialization.data(withJSONObject: frame, options: []) else { return }
        var payload = bytes
        payload.append(UInt8(ascii: "\n"))
        TermLoopSocketIO.writeFrame(socket, bytes: payload)
    }

    /// Pass an empty `terminal_agent_id` to clear the project override
    /// and fall back to the global default.
    private static func setProjectDefaultAgent(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let projectId = uuid(params, "project_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid project_id", data: nil)
        }
        guard let raw = rawString(params, "terminal_agent_id") else {
            return .err(code: "invalid_params", message: "Missing terminal_agent_id", data: nil)
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolved: String?
        if trimmed.isEmpty {
            resolved = nil
        } else if TerminalAgentRegistry.shared.agent(id: trimmed) != nil {
            resolved = trimmed
        } else {
            return .err(code: "invalid_params",
                        message: "Unknown terminal_agent_id: \(trimmed)",
                        data: ["terminal_agent_id": trimmed])
        }
        ProjectStore.shared.setDefaultTerminalAgent(resolved, project: projectId)
        return .ok([
            "project_id": projectId.uuidString,
            "terminal_agent_id": resolved as Any? ?? NSNull()
        ])
    }

    // MARK: - Push notification registration

    private static func pushRegister(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let token = rawString(params, "device_token"), !token.isEmpty else {
            return .err(code: "invalid_params", message: "device_token required", data: nil)
        }
        let platform = rawString(params, "platform") ?? "ios"
        let environment = rawString(params, "environment") ?? "development"
        PushTokenStore.shared.register(
            deviceToken: token,
            platform: platform,
            environment: environment
        )
        return .ok(["registered": true])
    }

    private static func pushUnregister(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let token = rawString(params, "device_token"), !token.isEmpty else {
            return .err(code: "invalid_params", message: "device_token required", data: nil)
        }
        PushTokenStore.shared.unregister(deviceToken: token)
        return .ok(["unregistered": true])
    }

    // MARK: - Bridge

    /// Programmatic Ask-To launcher for the `ask_to` MCP tool. Equivalent to
    /// the user clicking Start in `AskToSheet`: spawns a hidden helper
    /// workspace running the chosen target agent (codex/gemini/claude),
    /// creates an `.askAgent` bridge from the source workspace, and kicks
    /// off `message` as the helper's first user turn.
    private static func bridgeAskTo(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let sourceId: UUID
        switch resolveWorkspaceId(from: params) {
        case .found(let id, _):
            sourceId = id
        case .missing(let error):
            return error
        }
        guard let targetRaw = nonEmptyString(params, "target")?.lowercased(),
              let target = AskTargetAgent(rawValue: targetRaw) else {
            return .err(code: "invalid_params",
                        message: "Missing or invalid target (expected: codex, claude, gemini)",
                        data: nil)
        }
        guard let message = nonEmptyString(params, "message") else {
            return .err(code: "invalid_params", message: "Missing message", data: nil)
        }
        let targetPrompt = rawString(params, "target_prompt") ?? ""

        guard let tabManager = AppDelegate.shared?.tabManagerFor(tabId: sourceId)
                ?? AppDelegate.shared?.tabManager else {
            return .err(code: "unavailable", message: "TabManager not available", data: nil)
        }

        do {
            let outcome = try AskToBridgeLauncher.launch(
                sourceWorkspaceId: sourceId,
                target: target,
                sourcePrompt: message,
                targetPrompt: targetPrompt,
                // MCP caller already authored the question; send it
                // straight to the helper instead of bouncing off the
                // source agent (which would just see its own outgoing
                // message echoed back).
                firstSpeaker: .right,
                tabManager: tabManager
            )
            return .ok([
                "bridge_id": outcome.bridgeId.uuidString,
                "helper_workspace_id": outcome.helperWorkspaceId.uuidString,
                "target": target.agentId
            ])
        } catch AskToBridgeLauncher.LaunchError.sourceWorkspaceNotFound {
            return .err(code: "not_found",
                        message: "Source workspace not found", data: nil)
        } catch AskToBridgeLauncher.LaunchError.targetNotSupported {
            return .err(code: "invalid_params",
                        message: "Target agent is not runtime-supported", data: nil)
        } catch AskToBridgeLauncher.LaunchError.targetAgentNotInCatalog {
            return .err(code: "invalid_params",
                        message: "Target agent not registered in AgentCatalogStore",
                        data: nil)
        } catch AskToBridgeLauncher.LaunchError.bridgeRejected {
            return .err(code: "conflict",
                        message: "Bridge rejected (workspace already in another bridge)",
                        data: nil)
        } catch AskToBridgeLauncher.LaunchError.helperLaunchFailed(let underlying) {
            return .err(code: "internal_error",
                        message: "Helper launch failed: \(underlying.localizedDescription)",
                        data: nil)
        } catch {
            return .err(code: "internal_error",
                        message: error.localizedDescription, data: nil)
        }
    }
}

/// Minimal credential store for QR/mobile pairing.
///
/// Pairing tokens are intentionally short-lived and memory-only. Claimed mobile
/// devices get a persistent opaque access token whose SHA-256 hash is stored
/// under Application Support alongside the socket password file.
enum TermLoopMobilePairingStore {
    private struct PairingSession {
        let id: String
        let token: String
        let serverName: String?
        let createdAt: TimeInterval
        let expiresAt: TimeInterval
    }

    private struct DeviceRecord: Codable {
        let deviceId: String
        var deviceName: String
        let tokenHash: String
        let createdAt: TimeInterval
        var lastSeenAt: TimeInterval?
        var revokedAt: TimeInterval?
    }

    private struct DeviceFile: Codable {
        var version: Int
        var devices: [DeviceRecord]
    }

    private static let lock = NSLock()
    private static var pairings: [String: PairingSession] = [:]
    private static var cachedDevices: [DeviceRecord]?
    private static let defaultPairingTTL: TimeInterval = 120
    private static let maxPairingTTL: TimeInterval = 600
    private static let minPairingTTL: TimeInterval = 30

    static func createPairing(params: [String: Any]) -> TerminalController.V2CallResult {
        let ttlSeconds = sanitizedTTL(params["ttl_seconds"])
        let now = Date().timeIntervalSince1970
        let session = PairingSession(
            id: UUID().uuidString,
            token: randomToken(),
            serverName: nonEmptyString(params["server_name"]),
            createdAt: now,
            expiresAt: now + ttlSeconds
        )

        lock.lock()
        pruneExpiredPairingsLocked(now: now)
        pairings[session.token] = session
        lock.unlock()

        var result: [String: Any] = [
            "pairing_id": session.id,
            "token": session.token,
            "expires_at": session.expiresAt,
            "ttl_seconds": Int(ttlSeconds),
            "port": SocketControlSettings.resolvedTcpPort() as Any? ?? NSNull()
        ]
        result["server_name"] = session.serverName as Any? ?? NSNull()
        return .ok(result)
    }

    static func claim(params: [String: Any]) -> TerminalController.V2CallResult {
        guard let token = nonEmptyString(params["token"]) else {
            return .err(code: "invalid_params", message: "pairing.claim requires token", data: nil)
        }
        let deviceName = nonEmptyString(params["device_name"]) ?? "Mobile device"
        let now = Date().timeIntervalSince1970

        lock.lock()
        pruneExpiredPairingsLocked(now: now)
        guard let session = pairings.removeValue(forKey: token) else {
            lock.unlock()
            return .err(code: "pairing_invalid", message: "Pairing token is invalid or expired", data: nil)
        }
        let accessToken = randomToken()
        let record = DeviceRecord(
            deviceId: UUID().uuidString,
            deviceName: deviceName,
            tokenHash: tokenHash(accessToken),
            createdAt: now,
            lastSeenAt: now,
            revokedAt: nil
        )
        var devices = loadDevicesLocked()
        devices.append(record)
        let saved = saveDevicesLocked(devices)
        lock.unlock()

        guard saved else {
            return .err(code: "internal_error", message: "Failed to save paired mobile device", data: nil)
        }

        return .ok([
            "authenticated": true,
            "device_id": record.deviceId,
            "device_name": record.deviceName,
            "access_token": accessToken,
            "server_name": session.serverName as Any? ?? NSNull(),
            "capabilities": mobileCapabilities()
        ])
    }

    static func authenticate(params: [String: Any]) -> TerminalController.V2CallResult {
        guard let deviceId = nonEmptyString(params["device_id"]) else {
            return .err(code: "invalid_params", message: "auth.token requires device_id", data: nil)
        }
        guard let accessToken = nonEmptyString(params["access_token"]) else {
            return .err(code: "invalid_params", message: "auth.token requires access_token", data: nil)
        }

        let now = Date().timeIntervalSince1970
        lock.lock()
        var devices = loadDevicesLocked()
        guard let index = devices.firstIndex(where: { $0.deviceId == deviceId }) else {
            lock.unlock()
            return .err(code: "auth_failed", message: "Unknown mobile device", data: nil)
        }
        guard devices[index].revokedAt == nil,
              devices[index].tokenHash == tokenHash(accessToken) else {
            lock.unlock()
            return .err(code: "auth_failed", message: "Invalid mobile access token", data: nil)
        }
        devices[index].lastSeenAt = now
        let record = devices[index]
        _ = saveDevicesLocked(devices)
        lock.unlock()

        return .ok([
            "authenticated": true,
            "device_id": record.deviceId,
            "device_name": record.deviceName,
            "capabilities": mobileCapabilities()
        ])
    }

    static func listDevices() -> TerminalController.V2CallResult {
        lock.lock()
        let devices = loadDevicesLocked()
        lock.unlock()
        return .ok([
            "devices": devices.map(devicePayload)
        ])
    }

    static func revokeDevice(params: [String: Any]) -> TerminalController.V2CallResult {
        guard let deviceId = nonEmptyString(params["device_id"]) else {
            return .err(code: "invalid_params", message: "pairing.revoke_device requires device_id", data: nil)
        }
        let now = Date().timeIntervalSince1970
        lock.lock()
        var devices = loadDevicesLocked()
        guard let index = devices.firstIndex(where: { $0.deviceId == deviceId }) else {
            lock.unlock()
            return .err(code: "not_found", message: "Mobile device not found", data: nil)
        }
        devices[index].revokedAt = now
        let saved = saveDevicesLocked(devices)
        lock.unlock()
        guard saved else {
            return .err(code: "internal_error", message: "Failed to revoke mobile device", data: nil)
        }
        return .ok(["revoked": true, "device_id": deviceId])
    }

    private static func mobileCapabilities() -> [String] {
        [
            "system.ping",
            "project.list",
            "project.current",
            "project.switch",
            "workspace.list",
            "surface.list",
            "surface.read_text",
            "surface.send_text",
            "surface.send_key"
        ]
    }

    private static func devicePayload(_ record: DeviceRecord) -> [String: Any] {
        [
            "device_id": record.deviceId,
            "device_name": record.deviceName,
            "created_at": record.createdAt,
            "last_seen_at": record.lastSeenAt as Any? ?? NSNull(),
            "revoked_at": record.revokedAt as Any? ?? NSNull(),
            "revoked": record.revokedAt != nil
        ]
    }

    private static func sanitizedTTL(_ raw: Any?) -> TimeInterval {
        let parsed: TimeInterval?
        if let number = raw as? NSNumber {
            parsed = number.doubleValue
        } else if let string = raw as? String {
            parsed = Double(string.trimmingCharacters(in: .whitespacesAndNewlines))
        } else {
            parsed = nil
        }
        guard let parsed, parsed.isFinite, parsed > 0 else {
            return defaultPairingTTL
        }
        return min(max(parsed, minPairingTTL), maxPairingTTL)
    }

    private static func nonEmptyString(_ raw: Any?) -> String? {
        guard let string = raw as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func pruneExpiredPairingsLocked(now: TimeInterval) {
        pairings = pairings.filter { $0.value.expiresAt > now }
    }

    private static func loadDevicesLocked() -> [DeviceRecord] {
        if let cachedDevices {
            return cachedDevices
        }
        guard let url = devicesFileURL(),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(DeviceFile.self, from: data) else {
            cachedDevices = []
            return []
        }
        cachedDevices = decoded.devices
        return decoded.devices
    }

    @discardableResult
    private static func saveDevicesLocked(_ devices: [DeviceRecord]) -> Bool {
        guard let url = devicesFileURL() else { return false }
        do {
            let directory = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            let payload = DeviceFile(version: 1, devices: devices)
            let data = try JSONEncoder().encode(payload)
            try data.write(to: url, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            cachedDevices = devices
            return true
        } catch {
            return false
        }
    }

    private static func devicesFileURL() -> URL? {
        SocketControlPasswordStore.defaultPasswordFileURL()?.deletingLastPathComponent()
            .appendingPathComponent("mobile-devices.json", isDirectory: false)
    }

    private static func tokenHash(_ token: String) -> String {
        let digest = SHA256.hash(data: Data(token.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
#if canImport(Security)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status == errSecSuccess {
            return base64URL(Data(bytes))
        }
#endif
        return "\(UUID().uuidString).\(UUID().uuidString)"
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
