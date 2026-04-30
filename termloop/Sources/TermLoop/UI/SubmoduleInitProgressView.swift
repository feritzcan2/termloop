// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Footer chip rendered in `TermLoopSidebar.Footer` while one or more
/// submodule-init tasks are active. Collapses to `EmptyView` when idle.
///
/// Click opens `SubmoduleInitProgressSheet` so the user can see each
/// task's progress and cancel individually.
@MainActor
struct SubmoduleInitFooterChip: View {
    @ObservedObject private var store = SubmoduleInitStore.shared
    @State private var showSheet = false
    /// When set, tasks belonging to this workspace are excluded from
    /// the chip count because the content area already shows them.
    var activeWorkspaceId: UUID?

    /// Tasks visible in the chip — excludes the workspace whose content
    /// area already renders the full init progress view.
    private var visibleTasks: [SubmoduleInitStore.Task] {
        if let activeWorkspaceId {
            return store.tasks.filter { $0.workspaceId != activeWorkspaceId }
        }
        return store.tasks
    }

    var body: some View {
        if visibleTasks.isEmpty {
            EmptyView()
        } else {
            Button {
                showSheet = true
            } label: {
                chipBody
            }
            .buttonStyle(.plain)
            .sheet(isPresented: $showSheet) {
                SubmoduleInitProgressSheet()
            }
        }
    }

    private var chipBody: some View {
        let running = visibleTasks.filter { task in
            if case .running = task.phase { return true }
            if case .starting = task.phase { return true }
            return false
        }
        let failed = visibleTasks.filter {
            if case .failed = $0.phase { return true }
            return false
        }
        return HStack(spacing: 5) {
            if !running.isEmpty {
                ProgressView()
                    .progressViewStyle(.circular)
                    .controlSize(.mini)
                Text(chipLabel(runningCount: running.count, failedCount: failed.count))
                    .font(TermLoopSidebarTheme.bodyMono)
            } else if !failed.isEmpty {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(.orange)
                    .font(.system(size: 10))
                Text(String(
                    localized: "worktree.submodule.chip.failed",
                    defaultValue: "submodule init failed",
                    table: "TermLoop"
                ))
                .font(TermLoopSidebarTheme.bodyMono)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.secondary.opacity(0.12))
        )
    }

    private func chipLabel(runningCount: Int, failedCount: Int) -> String {
        if failedCount > 0 {
            return String(
                localized: "worktree.submodule.chip.runningMixed",
                defaultValue: "init \(runningCount)· failed \(failedCount)",
                table: "TermLoop"
            )
        }
        if runningCount == 1 {
            return String(
                localized: "worktree.submodule.chip.runningOne",
                defaultValue: "init submodules",
                table: "TermLoop"
            )
        }
        return String(
            localized: "worktree.submodule.chip.runningMany",
            defaultValue: "init submodules ×\(runningCount)",
            table: "TermLoop"
        )
    }
}

/// Detail sheet listing every active submodule-init task with its current
/// submodule + percent, the last raw stderr line for visibility, and a
/// Cancel button per task. Failed tasks stay until the user dismisses
/// them so failure reasons don't disappear after a transient error.
@MainActor
struct SubmoduleInitProgressSheet: View {
    @ObservedObject private var store = SubmoduleInitStore.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if store.tasks.isEmpty {
                Text(String(
                    localized: "worktree.submodule.sheet.empty",
                    defaultValue: "No active submodule operations.",
                    table: "TermLoop"
                ))
                .foregroundColor(.secondary)
                .padding()
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(store.tasks) { task in
                            SubmoduleInitTaskRow(task: task)
                            Divider().opacity(0.3)
                        }
                    }
                }
            }
        }
        .frame(width: 560, height: 360)
    }

    private var header: some View {
        HStack {
            Text(String(
                localized: "worktree.submodule.sheet.title",
                defaultValue: "Submodule setup",
                table: "TermLoop"
            ))
            .font(.title3)
            Spacer()
            Button(String(
                localized: "worktree.submodule.sheet.close",
                defaultValue: "Close",
                table: "TermLoop"
            )) {
                dismiss()
            }
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

/// Single row in the progress sheet. Observes its own task so per-task
/// progress updates don't rerender the whole list.
@MainActor
private struct SubmoduleInitTaskRow: View {
    @ObservedObject var task: SubmoduleInitStore.Task

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.label)
                        .font(.system(size: 13, weight: .medium))
                    if case .failed(let reason) = task.phase {
                        // Full, selectable failure text so the user can
                        // copy `fatal: ...` lines out of the sheet when
                        // filing a bug or trying the command by hand.
                        Text(reason)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.orange)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer()
                trailingAction
            }
            if case let .running(_, percent) = task.phase, let percent {
                ProgressView(value: percent)
                    .progressViewStyle(.linear)
            } else if case .starting = task.phase {
                ProgressView()
                    .progressViewStyle(.linear)
            }
            if !task.lastLine.isEmpty, !isCompleted {
                Text(task.lastLine)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var isCompleted: Bool {
        if case .completed = task.phase { return true }
        return false
    }

    private var subtitle: String {
        switch task.phase {
        case .starting:
            return String(
                localized: "worktree.submodule.phase.starting",
                defaultValue: "Starting…",
                table: "TermLoop"
            )
        case .running(let submodule, let percent):
            if let submodule, let percent {
                return String(
                    localized: "worktree.submodule.phase.runningBoth",
                    defaultValue: "\(submodule) · \(Int(percent * 100))%",
                    table: "TermLoop"
                )
            }
            if let submodule {
                return submodule
            }
            if let percent {
                return "\(Int(percent * 100))%"
            }
            return String(
                localized: "worktree.submodule.phase.running",
                defaultValue: "Running",
                table: "TermLoop"
            )
        case .completed:
            return String(
                localized: "worktree.submodule.phase.completed",
                defaultValue: "Done",
                table: "TermLoop"
            )
        case .failed(let reason):
            return reason
        }
    }

    @ViewBuilder
    private var trailingAction: some View {
        switch task.phase {
        case .starting, .running:
            Button(String(
                localized: "worktree.submodule.action.cancel",
                defaultValue: "Cancel",
                table: "TermLoop"
            )) {
                SubmoduleInitStore.shared.dismiss(taskId: task.id)
            }
            .font(.caption)
        case .failed:
            Button(String(
                localized: "worktree.submodule.action.dismiss",
                defaultValue: "Dismiss",
                table: "TermLoop"
            )) {
                SubmoduleInitStore.shared.dismiss(taskId: task.id)
            }
            .font(.caption)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(.green)
        }
    }
}
