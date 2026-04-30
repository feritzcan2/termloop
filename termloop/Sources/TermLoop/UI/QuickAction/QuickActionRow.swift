// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionRowView: View {
    let kind: QuickActionRowKind
    let isSelected: Bool
    let isDisabled: Bool
    let disabledReason: String?
    let searchText: String

    var body: some View {
        HStack(spacing: 10) {
            Text(icon)
                .font(.system(size: 16))
                .frame(width: 22, alignment: .center)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(isDisabled ? .secondary : .primary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if isSelected {
                Text("↵")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.18) : Color.clear)
        )
        .contentShape(Rectangle())
        .help(disabledReason ?? "")
    }

    // MARK: Content

    private var icon: String {
        switch kind {
        case .template(let t):
            return t.icon.isEmpty ? "⚡" : t.icon
        case .freePrompt:
            return "🤖"
        }
    }

    private var title: String {
        switch kind {
        case .template(let t):
            return t.name
        case .freePrompt:
            let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return String(
                    localized: "quickAction.freePromptRow.placeholder",
                    defaultValue: "Run as free prompt…",
                    table: "TermLoop"
                )
            }
            return String(
                localized: "quickAction.freePromptRow.filled",
                defaultValue: "Run as free prompt: \"\(trimmed)\"",
                table: "TermLoop"
            )
        }
    }

    private var subtitle: String {
        switch kind {
        case .template(let t):
            return t.description
        case .freePrompt(let resolvedId):
            let name = resolvedId ?? "—"
            return String(
                localized: "quickAction.freePromptRow.subtitle",
                defaultValue: "Runs against \(name)",
                table: "TermLoop"
            )
        }
    }
}
