// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Rendered in the main pane when the active project has no workspace to
/// surface — either it owns zero workspaces, or `selectedTabId` is stale
/// (still pointing at a workspace from a previous project right after a
/// switch). Promotes the Quick Action shortcut as the primary entry into
/// the app since that is how every workspace, ability, and command flow
/// gets kicked off.
@MainActor
struct MainAreaProjectEmptyState: View {
    var body: some View {
        VStack {
            Spacer()
            QuickActionShortcutBanner()
                .frame(maxWidth: 420)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

@MainActor
private struct QuickActionShortcutBanner: View {
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.up.square.fill")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 2) {
                Text(
                    String(
                        localized: "mainArea.empty.quickAction.title",
                        defaultValue: "Just Shift+Shift!",
                        table: "TermLoop"
                    )
                )
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.primary)

                Text(
                    String(
                        localized: "mainArea.empty.quickAction.subtitle",
                        defaultValue: "Double-tap Shift to open Quick Action.",
                        table: "TermLoop"
                    )
                )
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Button {
                QuickActionController.shared.present()
            } label: {
                Text(
                    String(
                        localized: "mainArea.empty.quickAction.try",
                        defaultValue: "Try",
                        table: "TermLoop"
                    )
                )
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .background(
                    Capsule().stroke(Color.accentColor, lineWidth: 1)
                )
                .foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.6))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
    }
}
