// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

@MainActor
struct AbilityCatalogRow: View {
    let title: String
    let summary: String
    let itemSummary: [String]
    let itemSections: [AbilityCatalogSection]
    let activation: AbilityActivation?
    let showsStarterBadge: Bool
    let assignedAgentTitle: String?
    let primaryActionLabel: String
    let onPrimaryAction: () -> Void
    let onSelect: () -> Void
    let isSelected: Bool
    let onOpenEditor: (() -> Void)?
    let onInstallOrReset: (() -> Void)?
    let installOrResetLabel: String?
    let onDelete: (() -> Void)?
    let onSetActivation: ((AbilityActivation) -> Void)?
    let onToggleActivation: (() -> Void)?

    private var counterTokens: [String] {
        itemSummary.prefix(3).map { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button(action: onSelect) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(title)
                            .font(TermLoopSidebarTheme.bodyMonoStrong)
                            .foregroundStyle(isSelected ? TermLoopSidebarTheme.accent : Color.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 6)
                        if showsStarterBadge {
                            TermLoopSidebarToken(label: "STARTER", tone: .muted)
                        }
                        if let activation, let onToggleActivation {
                            // Quick on/off shortcut. The dropdown menu next
                            // to it still owns the granular always/worktree/
                            // listed choice; this Toggle just ratchets
                            // between `.off` and the user's last non-off
                            // pick (tracked by AbilityStore).
                            Toggle("", isOn: Binding(
                                get: { activation != .off },
                                set: { _ in onToggleActivation() }
                            ))
                            .toggleStyle(.switch)
                            .controlSize(.mini)
                            .labelsHidden()
                            .help(activation == .off ? "Enable ability" : "Disable ability")
                        }
                        if let activation, let onSetActivation {
                            AbilityActivationMenu(activation: activation, onSelect: onSetActivation)
                        } else if let activation {
                            AbilityActivationBadge(activation: activation)
                        }
                    }

                    Text(summary)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)

                    if !counterTokens.isEmpty || assignedAgentTitle != nil {
                        HStack(spacing: 6) {
                            ForEach(counterTokens, id: \.self) { token in
                                TermLoopSidebarToken(label: token, tone: .neutral)
                            }
                            if assignedAgentTitle != nil {
                                TermLoopSidebarToken(label: "live", tone: .accent, emphasized: true)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .background(background)
            }
            .buttonStyle(.plain)

            HStack(spacing: 10) {
                Button(action: onPrimaryAction) {
                    Text(primaryActionLabel)
                        .font(TermLoopSidebarTheme.tinyMono)
                }
                .buttonStyle(.link)

                if let onOpenEditor {
                    Button(action: onOpenEditor) {
                        Text("Edit")
                            .font(TermLoopSidebarTheme.tinyMono)
                    }
                    .buttonStyle(.link)
                }

                if let onInstallOrReset, let installOrResetLabel {
                    Button(action: onInstallOrReset) {
                        Text(installOrResetLabel)
                            .font(TermLoopSidebarTheme.tinyMono)
                    }
                    .buttonStyle(.link)
                }

                Spacer(minLength: 4)

                if let assignedAgentTitle {
                    Text(assignedAgentTitle)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dimmer)
                        .lineLimit(1)
                }

                if let onDelete {
                    Button(action: onDelete) {
                        Text("Delete")
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(.link)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private var background: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(isSelected ? TermLoopSidebarTheme.activeBg : Color.primary.opacity(0.03))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(isSelected ? TermLoopSidebarTheme.accent.opacity(0.35) : TermLoopSidebarTheme.ruleStrong, lineWidth: 1)
            )
    }
}

struct AbilityActivationBadge: View {
    let activation: AbilityActivation

    var body: some View {
        Text(label)
            .font(TermLoopSidebarTheme.microCaps)
            .foregroundStyle(foreground)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(background)
            .overlay(border)
    }

    private var label: String {
        switch activation {
        case .always: return "ALWAYS"
        case .worktree: return "WORKTREE"
        case .listed: return "LISTED"
        case .off: return "OFF"
        }
    }

    private var foreground: Color {
        switch activation {
        case .always: return .white
        case .worktree: return TermLoopSidebarTheme.accent
        case .listed: return TermLoopSidebarTheme.dim
        case .off: return TermLoopSidebarTheme.dimmer
        }
    }

    private var background: some View {
        Rectangle()
            .fill(activation == .always ? TermLoopSidebarTheme.accent : Color.clear)
    }

    @ViewBuilder
    private var border: some View {
        if activation != .always {
            Rectangle()
                .stroke(
                    activation == .off
                        ? TermLoopSidebarTheme.dimmer.opacity(0.5)
                        : TermLoopSidebarTheme.accent.opacity(activation == .listed ? 0.4 : 1),
                    style: StrokeStyle(
                        lineWidth: 0.5,
                        dash: activation == .off ? [1.5, 1.5] : []
                    )
                )
        }
    }
}

private struct AbilityActivationMenu: View {
    let activation: AbilityActivation
    let onSelect: (AbilityActivation) -> Void

    var body: some View {
        Menu {
            ForEach(AbilityActivation.allCases, id: \.self) { mode in
                Button(action: { onSelect(mode) }) {
                    if mode == activation {
                        Text("\(label(for: mode))  ✓")
                    } else {
                        Text(label(for: mode))
                    }
                }
            }
        } label: {
            AbilityActivationBadge(activation: activation)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private func label(for activation: AbilityActivation) -> String {
        switch activation {
        case .always: return "Always"
        case .worktree: return "Worktree"
        case .listed: return "Listed"
        case .off: return "Off"
        }
    }
}
