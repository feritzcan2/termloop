// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionAbilityChip: View {
    let chip: QuickActionPreviewViewModel.Chip
    let onMuteToggle: () -> Void
    let onRevealInFile: () -> Void
    let onEdit: () -> Void
    let onDisablePermanently: () -> Void
    let onForceInclude: (Bool) -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(chip.ability.name)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
            if let sub = subBadge {
                Text(sub)
                    .font(.system(size: 9, weight: .semibold))
                    .padding(.horizontal, 3)
                    .padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.25))
                    .cornerRadius(3)
            }
            Button(action: onMuteToggle) {
                Image(systemName: chip.state == .mutedForRun ? "arrow.uturn.left" : "xmark")
                    .font(.system(size: 9, weight: .bold))
            }
            .buttonStyle(.plain)
            .help(muteHelp)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(background)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(border, lineWidth: 0.5)
        )
        .cornerRadius(6)
        .opacity(opacity)
        .italic(isDormant)
        .help(tooltip)
        .contextMenu {
            Button(String(localized: "quickAction.chip.edit",
                          defaultValue: "Edit ability…",
                          table: "TermLoop")) { onEdit() }
            Button(String(localized: "quickAction.chip.reveal",
                          defaultValue: "Reveal in Abilities sidebar",
                          table: "TermLoop")) { onRevealInFile() }
            Divider()
            if chip.ability.activation == .listed {
                Button(chip.state == .forceIncluded
                       ? String(localized: "quickAction.chip.stopForceInclude",
                                defaultValue: "Stop forcing include",
                                table: "TermLoop")
                       : String(localized: "quickAction.chip.forceInclude",
                                defaultValue: "Force include for this run",
                                table: "TermLoop")) {
                    onForceInclude(chip.state != .forceIncluded)
                }
            }
            Button(String(localized: "quickAction.chip.disablePermanently",
                          defaultValue: "Disable permanently…",
                          table: "TermLoop"),
                   role: .destructive) { onDisablePermanently() }
        }
    }

    private var subBadge: String? {
        switch chip.state {
        case .listed: return "ref"
        case .forceIncluded: return "force"
        case .worktreeDormant: return "worktree"
        default: return nil
        }
    }

    private var isDormant: Bool { chip.state == .worktreeDormant }

    private var opacity: Double {
        switch chip.state {
        case .mutedForRun: return 0.5
        case .worktreeDormant: return 0.6
        default: return 1.0
        }
    }

    private var background: Color {
        switch chip.state {
        case .active, .forceIncluded: return Color.accentColor.opacity(0.15)
        case .listed: return Color.secondary.opacity(0.10)
        case .mutedForRun: return Color.gray.opacity(0.10)
        case .worktreeDormant: return Color.secondary.opacity(0.08)
        }
    }

    private var border: Color {
        chip.state == .active || chip.state == .forceIncluded
            ? Color.accentColor.opacity(0.5)
            : Color.secondary.opacity(0.3)
    }

    private var muteHelp: String {
        chip.state == .mutedForRun
            ? String(localized: "quickAction.chip.restore",
                     defaultValue: "Restore for this run",
                     table: "TermLoop")
            : String(localized: "quickAction.chip.mute",
                     defaultValue: "Mute for this run (not persisted)",
                     table: "TermLoop")
    }

    private var tooltip: String {
        switch chip.state {
        case .active:
            return String(localized: "quickAction.chip.tooltip.active",
                          defaultValue: "Injected as full content.",
                          table: "TermLoop")
        case .listed:
            return String(localized: "quickAction.chip.tooltip.listed",
                          defaultValue: "Available on-demand. Claude will read the file if relevant.",
                          table: "TermLoop")
        case .worktreeDormant:
            return String(localized: "quickAction.chip.tooltip.dormant",
                          defaultValue: "Only active in worktrees. This run's cwd is not a worktree.",
                          table: "TermLoop")
        case .mutedForRun:
            return String(localized: "quickAction.chip.tooltip.muted",
                          defaultValue: "Muted for this run only. Not persisted.",
                          table: "TermLoop")
        case .forceIncluded:
            return String(localized: "quickAction.chip.tooltip.force",
                          defaultValue: "Force-included for this run — full body will be injected.",
                          table: "TermLoop")
        }
    }
}
