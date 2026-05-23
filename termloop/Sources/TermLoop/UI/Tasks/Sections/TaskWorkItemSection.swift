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
    /// When true, render only the inner row content without the section title
    /// or card chrome. The caller is responsible for wrapping the row.
    var unwrapped: Bool = false

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
        if unwrapped {
            innerContent
        } else {
            VStack(alignment: .leading, spacing: 6) {
                TaskSidebarSectionTitle(
                    String(localized: "tasks.sidebar.section.workItem",
                           defaultValue: "Work Item",
                           table: "TermLoop")
                )
                innerContent
            }
        }
    }

    @ViewBuilder
    private var innerContent: some View {
        if let snapshot {
            if unwrapped {
                unwrappedWorkItemRow(snapshot)
            } else {
                workItemRow(snapshot)
            }
        } else {
            emptyState
        }
    }

    /// Compact row variant for the merged "Task" card. Drops the card
    /// background (parent provides it) and the redundant title duplication.
    private func unwrappedWorkItemRow(_ snapshot: TaskWorkItemSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 9) {
                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: iconName(for: snapshot.reference.provider))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(tint(for: snapshot.reference.provider))
                        .frame(width: 16, height: 18)

                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(snapshot.key)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Color.primary)
                                .lineLimit(1)
                            if let status = snapshot.statusLabel {
                                statusPill(status)
                            }
                            Spacer(minLength: 0)
                        }
                        if let title = snapshot.title, title != snapshot.key {
                            Text(title)
                                .font(.system(size: 11))
                                .foregroundStyle(Color.primary.opacity(0.76))
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    open(snapshot)
                }
                .help(openURL(for: snapshot)?.absoluteString ?? snapshot.compactLabel)

                rowMenu(snapshot)
            }
        }
    }

    private func rowMenu(_ snapshot: TaskWorkItemSnapshot) -> some View {
        Menu {
            if openURL(for: snapshot) != nil {
                Button(action: { open(snapshot) }) {
                    Label(String(localized: "tasks.sidebar.section.workItem.open",
                                 defaultValue: "Open \(snapshot.reference.provider.displayLabel)",
                                 table: "TermLoop"),
                          systemImage: "arrow.up.right")
                }
            }
            Button(action: { refresh(snapshot) }) {
                Label(String(localized: "tasks.sidebar.section.workItem.refresh",
                             defaultValue: "Refresh",
                             table: "TermLoop"),
                      systemImage: "arrow.clockwise")
            }
            Button(action: { presentTaskLinkPrompt(prior: openURL(for: snapshot)?.absoluteString ?? snapshot.key) }) {
                Label(String(localized: "tasks.sidebar.section.workItem.relink",
                             defaultValue: "Relink",
                             table: "TermLoop"),
                      systemImage: "link")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
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

                if openURL(for: snapshot) != nil {
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
        .help(openURL(for: snapshot)?.absoluteString ?? snapshot.compactLabel)
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
            if openURL(for: snapshot) != nil {
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
                presentTaskLinkPrompt(prior: openURL(for: snapshot)?.absoluteString ?? snapshot.key)
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
        guard let url = openURL(for: snapshot) else { return }
        WorktreeURLRouter.open(
            url,
            workspaceIds: snapshot.workspaceId.map { [$0] } ?? [],
            preferredWorkspaceId: snapshot.workspaceId
        )
    }

    private func openURL(for snapshot: TaskWorkItemSnapshot) -> URL? {
        if let url = snapshot.url { return url }
        switch snapshot.reference.provider {
        case .jira:
            return jiraURL(for: snapshot.reference)
        case .github, .gitlab:
            return remoteIssueURL(for: snapshot.reference)
        }
    }

    private func jiraURL(for reference: RemoteWorkItemReference) -> URL? {
        let site = (reference.host ?? remoteSync.settings.jiraSite ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !site.isEmpty else { return nil }
        let base = site.hasPrefix("http://") || site.hasPrefix("https://")
            ? site
            : "https://\(site)"
        return URL(string: "\(base)/browse/\(reference.key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? reference.key)")
    }

    private func remoteIssueURL(for reference: RemoteWorkItemReference) -> URL? {
        guard let host = reference.host,
              let namespace = reference.namespace,
              let repository = reference.repository,
              let number = reference.number else {
            return nil
        }
        let encodedNamespace = namespace
            .split(separator: "/")
            .map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
        let encodedRepo = repository.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? repository
        switch reference.provider {
        case .github:
            return URL(string: "https://\(host)/\(encodedNamespace)/\(encodedRepo)/issues/\(number)")
        case .gitlab:
            return URL(string: "https://\(host)/\(encodedNamespace)/\(encodedRepo)/-/issues/\(number)")
        case .jira:
            return nil
        }
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
    var onRefineWithAgent: (() -> Void)? = nil
    var onExecuteWithAgent: (() -> Void)? = nil
    /// When true, render only the inner row content without the section title
    /// or card chrome. The caller is responsible for wrapping the row.
    var unwrapped: Bool = false

    var body: some View {
        if unwrapped {
            innerRow
        } else {
            VStack(alignment: .leading, spacing: 7) {
                TaskSidebarSectionTitle(
                    String(localized: "tasks.sidebar.section.taskSpec",
                           defaultValue: "Task Spec",
                           table: "TermLoop")
                )

                innerRow
                    .padding(.vertical, 8)
                    .padding(.horizontal, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .controlBackgroundColor).opacity(0.56))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }

    private var innerRow: some View {
        HStack(alignment: .top, spacing: 9) {
            fileIcon

            VStack(alignment: .leading, spacing: 3) {
                Text(fileLabel)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Text(summary)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)

            Image(systemName: "square.and.pencil")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 2)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .contextMenu {
            Button {
                onOpen()
            } label: {
                Label(openMenuTitle, systemImage: "square.and.pencil")
            }

            if let taskFilePath {
                Button {
                    copyFullPath(taskFilePath)
                } label: {
                    Label(String(localized: "tasks.sidebar.section.taskSpec.copyFullPath",
                                 defaultValue: "Copy Full Path",
                                 table: "TermLoop"),
                          systemImage: "doc.on.doc")
                }
            }

            Button {
                onRefineWithAgent?()
            } label: {
                Label(String(localized: "tasks.sidebar.section.taskSpec.refineWithAgent",
                             defaultValue: "Refine with Agent",
                             table: "TermLoop"),
                      systemImage: "sparkles")
            }
            .disabled(onRefineWithAgent == nil)

            Button {
                onExecuteWithAgent?()
            } label: {
                Label(String(localized: "tasks.sidebar.section.taskSpec.executeWithAgent",
                             defaultValue: "Execute with Agent",
                             table: "TermLoop"),
                      systemImage: "play.fill")
            }
            .disabled(onExecuteWithAgent == nil)
        }
        .help(openHelp)
    }

    private var fileIcon: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(systemName: taskFilePath == nil ? "doc.badge.plus" : "doc.text.fill")
                .font(.system(size: 16, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Color.accentColor)
                .frame(width: 24, height: 26)

            if taskFilePath != nil {
                Image(systemName: "pencil")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(Color(nsColor: .controlBackgroundColor))
                    .frame(width: 10, height: 10)
                    .background(Color.accentColor)
                    .clipShape(Circle())
                    .offset(x: 2, y: 1)
            }
        }
        .frame(width: 24, height: 26)
        .padding(.top, -2)
    }

    private func copyFullPath(_ path: String) {
        let fullPath = URL(fileURLWithPath: path, isDirectory: false).standardizedFileURL.path
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(fullPath, forType: .string)
    }

    private var fileLabel: String {
        guard let path = taskFilePath else {
            return "task.md"
        }
        let url = URL(fileURLWithPath: path, isDirectory: false)
        return url.lastPathComponent
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

    private var openMenuTitle: String {
        if taskFilePath != nil {
            return String(localized: "tasks.sidebar.section.taskSpec.open",
                          defaultValue: "Open",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.section.taskSpec.create",
                      defaultValue: "Create",
                      table: "TermLoop")
    }

    private var openHelp: String {
        if taskFilePath != nil {
            return String(localized: "tasks.sidebar.section.taskSpec.openHelp",
                          defaultValue: "Open task.md in the editor",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.section.taskSpec.createHelp",
                      defaultValue: "Create task.md and open it in the editor",
                      table: "TermLoop")
    }

    private var taskFilePath: String? {
        let trimmed = snapshot.taskFilePath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
