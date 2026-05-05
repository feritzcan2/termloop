// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Bottom-detail panel of `TaskBoardPage`. Renders the selected task's header,
/// brief editor (markdown, autosave via debounced coordinator call), action
/// row (Open worktree / + Add agent run), and activity log (read-only
/// projection from existing stores).
struct TaskDetailPaneView: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var onBriefEdit: ((UUID, String?) -> Void)?
    var activityProvider: TaskActivityLogProviding = EmptyTaskActivityLogProvider.shared

    @State private var briefDraft: String = ""
    @State private var lastSeenTaskId: UUID?

    var body: some View {
        Group {
            if let snap = store.selectedTaskDetailSnapshot {
                content(for: snap)
                    .onAppear { syncBrief(from: snap) }
                    .onChange(of: snap.id) { _ in syncBrief(from: snap) }
            } else {
                emptyState
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder
    private func content(for snap: TaskDetailSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            header(snap)
            briefEditor(snap)
            actions(snap)
            activityLog(snap)
            Spacer(minLength: 0)
        }
    }

    private func header(_ snap: TaskDetailSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(snap.title).font(.system(size: 14, weight: .semibold))
            HStack(spacing: 6) {
                Text(columnTitle(snap.columnId))
                if let branch = snap.branch {
                    Text("· \(branch)")
                }
            }
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }
    }

    private func briefEditor(_ snap: TaskDetailSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(String(localized: "tasks.detail.brief.label",
                        defaultValue: "BRIEF", table: "TermLoop"))
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
            TextEditor(text: $briefDraft)
                .font(.system(size: 12))
                .frame(minHeight: 60, maxHeight: 140)
                .background(Color(nsColor: .textBackgroundColor))
                .cornerRadius(4)
                .onChange(of: briefDraft) { newValue in
                    onBriefEdit?(snap.id, newValue.isEmpty ? nil : newValue)
                }
        }
    }

    private func actions(_ snap: TaskDetailSnapshot) -> some View {
        HStack(spacing: 6) {
            Button(String(localized: "tasks.detail.action.openWorktree",
                          defaultValue: "Open worktree", table: "TermLoop")) {
                if let workspaceId = snap.workspaceId {
                    TaskQuickActions.openWorktree(workspaceId: workspaceId)
                }
            }
            .disabled(snap.workspaceId == nil)

            Button(String(localized: "tasks.detail.action.addAgent",
                          defaultValue: "+ Add agent run", table: "TermLoop")) {
                if let workspaceId = snap.workspaceId {
                    TaskQuickActions.addAgentRun(workspaceId: workspaceId)
                }
            }
            .disabled(snap.workspaceId == nil)
        }
    }

    private func activityLog(_ snap: TaskDetailSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(String(localized: "tasks.detail.activity.label",
                        defaultValue: "ACTIVITY", table: "TermLoop"))
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
            let entries = activityProvider.entries(for: snap.id, limit: 30)
            if entries.isEmpty {
                Text(String(localized: "tasks.detail.activity.empty",
                            defaultValue: "No activity yet.", table: "TermLoop"))
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            } else {
                ForEach(entries) { entry in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(Self.timeFormatter.string(from: entry.timestamp))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary)
                        Text(entry.title).font(.system(size: 11))
                        if let detail = entry.detail {
                            Text(detail)
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        Text(String(localized: "tasks.detail.empty",
                    defaultValue: "Select a task to see details.", table: "TermLoop"))
            .font(.system(size: 12))
            .foregroundColor(.secondary)
    }

    private func syncBrief(from snap: TaskDetailSnapshot) {
        if lastSeenTaskId != snap.id {
            briefDraft = snap.brief ?? ""
            lastSeenTaskId = snap.id
        }
    }

    /// Cached formatter; HH:mm is fine for v1.
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    private func columnTitle(_ id: TaskColumnId) -> String {
        switch id {
        case .backlog: return String(localized: "tasks.column.backlog", defaultValue: "Backlog", table: "TermLoop")
        case .todo: return String(localized: "tasks.column.todo", defaultValue: "Todo", table: "TermLoop")
        case .inProgress: return String(localized: "tasks.column.in_progress", defaultValue: "In Progress", table: "TermLoop")
        case .inReview: return String(localized: "tasks.column.in_review", defaultValue: "In Review", table: "TermLoop")
        case .done: return String(localized: "tasks.column.done", defaultValue: "Done", table: "TermLoop")
        }
    }
}
