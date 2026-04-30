// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Thin, quiet header for a shared Git worktree (≥2 tabs on the same branch)
/// sitting in the sidebar. Visual weight intentionally minimal — it sits
/// *above* unchanged `TabItemView` rows and a 1pt colored spine, so the
/// existing row design carries the work.
struct WorktreeGroupHeader: View {
    let branch: String
    let workspaceCount: Int
    let activitySummary: TerminalAgentAggregateSummary
    @Binding var isExpanded: Bool
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: 8) {
            Button {
                isExpanded.toggle()
            } label: {
                Text(verbatim: isExpanded ? "▾" : "▸")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .frame(width: 10)
            }
            .buttonStyle(.plain)
            .help(isExpanded
                  ? String(localized: "sidebar.worktreeGroup.collapse",
                           defaultValue: "Collapse worktree",
                           table: "TermLoop")
                  : String(localized: "sidebar.worktreeGroup.expand",
                           defaultValue: "Expand worktree",
                           table: "TermLoop"))

            TermLoopSidebarToken(
                label: "WORKTREE",
                iconSystemName: "arrow.triangle.branch",
                tone: .accent,
                emphasized: true
            )

            Text(branch)
                .font(TermLoopSidebarTheme.bodyMonoStrong)
                .foregroundStyle(Color.primary.opacity(0.92))
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 4)

            TermLoopSidebarToken(label: workspaceCountLabel, tone: .neutral)

            if let activityLabel {
                if activitySummary.dominantState == .running {
                    AgentPulseDot()
                        .padding(.leading, 2)
                } else {
                    Image(systemName: statusIconName)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(statusColor)
                        .padding(.leading, 2)
                }
                Text(activityLabel)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(statusColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isHovering ? Color.accentColor.opacity(0.1) : Color.accentColor.opacity(0.075))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.accentColor.opacity(0.12), lineWidth: 1)
                )
                .padding(.horizontal, 4)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            isExpanded.toggle()
        }
        .onHover { isHovering = $0 }
    }

    private var workspaceCountLabel: String {
        "\(workspaceCount) ws"
    }

    private var activityLabel: String? {
        var parts: [String] = []
        if activitySummary.errorCount > 0 {
            parts.append("\(activitySummary.errorCount) error")
        }
        if activitySummary.needsInputCount > 0 {
            parts.append("\(activitySummary.needsInputCount) input")
        }
        if activitySummary.runningCount > 0 {
            parts.append("\(activitySummary.runningCount) active")
        }
        if activitySummary.completedCount > 0 {
            parts.append("\(activitySummary.completedCount) done")
        }
        let joined = parts.joined(separator: " · ")
        return joined.isEmpty ? nil : joined
    }

    private var statusColor: Color {
        switch activitySummary.dominantState {
        case .running:
            return .orange
        case .needsInput:
            return .yellow
        case .completed:
            return .green
        case .error:
            return .red
        case .ready, .idle:
            return TermLoopSidebarTheme.dim
        }
    }

    private var statusIconName: String {
        switch activitySummary.dominantState {
        case .running:
            return "circle.fill"
        case .needsInput:
            return "bell.fill"
        case .completed:
            return "checkmark.circle.fill"
        case .error:
            return "exclamationmark.triangle.fill"
        case .ready, .idle:
            return "circle"
        }
    }
}

/// Small animated dot used to signal an active agent. Placed as an overlay
/// on a workspace row, or inline in a group header counter.
struct AgentPulseDot: View {
    @State private var pulsing: Bool = false

    private let color = Color(nsColor: NSColor(srgbRed: 0.486, green: 0.361, blue: 1.0, alpha: 1.0))

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(0.35), lineWidth: 1)
                .scaleEffect(pulsing ? 2.0 : 1.0)
                .opacity(pulsing ? 0.0 : 0.6)
            Circle()
                .fill(color)
        }
        .frame(width: 6, height: 6)
        .onAppear {
            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) {
                pulsing = true
            }
        }
    }
}

/// Vertical hairline spine drawn behind the child rows of a worktree group.
/// Keeps grouped rows visually connected without touching the row itself.
struct WorktreeGroupSpine: View {
    var body: some View {
        Rectangle()
            .fill(Color.accentColor.opacity(0.65))
            .frame(width: 2)
    }
}
