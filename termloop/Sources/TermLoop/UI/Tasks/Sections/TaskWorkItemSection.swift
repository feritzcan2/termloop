// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI
import AppKit

/// Sidebar drill-in section for the task's remote work item. Tasks prefer the
/// task-owned remote link and only project existing worktree-scoped Jira
/// bindings as read-only context.
struct TaskWorkItemSection: View {
    let taskId: UUID
    let taskWorkItem: TaskWorkItemSnapshot?
    let workspaceId: UUID?
    let worktreePath: String?
    let projectId: UUID?
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var worktreeProjectionStore = WorktreeProjectionStore.shared

    private var snapshot: TaskWorkItemSnapshot? {
        if let taskWorkItem { return taskWorkItem }
        // Intentional subscription read: work item binding is external
        // workspace metadata, not task-board state.
        _ = metadataStore
        _ = worktreeProjectionStore.version
        return TaskWorkItemProjectionBuilder.snapshot(
            workspaceId: workspaceId,
            worktreePath: worktreePath,
            projectId: projectId
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TaskSidebarSectionTitle(
                String(localized: "tasks.sidebar.section.workItem",
                       defaultValue: "Work Item",
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
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: iconName(for: snapshot.reference.provider))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tint(for: snapshot.reference.provider))
                    .frame(width: 16, height: 18)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(snapshot.key)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        if let status = snapshot.statusLabel {
                            statusPill(status)
                        }
                        Spacer(minLength: 0)
                    }
                    if let title = snapshot.title, title != snapshot.key {
                        Text(title)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color.primary.opacity(0.86))
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if snapshot.url != nil {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.secondary)
                        .padding(.top, 1)
                }
            }

            actionBar(snapshot)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.56))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .help(snapshot.url?.absoluteString ?? snapshot.compactLabel)
    }

    private func statusPill(_ status: String) -> some View {
        Text(status)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Color.blue)
            .lineLimit(1)
            .padding(.vertical, 2)
            .padding(.horizontal, 6)
            .background(Color.blue.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }

    private func actionBar(_ snapshot: TaskWorkItemSnapshot) -> some View {
        HStack(spacing: 6) {
            if snapshot.url != nil {
                Button {
                    open(snapshot)
                } label: {
                    Label(String(localized: "tasks.sidebar.section.workItem.open",
                                 defaultValue: "Open \(snapshot.reference.provider.displayLabel)",
                                 table: "TermLoop"),
                          systemImage: "arrow.up.right")
                }
            }
            if snapshot.taskFilePath != nil {
                Button {
                    openTaskFile(snapshot)
                } label: {
                    Label(String(localized: "tasks.sidebar.section.workItem.openTaskFile",
                                 defaultValue: "task.md",
                                 table: "TermLoop"),
                          systemImage: "doc.text")
                }
            }
            Button {
                refresh(snapshot)
            } label: {
                Label(String(localized: "tasks.sidebar.section.workItem.refresh",
                             defaultValue: "Refresh",
                             table: "TermLoop"),
                      systemImage: "arrow.clockwise")
            }
            Button {
                presentTaskLinkPrompt(prior: snapshot.url?.absoluteString ?? snapshot.key)
            } label: {
                Label(String(localized: "tasks.sidebar.section.workItem.relink",
                             defaultValue: "Relink",
                             table: "TermLoop"),
                      systemImage: "link")
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.mini)
        .font(.system(size: 11, weight: .medium))
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 7) {
            TaskSidebarEmptyText(
                String(localized: "tasks.sidebar.section.workItem.empty",
                       defaultValue: "No work item is linked to this task.",
                       table: "TermLoop")
            )
            Button(String(localized: "tasks.sidebar.section.workItem.link",
                          defaultValue: "Link work item",
                          table: "TermLoop")) {
                presentTaskLinkPrompt(prior: "")
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)
        }
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
        guard let workspaceId = snapshot.workspaceId,
              let worktreePath = snapshot.worktreePath else {
            remoteSync.refresh(taskId: taskId)
            return
        }
        RemoteWorkItemBindingRefreshCoordinator.shared.refresh(
            inputs: [
                RemoteWorkItemBindingRefreshCoordinator.Input(
                    workspaceId: workspaceId,
                    worktreePath: worktreePath,
                    reference: snapshot.reference
                )
            ],
            reason: "tasks.workItemSection"
        )
    }

    private func openTaskFile(_ snapshot: TaskWorkItemSnapshot) {
        guard let path = snapshot.taskFilePath else { return }
        TaskQuickActions.openTaskFile(path: path, displayTitle: snapshot.key)
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

struct TaskSpecSection: View {
    let snapshot: TaskDetailSnapshot
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            TaskSidebarSectionTitle(
                String(localized: "tasks.sidebar.section.taskSpec",
                       defaultValue: "Task Spec",
                       table: "TermLoop")
            )

            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "doc.text")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 16, height: 18)

                VStack(alignment: .leading, spacing: 5) {
                    Text(fileLabel)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Text(summary)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 0)

                Button {
                    onOpen()
                } label: {
                    Label(buttonTitle, systemImage: "square.and.pencil")
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .font(.system(size: 11, weight: .medium))
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.56))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }

    private var fileLabel: String {
        guard let path = taskFilePath else {
            return "task.md"
        }
        let url = URL(fileURLWithPath: path, isDirectory: false)
        let parent = url.deletingLastPathComponent().lastPathComponent
        return parent.isEmpty ? url.lastPathComponent : "\(parent)/\(url.lastPathComponent)"
    }

    private var summary: String {
        if taskFilePath != nil {
            return String(localized: "tasks.sidebar.section.taskSpec.ready",
                          defaultValue: "Editable implementation notes for this task.",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.section.taskSpec.empty",
                      defaultValue: "Create an editable task.md for acceptance criteria and implementation notes.",
                      table: "TermLoop")
    }

    private var buttonTitle: String {
        if taskFilePath != nil {
            return String(localized: "tasks.sidebar.section.taskSpec.open",
                          defaultValue: "Open",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.section.taskSpec.create",
                      defaultValue: "Create",
                      table: "TermLoop")
    }

    private var taskFilePath: String? {
        let trimmed = snapshot.taskFilePath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
