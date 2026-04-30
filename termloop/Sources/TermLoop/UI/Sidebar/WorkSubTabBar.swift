// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

enum WorkSubTab: String, CaseIterable, Identifiable {
    case loop
    case contextBank
    case agents
    case tasks

    static let storageKey = "termloop.workSubTab"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .loop:
            return String(localized: "sidebar.workSubTab.loop",
                          defaultValue: "Loop",
                          table: "TermLoop")
        case .contextBank:
            return String(localized: "sidebar.workSubTab.contextBank",
                          defaultValue: "Context",
                          table: "TermLoop")
        case .agents:
            return String(localized: "sidebar.workSubTab.abilities",
                          defaultValue: "Abilities",
                          table: "TermLoop")
        case .tasks:
            return String(localized: "sidebar.workSubTab.tasks",
                          defaultValue: "Tasks",
                          table: "TermLoop")
        }
    }

    var helpTitle: String {
        switch self {
        case .loop:
            return String(localized: "sidebar.workSubTab.loop.help",
                          defaultValue: "The Loop",
                          table: "TermLoop")
        case .contextBank:
            return String(localized: "sidebar.workSubTab.contextBank.help",
                          defaultValue: "Context Bank — curated CLAUDE.md / AGENTS.md",
                          table: "TermLoop")
        case .agents:
            return title
        case .tasks:
            return title
        }
    }

    var iconSystemName: String {
        switch self {
        case .loop: return "arrow.trianglehead.2.clockwise.rotate.90"
        case .contextBank: return "books.vertical"
        case .agents: return "person.2"
        case .tasks: return "checklist"
        }
    }
}

struct WorkSubTabBar: View {
    @Binding var selection: WorkSubTab
    let tasksBadgeCount: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(WorkSubTab.allCases) { tab in
                WorkSubTabButton(
                    tab: tab,
                    isSelected: selection == tab,
                    tasksBadgeCount: tasksBadgeCount
                ) {
                    selection = tab
                }
            }
        }
        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(TermLoopSidebarTheme.rule)
                .frame(height: 1)
        }
    }
}

private struct WorkSubTabButton: View {
    let tab: WorkSubTab
    let isSelected: Bool
    let tasksBadgeCount: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: tab.iconSystemName)
                    .font(.system(size: 13, weight: .semibold))
                Text(verbatim: tab.title)
                    .font(TermLoopSidebarTheme.bodyMonoStrong)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .padding(.horizontal, 6)
            .background(backgroundShape.fill(backgroundColor))
            .overlay(backgroundShape.stroke(borderColor, lineWidth: 1))
            .overlay(alignment: .topTrailing) {
                if tab == .tasks, tasksBadgeCount > 0 {
                    TermLoopSidebarToken(
                        label: "\(tasksBadgeCount)",
                        tone: isSelected ? .accent : .neutral,
                        emphasized: true
                    )
                    .padding(.top, 4)
                    .padding(.trailing, 4)
                }
            }
            .foregroundStyle(isSelected ? Color.primary : TermLoopSidebarTheme.dim)
            .contentShape(backgroundShape)
        }
        .buttonStyle(.plain)
        .help(tab.helpTitle)
        .accessibilityLabel(tab.helpTitle)
    }

    private var backgroundShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
    }

    private var backgroundColor: Color {
        isSelected ? TermLoopSidebarTheme.activeBg : Color.primary.opacity(0.025)
    }

    private var borderColor: Color {
        isSelected ? TermLoopSidebarTheme.accent.opacity(0.24) : TermLoopSidebarTheme.ruleStrong
    }
}
