// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Hook file for TermLoop-owned fields that need to be merged into upstream
/// `TerminalController` payloads. Keeps the fork's socket customizations out
/// of `TerminalController.swift` so upstream diffs stay minimal.
extension TerminalController {
    /// Extra fields that TermLoop contributes to the v2 workspace summary
    /// payload. Called from a marker-wrapped one-liner in
    /// `v2WorkspaceSummaryPayload` via `payload.merge(...)`.
    @MainActor
    func termLoopWorkspaceSummaryFields(for workspace: Workspace) -> [String: Any] {
        var fields: [String: Any] = [
            "project_id": workspace.projectId?.uuidString as Any? ?? NSNull()
        ]
        if let claude = WorkspaceMetadataStore.shared.claudeSession(workspaceId: workspace.id.uuidString) {
            fields["claude_session_id"] = claude.sessionId
            fields["claude_cwd"] = claude.cwd ?? NSNull()
            fields["claude_running"] = TerminalAgentActivityStore.shared.isAgentRunning(
                forWorkspace: workspace,
                agentId: "claude"
            )
        } else {
            fields["claude_session_id"] = NSNull()
            fields["claude_cwd"] = NSNull()
            fields["claude_running"] = NSNull()
        }
        ClaudeHooksStatus.shared.refreshIfStale()
        fields["claude_hooks_installed"] = ClaudeHooksStatus.shared.installed

        let branch = WorkspaceMetadataStore.shared.branch(for: workspace)
        fields["branch"] = branch as Any? ?? NSNull()
        if branch != nil,
           let path = workspace.termLoopPresentationCwd() {
            fields["worktree_path"] = path
        } else {
            fields["worktree_path"] = NSNull()
        }
        let gitChanges = workspace.aggregatedGitChanges()
        fields["git_dirty"] = (gitChanges?.count ?? 0) > 0
        fields["git_change_count"] = gitChanges?.count ?? 0
        let md = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspace.id)
        fields["terminal_agent_id"] = md.terminalAgentId as Any? ?? NSNull()
        fields["permission_mode"] = md.permissionMode as Any? ?? NSNull()
        fields["awaiting_input_since"] = md.awaitingInputSince as Any? ?? NSNull()
        fields["last_message_preview"] = md.lastMessagePreview as Any? ?? NSNull()
        fields["last_attention_kind"] = md.lastAttentionKindRaw as Any? ?? NSNull()
        if let activity = TerminalAgentActivityStore.shared.state(forWorkspaceId: workspace.id) {
            fields["agent_activity_phase"] = activity.phase.rawValue
            fields["agent_attention_kind"] = activity.attentionKind?.rawValue as Any? ?? NSNull()
            fields["agent_activity_preview"] = activity.preview as Any? ?? NSNull()
            fields["agent_activity_updated_at"] = activity.updatedAt.timeIntervalSince1970
        } else {
            fields["agent_activity_phase"] = NSNull()
            fields["agent_attention_kind"] = NSNull()
            fields["agent_activity_preview"] = NSNull()
            fields["agent_activity_updated_at"] = NSNull()
        }
        return fields
    }

    @MainActor
    func termLoopWorkspaceGitChangesPayload(for workspace: Workspace) -> [String: Any] {
        let branch = WorkspaceMetadataStore.shared.branch(for: workspace)
        let worktreePath: String? = {
            guard branch != nil else {
                return nil
            }
            return workspace.termLoopPresentationCwd()
        }()
        let changes = workspace.aggregatedGitChanges()
        return [
            "workspace_id": workspace.id.uuidString,
            "title": workspace.title,
            "branch": branch as Any? ?? NSNull(),
            "worktree_path": worktreePath as Any? ?? NSNull(),
            "git_dirty": (changes?.count ?? 0) > 0,
            "git_change_count": changes?.count ?? 0,
            "files": changes?.files.map { file in
                [
                    "path": file.path,
                    "status": file.status.rawValue
                ]
            } ?? []
        ]
    }
}
