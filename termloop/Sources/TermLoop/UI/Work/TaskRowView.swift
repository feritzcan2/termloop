// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct TaskRowView: View {
    let task: TermLoopTask
    let workspaceCount: Int
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 8) {
                statusDot
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    Text(subtitleLine)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if !badgeLine.isEmpty {
                        Text(badgeLine)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(isSelected ? Color.accentColor.opacity(0.15) : .clear)
        }
        .buttonStyle(.plain)
    }

    private var subtitleLine: String {
        "\(task.branch) · \(workspaceCount) workspace\(workspaceCount == 1 ? "" : "s")"
    }

    private var badgeLine: String {
        var parts: [String] = []
        if let pr = task.prInfo {
            parts.append("PR #\(pr.number) • \(pr.state.rawValue)")
        }
        if let a = task.mergeState.aheadBy, let b = task.mergeState.behindBy {
            parts.append("ahead \(a) / behind \(b)")
        }
        return parts.joined(separator: "   ")
    }

    private var statusDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 8, height: 8)
            .padding(.top, 4)
    }

    private var dotColor: Color {
        switch task.status {
        case .idle: return .gray
        case .active: return .blue
        case .done: return .green
        case .archived: return .gray.opacity(0.4)
        }
    }
}
