// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// TermLoop-curated baseline that ships with the starter and goes to the
/// agent verbatim on every run of this ability. User can edit, but the
/// expectation is that customization happens in `instructions.md` instead.
@MainActor
struct AbilitySystemReminderCard: View {
    let ability: Ability
    let onEditSource: () -> Void

    private var systemReminderURL: URL {
        ability.metadataFilePath
            .deletingLastPathComponent()
            .appendingPathComponent(AbilityBundleManifest.systemReminderFile)
    }

    private var trimmedBody: String {
        ability.systemReminderBody?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var subtitle: String {
        switch ability.activation {
        case .worktree:
            return "Goes to the agent verbatim — only when running inside a worktree."
        default:
            return "Goes to the agent verbatim on every run of this ability."
        }
    }

    var body: some View {
        AbilityDetailCard(
            title: "System reminder",
            subtitle: subtitle
        ) {
            if trimmedBody.isEmpty {
                Text("No baseline reminder set.")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
            } else {
                MarkdownRenderer(content: trimmedBody)
            }
        } footer: {
            Button("Edit source", action: onEditSource)
                .buttonStyle(.borderless)
        }
    }
}
