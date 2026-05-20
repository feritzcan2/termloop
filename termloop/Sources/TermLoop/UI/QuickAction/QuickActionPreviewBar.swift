// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionPreviewBar: View {
    @ObservedObject var preview: QuickActionPreviewViewModel
    let hasTarget: Bool
    let onOpenAdvancedPreview: () -> Void
    let onEditAbility: (Ability) -> Void
    let onRevealAbility: (Ability) -> Void
    let onDisablePermanently: (Ability) -> Void

    private let chipOverflowLimit = 4

    var body: some View {
        HStack(spacing: 8) {
            badge
            Divider().frame(height: 14)
            if !hasTarget {
                Text(String(localized: "quickAction.preview.noTarget",
                            defaultValue: "Select a target to see what will be sent.",
                            table: "TermLoop"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } else if preview.visibleChips.isEmpty {
                Text(String(localized: "quickAction.preview.noAbilities",
                            defaultValue: "No project rules · ",
                            table: "TermLoop"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Button(String(localized: "quickAction.preview.advanced",
                              defaultValue: "Advanced",
                              table: "TermLoop")) { onOpenAdvancedPreview() }
                    .buttonStyle(.link)
                    .font(.system(size: 11))
            } else {
                chipRow
                if !preview.mutedIds.isEmpty {
                    mutedRestoreRow
                }
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
    }

    private var badge: some View {
        Button(action: onOpenAdvancedPreview) {
            HStack(spacing: 3) {
                Image(systemName: "puzzlepiece.extension")
                    .font(.system(size: 10))
                Text(String(
                    localized: "quickAction.preview.advanced",
                    defaultValue: "Advanced",
                    table: "TermLoop"
                ))
                .font(.system(size: 10, weight: .semibold))
                Text("\(preview.effectiveInjected.count)")
                    .font(.system(size: 11, weight: .semibold))
                Text(preview.isWorktree ? "· worktree" : "· project")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .opacity(hasTarget ? 1.0 : 0.4)
    }

    private var chipRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                let shown = Array(preview.visibleChips.prefix(chipOverflowLimit))
                ForEach(shown) { chip in
                    QuickActionAbilityChip(
                        chip: chip,
                        onMuteToggle: { preview.togglePerRunMute(chip.id) },
                        onRevealInFile: { onRevealAbility(chip.ability) },
                        onEdit: { onEditAbility(chip.ability) },
                        onDisablePermanently: { onDisablePermanently(chip.ability) },
                        onForceInclude: { include in
                            preview.setForceInclude(chip.id, include: include)
                        }
                    )
                }
                let overflow = preview.visibleChips.count - shown.count
                if overflow > 0 {
                    Button(action: onOpenAdvancedPreview) {
                        Text("+\(overflow) more")
                            .font(.system(size: 11, weight: .medium))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.secondary.opacity(0.12))
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var mutedRestoreRow: some View {
        Button(action: { preview.clearPerRunMutes() }) {
            Text(String(localized: "quickAction.preview.restoreMuted",
                        defaultValue: "\(preview.mutedIds.count) muted · Restore",
                        table: "TermLoop"))
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
    }
}
