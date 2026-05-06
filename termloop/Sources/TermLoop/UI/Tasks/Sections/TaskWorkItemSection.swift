// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI
import AppKit

/// Sidebar drill-in section for the work item already attached to this task's
/// worktree. The binding remains worktree-scoped; Tasks only projects it.
struct TaskWorkItemSection: View {
    let taskId: UUID
    let taskWorkItem: TaskWorkItemSnapshot?
    let workspaceId: UUID?
    let worktreePath: String?
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared

    private var snapshot: TaskWorkItemSnapshot? {
        if let taskWorkItem { return taskWorkItem }
        // Intentional subscription read: work item binding is external
        // workspace metadata, not task-board state.
        _ = metadataStore
        return TaskWorkItemProjectionBuilder.snapshot(
            workspaceId: workspaceId,
            worktreePath: worktreePath
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TaskSidebarSectionTitle(
                String(localized: "tasks.sidebar.section.workItem",
                       defaultValue: "WORK ITEM",
                       table: "TermLoop")
            )

            if let snapshot {
                workItemRow(snapshot)
            } else {
                emptyState
            }
        }
    }

    private func workItemRow(_ snapshot: TaskWorkItemSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: iconName(for: snapshot.reference.provider))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint(for: snapshot.reference.provider))
                    .frame(width: 14)
                VStack(alignment: .leading, spacing: 2) {
                    Text(snapshot.key)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    if let status = snapshot.statusLabel {
                        Text(status)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if snapshot.url != nil {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Color.secondary)
                }
            }

            HStack(spacing: 6) {
                if snapshot.url != nil {
                    Button(String(localized: "tasks.sidebar.section.workItem.open",
                                  defaultValue: "Open",
                                  table: "TermLoop")) {
                        open(snapshot)
                    }
                }
                if snapshot.taskFilePath != nil {
                    Button(String(localized: "tasks.sidebar.section.workItem.openTaskFile",
                                  defaultValue: "task.md",
                                  table: "TermLoop")) {
                        openTaskFile(snapshot)
                    }
                }
                Button(String(localized: "tasks.sidebar.section.workItem.refresh",
                              defaultValue: "Refresh",
                              table: "TermLoop")) {
                    refresh(snapshot)
                }
                Button(String(localized: "tasks.sidebar.section.workItem.link",
                              defaultValue: "Link",
                              table: "TermLoop")) {
                    presentTaskLinkPrompt(prior: snapshot.url?.absoluteString ?? snapshot.key)
                }
                if let workspaceId = attachWorkspaceId {
                    Button(String(localized: "tasks.sidebar.section.workItem.change",
                                  defaultValue: "Attach to worktree",
                                  table: "TermLoop")) {
                        JiraTicketBindingPrompt.present(forWorkspaceId: workspaceId)
                    }
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.42))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .help(snapshot.url?.absoluteString ?? snapshot.compactLabel)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 7) {
            TaskSidebarEmptyText(
                String(localized: "tasks.sidebar.section.workItem.empty",
                       defaultValue: "No work item is attached to this worktree.",
                       table: "TermLoop")
            )
            if let workspaceId = attachWorkspaceId {
                Button(String(localized: "tasks.sidebar.section.workItem.attach",
                              defaultValue: "Attach to worktree",
                              table: "TermLoop")) {
                    JiraTicketBindingPrompt.present(forWorkspaceId: workspaceId)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
            Button(String(localized: "tasks.sidebar.section.workItem.link",
                          defaultValue: "Link work item",
                          table: "TermLoop")) {
                presentTaskLinkPrompt(prior: "")
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)
        }
    }

    private var attachWorkspaceId: UUID? {
        TaskWorkItemProjectionBuilder.preferredWorkspaceId(
            workspaceId: workspaceId,
            worktreePath: worktreePath
        )
    }

    private func open(_ snapshot: TaskWorkItemSnapshot) {
        guard let url = snapshot.url else { return }
        WorktreeURLRouter.open(
            url,
            workspaceIds: snapshot.workspaceId.map { [$0] } ?? [],
            preferredWorkspaceId: snapshot.workspaceId
        )
    }

    private func refresh(_ snapshot: TaskWorkItemSnapshot) {
        if snapshot.binding == nil {
            remoteSync.refresh(taskId: taskId)
            return
        }
        guard let workspaceId = snapshot.workspaceId,
              let reportedStatePath = snapshot.reportedStatePath,
              let binding = snapshot.binding,
              let input = RemoteWorkItemBindingRefreshCoordinator.input(
                workspaceId: workspaceId,
                reportedStatePath: reportedStatePath,
                binding: binding
              ) else { return }
        RemoteWorkItemBindingRefreshCoordinator.shared.refresh(
            inputs: [input],
            reason: "tasks.workItemSection"
        )
    }

    private func openTaskFile(_ snapshot: TaskWorkItemSnapshot) {
        guard let path = snapshot.taskFilePath else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: false))
    }

    private func presentTaskLinkPrompt(prior: String) {
        let alert = NSAlert()
        alert.messageText = String(localized: "tasks.remoteSync.link.prompt.title",
                                   defaultValue: "Link Work Item",
                                   table: "TermLoop")
        alert.informativeText = String(localized: "tasks.remoteSync.link.prompt.body",
                                       defaultValue: "Paste a Jira key/URL, GitHub issue URL, or owner/repo#number. TermLoop will fetch it and write task.md.",
                                       table: "TermLoop")
        alert.alertStyle = .informational
        let field = NSTextField(string: prior)
        field.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: String(localized: "tasks.remoteSync.link.prompt.link",
                                          defaultValue: "Link",
                                          table: "TermLoop"))
        alert.addButton(withTitle: String(localized: "common.cancel",
                                          defaultValue: "Cancel",
                                          table: "TermLoop"))
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return }
        remoteSync.link(taskId: taskId, rawInput: field.stringValue)
    }

    private func iconName(for provider: RemoteWorkItemProviderId) -> String {
        switch provider {
        case .jira: return "checklist"
        case .github: return "number"
        case .gitlab: return "shippingbox"
        }
    }

    private func tint(for provider: RemoteWorkItemProviderId) -> Color {
        switch provider {
        case .jira: return .blue
        case .github: return .secondary
        case .gitlab: return .orange
        }
    }
}
