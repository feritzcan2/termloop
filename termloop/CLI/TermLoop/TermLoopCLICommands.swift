// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Registry of TermLoop-owned CLI subcommands. The upstream `termloop` CLI dispatch
/// delegates to `handle(...)` via a single marker-wrapped hook line; when this
/// registry returns `true`, the subcommand has been handled and upstream should
/// not continue.
enum TermLoopCLICommands {
    static func handle(
        subcommand: String,
        commandArgs: [String],
        client: SocketClient,
        jsonOutput: Bool
    ) throws -> Bool {
        switch subcommand {
        case "list-projects":
            try listProjects(client: client, jsonOutput: jsonOutput)
        case "current-project":
            try currentProject(client: client, jsonOutput: jsonOutput)
        case "new-project":
            try newProject(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        case "rename-project":
            try renameProject(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        case "set-project-folder":
            try setProjectFolder(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        case "delete-project":
            try deleteProject(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        case "switch-project":
            try switchProject(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        case "install-claude-hooks":
            try ClaudeHookInstaller.install(jsonOutput: jsonOutput)
        case "check-claude-hooks":
            try ClaudeHookInstaller.check(jsonOutput: jsonOutput)
        case "agent-system-prompt":
            try agentSystemPrompt(
                commandArgs: commandArgs,
                client: client,
                defaultAgentId: "claude",
                socketMethod: "workspace.agent_system_prompt"
            )
        case "list-worktrees":
            try listWorktrees(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        case "attach-branch":
            try attachBranch(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        case "detach-branch":
            try detachBranch(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        case "prune-worktrees":
            try pruneWorktrees(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        case "list-branches":
            try listBranches(commandArgs: commandArgs, client: client, jsonOutput: jsonOutput)
        default:
            return false
        }
        return true
    }

    // MARK: - Worktree handlers

    private static func agentSystemPrompt(
        commandArgs: [String],
        client: SocketClient,
        defaultAgentId: String,
        socketMethod: String
    ) throws {
        guard let workspaceId = optionValue(commandArgs, name: "--workspace") else {
            throw CLIError(message: "agent-system-prompt requires --workspace")
        }
        let agentId = optionValue(commandArgs, name: "--agent") ?? defaultAgentId
        var params: [String: Any] = [
            "workspace_id": workspaceId,
            "agent_id": agentId
        ]
        if let cwd = optionValue(commandArgs, name: "--cwd") {
            params["cwd"] = resolvePath(cwd)
        }
        let payload = try client.sendV2(method: socketMethod, params: params)
        if let prompt = payload["append_system_prompt"] as? String,
           !prompt.isEmpty {
            print(prompt)
        }
    }

    private static func listWorktrees(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        var params: [String: Any] = [:]
        if let project = optionValue(commandArgs, name: "--project") {
            params["project_id"] = project
        }
        let payload = try client.sendV2(method: "worktree.list", params: params)
        if jsonOutput {
            print(jsonString(payload))
            return
        }
        let worktrees = payload["worktrees"] as? [[String: Any]] ?? []
        if worktrees.isEmpty { print("No worktrees"); return }
        for w in worktrees {
            let branch = (w["branch"] as? String) ?? "-"
            let path = (w["path"] as? String) ?? ""
            let isMain = (w["is_main"] as? Bool) == true
            let users = (w["workspace_ids"] as? [String])?.count ?? 0
            let prefix = isMain ? "* " : "  "
            print("\(prefix)\(branch)  \(path)  ws=\(users)")
        }
    }

    private static func attachBranch(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        guard let workspace = optionValue(commandArgs, name: "--workspace") else {
            throw CLIError(message: "attach-branch requires --workspace")
        }
        guard let branch = optionValue(commandArgs, name: "--branch") else {
            throw CLIError(message: "attach-branch requires --branch")
        }
        var params: [String: Any] = ["workspace_id": workspace, "branch": branch]
        if let base = optionValue(commandArgs, name: "--base") {
            params["base_ref"] = base
        }
        if commandArgs.contains("--create") {
            params["create"] = true
        }
        if commandArgs.contains("--force") {
            params["force"] = true
        }
        let payload = try client.sendV2(method: "worktree.attach", params: params)
        if jsonOutput {
            print(jsonString(payload))
        } else {
            let b = (payload["branch"] as? String) ?? ""
            let p = (payload["path"] as? String) ?? ""
            let created = (payload["created_worktree"] as? Bool) == true
            let main = (payload["resolves_to_main"] as? Bool) == true
            let migrated = (payload["migrated_agent"] as? Bool) == true
            let cdCount = (payload["cd_idle_shells"] as? Int) ?? 0
            print("attached \(b) -> \(p)"
                  + (created ? " (created)" : "")
                  + (main ? " (main checkout)" : "")
                  + (migrated ? " (agent migrated)" : "")
                  + (cdCount > 0 ? " (\(cdCount) shell cd'd)" : ""))
        }
    }

    private static func detachBranch(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        guard let workspace = optionValue(commandArgs, name: "--workspace") else {
            throw CLIError(message: "detach-branch requires --workspace")
        }
        let policy = optionValue(commandArgs, name: "--prune") ?? "auto"
        if policy == "force" && !commandArgs.contains("--yes") {
            throw CLIError(message: "--prune force requires --yes to confirm")
        }
        let payload = try client.sendV2(
            method: "worktree.detach",
            params: ["workspace_id": workspace, "prune": policy]
        )
        if jsonOutput {
            print(jsonString(payload))
        } else {
            let prev = (payload["previous_branch"] as? String) ?? "-"
            let pruned = (payload["worktree_pruned"] as? Bool) == true
            print("detached from \(prev)\(pruned ? " (worktree removed)" : "")")
        }
    }

    private static func pruneWorktrees(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        guard let project = optionValue(commandArgs, name: "--project") else {
            throw CLIError(message: "prune-worktrees requires --project")
        }
        var params: [String: Any] = ["project_id": project]
        if let branch = optionValue(commandArgs, name: "--branch") {
            params["branch"] = branch
        }
        let payload = try client.sendV2(method: "worktree.prune", params: params)
        if jsonOutput {
            print(jsonString(payload))
        } else {
            print("prune OK")
        }
    }

    private static func listBranches(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        guard let project = optionValue(commandArgs, name: "--project") else {
            throw CLIError(message: "list-branches requires --project")
        }
        var params: [String: Any] = ["project_id": project]
        if let query = optionValue(commandArgs, name: "--query") {
            params["query"] = query
        }
        let payload = try client.sendV2(method: "worktree.branches", params: params)
        if jsonOutput {
            print(jsonString(payload))
            return
        }
        let entries = payload["branches"] as? [[String: Any]] ?? []
        if entries.isEmpty { print("No branches"); return }
        for b in entries {
            let name = (b["name"] as? String) ?? ""
            let cur = (b["is_current"] as? Bool) == true
            let checkout = b["is_checked_out_in"] as? String
            let prefix = cur ? "* " : "  "
            let suffix = checkout.map { " [checked out: \($0)]" } ?? ""
            print("\(prefix)\(name)\(suffix)")
        }
    }

    // MARK: - Handlers

    private static func listProjects(client: SocketClient, jsonOutput: Bool) throws {
        let payload = try client.sendV2(method: "project.list")
        if jsonOutput {
            print(jsonString(payload))
        } else {
            let projects = payload["projects"] as? [[String: Any]] ?? []
            if projects.isEmpty {
                print("No projects")
            } else {
                for p in projects {
                    let active = (p["active"] as? Bool) == true
                    let id = (p["id"] as? String) ?? ""
                    let name = (p["name"] as? String) ?? ""
                    let path = (p["folder_path"] as? String) ?? ""
                    let prefix = active ? "* " : "  "
                    print("\(prefix)\(id)  \(name)  \(path)")
                }
            }
        }
    }

    private static func currentProject(client: SocketClient, jsonOutput: Bool) throws {
        let payload = try client.sendV2(method: "project.current")
        if jsonOutput {
            print(jsonString(payload))
        } else {
            let name = (payload["name"] as? String) ?? ""
            let path = (payload["folder_path"] as? String) ?? ""
            let id = (payload["id"] as? String) ?? ""
            print("\(id)  \(name)  \(path)")
        }
    }

    private static func newProject(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        guard let name = optionValue(commandArgs, name: "--name") else {
            throw CLIError(message: "new-project requires --name")
        }
        guard let folder = optionValue(commandArgs, name: "--folder") else {
            throw CLIError(message: "new-project requires --folder")
        }
        let params: [String: Any] = [
            "name": name,
            "folder_path": resolvePath(folder)
        ]
        let payload = try client.sendV2(method: "project.create", params: params)
        if jsonOutput {
            print(jsonString(payload))
        } else {
            print("OK \((payload["id"] as? String) ?? "")")
        }
    }

    private static func renameProject(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        guard let projectId = optionValue(commandArgs, name: "--project") else {
            throw CLIError(message: "rename-project requires --project")
        }
        guard let name = optionValue(commandArgs, name: "--name") else {
            throw CLIError(message: "rename-project requires --name")
        }
        let params: [String: Any] = ["project_id": projectId, "name": name]
        let payload = try client.sendV2(method: "project.rename", params: params)
        if jsonOutput { print(jsonString(payload)) } else { print("OK") }
    }

    private static func setProjectFolder(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        guard let projectId = optionValue(commandArgs, name: "--project") else {
            throw CLIError(message: "set-project-folder requires --project")
        }
        guard let folder = optionValue(commandArgs, name: "--folder") else {
            throw CLIError(message: "set-project-folder requires --folder")
        }
        let params: [String: Any] = [
            "project_id": projectId,
            "folder_path": resolvePath(folder)
        ]
        let payload = try client.sendV2(method: "project.update_folder", params: params)
        if jsonOutput { print(jsonString(payload)) } else { print("OK") }
    }

    private static func deleteProject(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        guard let projectId = optionValue(commandArgs, name: "--project") else {
            throw CLIError(message: "delete-project requires --project")
        }
        let reassign = !commandArgs.contains("--no-reassign")
        let params: [String: Any] = [
            "project_id": projectId,
            "reassign_workspaces": reassign
        ]
        let payload = try client.sendV2(method: "project.delete", params: params)
        if jsonOutput { print(jsonString(payload)) } else { print("OK") }
    }

    private static func switchProject(commandArgs: [String], client: SocketClient, jsonOutput: Bool) throws {
        guard let projectId = optionValue(commandArgs, name: "--project") else {
            throw CLIError(message: "switch-project requires --project")
        }
        let payload = try client.sendV2(method: "project.switch", params: ["project_id": projectId])
        if jsonOutput { print(jsonString(payload)) } else { print("OK") }
    }

    // MARK: - Claude hook side-channel

    /// Pushes the active Claude session (workspace + session id + cwd + pid) to
    /// the termloop app over the v2 socket. Invoked from the upstream `claude-hook
    /// session-start` dispatcher via a single marker-wrapped hook line. The pid
    /// is used later by `workspace.kill_claude_session` to SIGTERM the process
    /// during a mobile-originated teleport. Failures are swallowed so a
    /// transient socket error doesn't break the rest of the hook.
    static func reportClaudeSessionStart(
        workspaceId: String,
        sessionId: String,
        cwd: String?,
        pid: Int?,
        client: SocketClient
    ) {
        var params: [String: Any] = [
            "workspace_id": workspaceId,
            "session_id": sessionId
        ]
        if let cwd {
            params["cwd"] = cwd
        } else {
            params["cwd"] = NSNull()
        }
        if let pid, pid > 0 {
            params["pid"] = pid
        } else {
            params["pid"] = NSNull()
        }
        _ = try? client.sendV2(method: "workspace.report_claude_session", params: params)
    }

    /// CLI hook: tell termloop app to clear the workspace's active Claude session.
    /// Called from `cmux claude-hook session-end` once the local sessionStore
    /// has confirmed the session was the primary teardown path. Failure is
    /// swallowed because the rest of the hook (status/notification cleanup)
    /// already ran.
    static func clearClaudeSession(workspaceId: String, client: SocketClient) {
        _ = try? client.sendV2(
            method: "workspace.clear_claude_session",
            params: ["workspace_id": workspaceId]
        )
    }

    static func reportAgentActivity(
        workspaceId: String,
        agentId: String,
        phase: String,
        attentionKind: String? = nil,
        messagePreview: String? = nil,
        userPromptSubmitted: Bool = false,
        sessionId: String? = nil,
        cwd: String? = nil,
        pid: Int? = nil,
        source: String? = nil,
        client: SocketClient
    ) {
        var params: [String: Any] = [
            "workspace_id": workspaceId,
            "agent_id": agentId,
            "phase": phase
        ]
        params["attention_kind"] = attentionKind as Any? ?? NSNull()
        params["message_preview"] = messagePreview as Any? ?? NSNull()
        params["user_prompt_submitted"] = userPromptSubmitted
        params["session_id"] = sessionId as Any? ?? NSNull()
        params["cwd"] = cwd as Any? ?? NSNull()
        params["pid"] = (pid != nil && (pid ?? 0) > 0) ? pid! : NSNull()
        params["source"] = source as Any? ?? NSNull()
        _ = try? client.sendV2(method: "workspace.report_agent_activity", params: params)
    }

    static func clearAgentActivity(workspaceId: String, client: SocketClient) {
        _ = try? client.sendV2(
            method: "workspace.clear_agent_activity",
            params: ["workspace_id": workspaceId]
        )
    }

    // MARK: - Helpers (TermLoop-local duplicates so upstream can evolve independently)

    private static func optionValue(_ args: [String], name: String) -> String? {
        guard let idx = args.firstIndex(of: name), idx + 1 < args.count else { return nil }
        return args[idx + 1]
    }

    private static func resolvePath(_ path: String) -> String {
        let expanded = NSString(string: path).expandingTildeInPath
        if expanded.hasPrefix("/") { return expanded }
        let cwd = FileManager.default.currentDirectoryPath
        return (cwd as NSString).appendingPathComponent(expanded)
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object) else { return "{}" }
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted])) ?? Data()
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
