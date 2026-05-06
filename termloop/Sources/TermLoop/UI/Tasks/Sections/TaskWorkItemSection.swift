// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar drill-in section for the work item already attached to this task's
/// worktree. The binding remains worktree-scoped; Tasks only projects it.
struct TaskWorkItemSection: View {
    let workspaceId: UUID?
    let worktreePath: String?

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared

    private var snapshot: TaskWorkItemSnapshot? {
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
                Button(String(localized: "tasks.sidebar.section.workItem.refresh",
                              defaultValue: "Refresh",
                              table: "TermLoop")) {
                    refresh(snapshot)
                }
                if let workspaceId = attachWorkspaceId {
                    Button(String(localized: "tasks.sidebar.section.workItem.change",
                                  defaultValue: "Change",
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
                              defaultValue: "Attach work item",
                              table: "TermLoop")) {
                    JiraTicketBindingPrompt.present(forWorkspaceId: workspaceId)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
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
        guard let workspaceId = snapshot.workspaceId,
              let input = RemoteWorkItemBindingRefreshCoordinator.input(
                workspaceId: workspaceId,
                reportedStatePath: snapshot.reportedStatePath,
                binding: snapshot.binding
              ) else { return }
        RemoteWorkItemBindingRefreshCoordinator.shared.refresh(
            inputs: [input],
            reason: "tasks.workItemSection"
        )
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
