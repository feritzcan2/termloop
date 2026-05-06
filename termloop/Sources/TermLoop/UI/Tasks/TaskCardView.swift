// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Single kanban card. Pure projection of `TaskCardSummary`. Selection state
/// is read from the per-window `TaskSelectionStore`. Drag is enabled only when
/// the card is not in `.pending` state — pending cards are mid-bind and must
/// not be raced.
struct TaskCardView: View {
    let card: TaskCardSummary
    let agentStatus: TaskAgentStatusSummary?
    let workItem: TaskWorkItemSnapshot?
    @ObservedObject var selection: TaskSelectionStore
    var onSelect: ((TaskCardSummary) -> Void)?
    var onCommandClick: ((TaskCardSummary) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 7) {
                statusDot
                Text(card.title)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(2)
                    .foregroundColor(.primary)
                Spacer(minLength: 0)
            }

            identityLine

            HStack(spacing: 6) {
                statusChip
                workItemChip
                sourceChip
                Spacer(minLength: 0)
                if displayedAgentCount > 0 {
                    Label("\(displayedAgentCount)", systemImage: "person.crop.circle")
                        .labelStyle(.titleAndIcon)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.secondary)
                }
            }
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 10)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(borderColor, lineWidth: isSelected ? 1.5 : 1)
        )
        .shadow(color: Color.black.opacity(isSelected ? 0.16 : 0.10), radius: isSelected ? 4 : 2, y: 1)
        .opacity(card.provisionState == .pending ? 0.76 : 1.0)
        .contentShape(Rectangle())
        .help(cardHelp)
        .onTapGesture {
            if NSEvent.modifierFlags.contains(.command), let onCommandClick {
                onCommandClick(card)
            } else if let onSelect {
                onSelect(card)
            } else {
                selection.select(card.id)
            }
        }
        .modifier(TaskCardDragModifier(isEnabled: canDrag, taskId: card.id))
        .contextMenu {
            Button(String(localized: "tasks.card.menu.openInWorkTab",
                          defaultValue: "Open worktree", table: "TermLoop")) {
                onCommandClick?(card)
            }
            .disabled(card.worktreePath == nil)
            if let workItem, workItem.url != nil {
                Button(String(localized: "tasks.card.menu.openWorkItem",
                              defaultValue: "Open work item",
                              table: "TermLoop")) {
                    openWorkItem(workItem)
                }
            }
            if let workItem, workItem.taskFilePath != nil {
                Button(String(localized: "tasks.card.menu.openTaskFile",
                              defaultValue: "Open task.md",
                              table: "TermLoop")) {
                    openTaskFile(workItem)
                }
            }
            Button(String(localized: "tasks.card.menu.archive",
                          defaultValue: "Archive", table: "TermLoop")) {
                onArchive?(card.id)
            }
        }
    }

    private var identityLine: some View {
        HStack(spacing: 6) {
            Image(systemName: card.branch == nil ? "doc.text" : "arrow.triangle.branch")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(.secondary.opacity(0.85))
                .frame(width: 13)
            Text(identityText)
                .font(.system(size: 10, design: card.branch == nil && card.worktreePath != nil ? .monospaced : .default))
                .foregroundColor(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }

    private var isSelected: Bool { selection.selectedTaskId == card.id }
    private var canDrag: Bool { card.provisionState != .pending }

    private var identityText: String {
        if let branch = normalizedBranch {
            return branch
        }
        if let path = normalizedWorktreePath {
            return TaskPathNormalization.resolveDisplayAndKey(path)?.leafName
                ?? URL(fileURLWithPath: path).lastPathComponent
        }
        return String(localized: "tasks.card.identity.manual",
                      defaultValue: "Manual task", table: "TermLoop")
    }

    private var normalizedBranch: String? {
        guard let branch = card.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty else {
            return nil
        }
        return branch
    }

    private var normalizedWorktreePath: String? {
        guard let path = card.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty else {
            return nil
        }
        return TaskPathNormalization.resolveDisplayAndKey(path)?.displayPath
    }

    private var cardBackground: Color {
        switch card.provisionState {
        case .failed: return Color(nsColor: .controlBackgroundColor).opacity(0.95)
        case .pending: return Color.orange.opacity(0.10)
        case .ready, .none:
            if let agentStatus, agentStatus.dominantState.isWaitingLike {
                return effectiveStatus.color.opacity(0.07)
            }
            return Color(nsColor: .controlBackgroundColor)
        }
    }

    private var borderColor: Color {
        if isSelected { return .accentColor }
        switch card.provisionState {
        case .failed, .pending: return card.provisionState.taskStatusColor.opacity(0.40)
        case .ready:
            return effectiveStatus.color.opacity(effectiveStatus.usesAgentStatus ? 0.38 : 0.22)
        case .none: return Color.white.opacity(0.07)
        }
    }

    private var statusDot: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 7, height: 7)
            .padding(.top, 4)
    }

    private var statusChip: some View {
        Text(effectiveStatus.text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(effectiveStatus.color)
            .lineLimit(1)
            .padding(.vertical, 2)
            .padding(.horizontal, 7)
            .background(effectiveStatus.color.opacity(0.13))
            .clipShape(Capsule())
    }

    @ViewBuilder
    private var workItemChip: some View {
        if let workItem {
            HStack(spacing: 3) {
                Image(systemName: "checklist")
                    .font(.system(size: 8.5, weight: .semibold))
                Text(workItem.compactLabel)
                    .lineLimit(1)
            }
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.blue)
            .padding(.vertical, 2)
            .padding(.horizontal, 7)
            .background(Color.blue.opacity(0.12))
            .clipShape(Capsule())
            .help(workItem.url?.absoluteString ?? workItem.compactLabel)
        }
    }

    private var sourceChip: some View {
        Text(sourceText)
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(.secondary)
            .lineLimit(1)
            .padding(.vertical, 2)
            .padding(.horizontal, 7)
            .background(Color.white.opacity(0.045))
            .clipShape(Capsule())
    }

    private var sourceText: String {
        if card.worktreePath != nil {
            return String(localized: "tasks.card.source.worktree",
                          defaultValue: "Worktree", table: "TermLoop")
        }
        return String(localized: "tasks.card.source.manual",
                      defaultValue: "Manual", table: "TermLoop")
    }

    private var cardHelp: String {
        if let path = normalizedWorktreePath {
            let prefix = String(localized: "tasks.card.help.openWorktree",
                                defaultValue: "⌘-click opens worktree",
                                table: "TermLoop")
            return "\(prefix)\n\(path)"
        }
        return String(localized: "tasks.card.help.noWorktree",
                      defaultValue: "Select for details. Move to In Progress or Rebind to attach a worktree.",
                      table: "TermLoop")
    }

    private var statusColor: Color { effectiveStatus.color }

    private var displayedAgentCount: Int {
        agentStatus?.agentCount ?? 0
    }

    private var effectiveStatus: TaskStatusPresentation {
        TaskStatusPresentation(
            provisionState: card.provisionState,
            agentStatus: agentStatus
        )
    }

    private func openWorkItem(_ workItem: TaskWorkItemSnapshot) {
        guard let url = workItem.url else { return }
        WorktreeURLRouter.open(
            url,
            workspaceIds: workItem.workspaceId.map { [$0] } ?? [],
            preferredWorkspaceId: workItem.workspaceId
        )
    }

    private func openTaskFile(_ workItem: TaskWorkItemSnapshot) {
        guard let path = workItem.taskFilePath else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: false))
    }
}

private struct TaskCardDragModifier: ViewModifier {
    let isEnabled: Bool
    let taskId: UUID

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled {
            content.onDrag {
                NSItemProvider(object: taskId.uuidString as NSString)
            }
        } else {
            content
        }
    }
}

@MainActor
struct TaskStatusPresentation {
    let text: String
    let color: Color
    let usesAgentStatus: Bool

    init(provisionState: TaskProvisionState, agentStatus: TaskAgentStatusSummary?) {
        if let agentStatus, Self.canShowAgentStatus(over: provisionState) {
            self.text = TerminalAgentDisplayFormatter.stateText(for: agentStatus.dominantState)
            self.color = TermLoopSidebarTheme.color(for: agentStatus.dominantState)
            self.usesAgentStatus = true
        } else {
            self.text = provisionState.taskCompactStatusText
            self.color = provisionState.taskStatusColor
            self.usesAgentStatus = false
        }
    }

    private static func canShowAgentStatus(over provisionState: TaskProvisionState) -> Bool {
        switch provisionState {
        case .failed, .pending:
            return false
        case .ready, .none:
            return true
        }
    }
}

extension TaskProvisionState {
    var taskStatusColor: Color {
        switch self {
        case .pending: return .orange
        case .failed: return .red
        case .ready: return .green
        case .none: return .secondary
        }
    }

    var taskCompactStatusText: String {
        if let reason = failureDisplayText { return reason }
        switch self {
        case .pending:
            return String(localized: "tasks.status.provisioning",
                          defaultValue: "Provisioning", table: "TermLoop")
        case .ready:
            return String(localized: "tasks.status.ready",
                          defaultValue: "Ready", table: "TermLoop")
        case .none:
            return String(localized: "tasks.status.noWorktree",
                          defaultValue: "No worktree", table: "TermLoop")
        case .failed:
            return String(localized: "tasks.status.needsRepair",
                          defaultValue: "Needs repair", table: "TermLoop")
        }
    }

    var taskDetailStatusText: String {
        if let reason = failureDisplayText { return reason }
        switch self {
        case .none:
            return String(localized: "tasks.detail.statusChip.unbound",
                          defaultValue: "No worktree", table: "TermLoop")
        case .pending:
            return String(localized: "tasks.status.provisioning",
                          defaultValue: "Provisioning", table: "TermLoop")
        case .ready:
            return String(localized: "tasks.status.ready",
                          defaultValue: "Ready", table: "TermLoop")
        case .failed:
            return String(localized: "tasks.status.needsRepair",
                          defaultValue: "Needs repair", table: "TermLoop")
        }
    }
}
