// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar content when a task is selected. Pulls the selected task's snapshot
/// from the store and shows: breadcrumb back, header, repair banner (if
/// provision failed), and four projection sections (Agents, Git Changes,
/// Open PRs, Worktree Branches).
struct TaskSidebarDrillInView: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var onRebind: ((UUID) -> Void)?
    var onUnbind: ((UUID) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                breadcrumb
                if let snap = store.selectedTaskDetailSnapshot {
                    header(snap)
                    if case .failed(let reason) = snap.provisionState {
                        TaskRepairBanner(
                            reason: reason,
                            onRebind: { onRebind?(snap.id) },
                            onUnbind: { onUnbind?(snap.id) },
                            onArchive: { onArchive?(snap.id); selection.select(nil) }
                        )
                    }
                    TaskAgentsSection(workspaceId: snap.workspaceId)
                    TaskGitChangesSection(workspaceId: snap.workspaceId)
                    TaskOpenPRsSection(workspaceId: snap.workspaceId)
                    TaskBranchesSection(branch: snap.branch)
                }
            }
            .padding(8)
        }
    }

    private var breadcrumb: some View {
        Button(action: { selection.select(nil) }) {
            HStack(spacing: 3) {
                Image(systemName: "chevron.left")
                Text(String(localized: "tasks.sidebar.allTasks",
                            defaultValue: "All tasks", table: "TermLoop"))
            }
            .font(.system(size: 11))
            .foregroundColor(.accentColor)
        }
        .buttonStyle(.plain)
    }

    private func header(_ snap: TaskDetailSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(snap.title).font(.system(size: 13, weight: .semibold))
            HStack(spacing: 6) {
                Text(provisionLabel(snap.provisionState))
                if let branch = snap.branch { Text("· \(branch)") }
            }
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }
    }

    private func provisionLabel(_ s: TaskProvisionState) -> String {
        switch s {
        case .none: return ""
        case .pending: return "Provisioning…"
        case .ready: return "Active"
        case .failed: return "Failed"
        }
    }
}
