// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Loop-tab recovery banner for the user-scope agent hooks that feed
/// TermLoop's session/activity state.
struct SidebarAgentHooksWarning: View {
    @ObservedObject private var claudeStatus = ClaudeHooksStatus.shared
    @ObservedObject private var codexStatus = CodexHooksStatus.shared

    @State private var isInstalling = false
    @State private var installErrorMessage: String?

    var body: some View {
        if !missingAgents.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.orange)
                    .frame(width: 16)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 3) {
                    Text(titleText)
                        .font(TermLoopSidebarTheme.bodyMonoStrong)
                        .foregroundStyle(Color.primary)
                        .lineLimit(2)

                    Text(subtitleText)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .fixedSize(horizontal: false, vertical: true)

                    if let installErrorMessage {
                        Text(installErrorMessage)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(Color.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 0)

                Button(action: installMissingHooks) {
                    HStack(spacing: 4) {
                        if isInstalling {
                            ProgressView()
                                .controlSize(.small)
                                .scaleEffect(0.65)
                                .frame(width: 12, height: 12)
                        } else {
                            Image(systemName: "arrow.down.circle.fill")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        Text(installButtonText)
                    }
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.accent)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(
                        Capsule(style: .continuous)
                            .fill(TermLoopSidebarTheme.accent.opacity(0.10))
                    )
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(TermLoopSidebarTheme.accent.opacity(0.18), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .disabled(isInstalling)
                .help(installHelpText)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Rectangle()
                    .fill(Color.orange.opacity(0.08))
            )
            .overlay(
                Rectangle()
                    .stroke(Color.orange.opacity(0.24), lineWidth: 1)
            )
            .help(tooltipText)
            .onAppear {
                claudeStatus.refreshIfStale()
                codexStatus.refreshIfStale()
            }
        }
    }

    private var missingAgents: [HookManagedAgent] {
        var agents: [HookManagedAgent] = []
        if !claudeStatus.installed {
            agents.append(.claude)
        }
        if !codexStatus.installed {
            agents.append(.codex)
        }
        return agents
    }

    private var titleText: String {
        switch missingAgents {
        case [.claude, .codex]:
            return String(
                localized: "sidebar.hooksWarning.title.both",
                defaultValue: "Claude/Codex hooks not installed",
                table: "TermLoop"
            )
        case [.claude]:
            return String(
                localized: "sidebar.hooksWarning.title.claude",
                defaultValue: "Claude hooks not installed",
                table: "TermLoop"
            )
        case [.codex]:
            return String(
                localized: "sidebar.hooksWarning.title.codex",
                defaultValue: "Codex hooks not installed",
                table: "TermLoop"
            )
        default:
            return String(
                localized: "sidebar.hooksWarning.title.generic",
                defaultValue: "Agent hooks not installed",
                table: "TermLoop"
            )
        }
    }

    private var subtitleText: String {
        String(
            localized: "sidebar.hooksWarning.subtitle",
            defaultValue: "Install hooks so The Loop can track agent sessions and requests.",
            table: "TermLoop"
        )
    }

    private var installButtonText: String {
        isInstalling
            ? String(localized: "sidebar.hooksWarning.installing", defaultValue: "Installing", table: "TermLoop")
            : String(localized: "sidebar.hooksWarning.install", defaultValue: "Install", table: "TermLoop")
    }

    private var installHelpText: String {
        String(
            localized: "sidebar.hooksWarning.install.help",
            defaultValue: "Install the missing TermLoop Claude and Codex hooks",
            table: "TermLoop"
        )
    }

    private var tooltipText: String {
        let paths = missingAgents
            .map { "\(displayName(for: $0)): \($0.userScopeSettingsPath)" }
            .joined(separator: "\n")
        return String(
            localized: "sidebar.hooksWarning.tooltip",
            defaultValue: "TermLoop cannot see required hooks in:\n\(paths)",
            table: "TermLoop"
        )
    }

    private func installMissingHooks() {
        guard !isInstalling else { return }
        let targets = missingAgents
        guard !targets.isEmpty else { return }

        isInstalling = true
        installErrorMessage = nil

        Task { @MainActor in
            var failed: [HookManagedAgent] = []
            for agent in targets {
                if !TermLoopHooks.ensureHooksInstalled(for: agent) {
                    failed.append(agent)
                }
            }

            claudeStatus.markDirty()
            codexStatus.markDirty()

            if failed.isEmpty {
                installErrorMessage = nil
            } else {
                let names = failed.map { displayName(for: $0) }.joined(separator: "/")
                installErrorMessage = String(
                    localized: "sidebar.hooksWarning.installFailed",
                    defaultValue: "\(names) hook install failed. Check config file permissions and try again.",
                    table: "TermLoop"
                )
            }
            isInstalling = false
        }
    }

    private func displayName(for agent: HookManagedAgent) -> String {
        switch agent {
        case .claude:
            return "Claude"
        case .codex:
            return "Codex"
        case .gemini:
            return "Gemini"
        }
    }
}
