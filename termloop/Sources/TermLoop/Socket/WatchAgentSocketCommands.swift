// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// `watch.*` socket methods. The Watch never speaks TCP directly — the
/// iPhone app bridges WatchConnectivity messages onto the TCP transport.
@MainActor
enum WatchAgentSocketCommands {
    static func launchAgent(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let prompt = TermLoopSocketCommands.nonEmptyString(params, "prompt") else {
            return .err(code: "invalid_params", message: "Missing prompt", data: nil)
        }

        let project: Project
        if let raw = TermLoopSocketCommands.nonEmptyString(params, "project_id") {
            guard let id = UUID(uuidString: raw),
                  let resolved = ProjectStore.shared.project(id: id) else {
                return .err(code: "not_found", message: "Project not found", data: nil)
            }
            project = resolved
        } else {
            guard let activeId = ProjectStore.shared.activeProjectId,
                  let resolved = ProjectStore.shared.project(id: activeId) else {
                return .err(code: "not_found", message: "No active project", data: nil)
            }
            project = resolved
        }

        guard let tabManager = AppDelegate.shared?.tabManager else {
            return .err(code: "unavailable", message: "TabManager not available", data: nil)
        }

        let resolvedAgentId = TerminalAgentLifecycle.resolveAgentId(
            explicit: nil,
            projectId: project.id
        )
        guard let agent = TerminalAgentRegistry.shared.agent(id: resolvedAgentId)
                ?? TerminalAgentRegistry.shared.agents.first else {
            return .err(code: "unavailable", message: "No terminal agents registered", data: nil)
        }

        let service = GitWorktreeService()
        let branchAndPath = mintBranchAvoidingCollision(
            project: project,
            service: service
        )
        guard let (branch, path) = branchAndPath else {
            return .err(code: "internal_error", message: "Worktree path resolution failed", data: nil)
        }

        do {
            try service.addCreatingBranch(
                folder: project.folderPath,
                path: path,
                branch: branch,
                baseRef: "HEAD"
            )
        } catch let error as WorktreeError {
            return TermLoopSocketCommands.worktreeErrorToV2(error)
        } catch {
            return .err(
                code: "git_command_failed",
                message: "\(error)",
                data: ["branch": branch, "path": path]
            )
        }

        let baselineHead = try? service.headRevision(worktreePath: path)

        let workspace: Workspace
        do {
            workspace = try TerminalAgentLifecycle.createFreshWorkspace(
                tabManager: tabManager,
                agent: agent,
                title: branch,
                cwd: path,
                worktreeExpectation: TermLoopWorktreeExpectation(path: path, branch: branch),
                baselineHead: baselineHead,
                initialPrompt: prompt,
                projectId: project.id
            )
        } catch {
            // `createFreshWorkspace` only throws before `addWorkspace`, so
            // there's no TabManager state to clean up — the failure leaves
            // git residue (the just-created worktree directory and the new
            // branch tip). `worktree remove --force` drops the worktree;
            // the dangling branch is harmless and deterministic to inspect
            // later (`watch/<timestamp>` with no commits beyond HEAD).
            try? service.remove(folder: project.folderPath, path: path, force: true)
            return .err(
                code: "internal_error",
                message: "Failed to launch agent: \(error)",
                data: ["branch": branch, "path": path]
            )
        }

        return .ok([
            "workspace_id": workspace.id.uuidString,
            "project_id": project.id.uuidString,
            "branch": branch,
            "path": path,
            "agent_id": agent.id
        ])
    }

    static func sendPrompt(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let wsId = TermLoopSocketCommands.uuid(params, "workspace_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }
        guard let text = TermLoopSocketCommands.nonEmptyString(params, "text") else {
            return .err(code: "invalid_params", message: "Missing text", data: nil)
        }
        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: wsId) else {
            return .err(code: "not_found", message: "Workspace not found", data: nil)
        }
        guard let surfaceId = workspace.focusedPanelId,
              let terminalPanel = workspace.terminalPanel(for: surfaceId) else {
            return .err(code: "not_found", message: "No focused terminal surface", data: nil)
        }
        terminalPanel.sendText(text + "\n")
        return .ok([
            "workspace_id": wsId.uuidString,
            "surface_id": surfaceId.uuidString,
            "delivered": true
        ])
    }

    private static let branchFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        return f
    }()

    /// Mint a `watch/<timestamp>[-N]` branch + canonical worktree path,
    /// stepping the suffix until we find a name that doesn't collide with
    /// `git worktree list` or the filesystem. Two rapid taps within the
    /// same second would otherwise share a branch name and have the
    /// second `addCreatingBranch` fail.
    private static func mintBranchAvoidingCollision(
        project: Project,
        service: GitWorktreeService
    ) -> (branch: String, path: String)? {
        let stamp = branchFormatter.string(from: Date())
        let existing = (try? service.list(in: project.folderPath)) ?? []
        let usedBranches = Set(existing.compactMap { $0.branch })
        let usedPaths = Set(existing.map {
            URL(fileURLWithPath: $0.path).standardizedFileURL.path
        })
        for attempt in 0..<32 {
            let suffix = attempt == 0 ? "" : "-\(attempt)"
            let branch = "watch/\(stamp)\(suffix)"
            guard let path = WorktreeResolver.path(
                projectFolder: project.folderPath,
                branch: branch
            ) else { continue }
            let normalizedPath = URL(fileURLWithPath: path).standardizedFileURL.path
            if usedBranches.contains(branch) { continue }
            if usedPaths.contains(normalizedPath) { continue }
            if FileManager.default.fileExists(atPath: path) { continue }
            return (branch, path)
        }
        return nil
    }
}
