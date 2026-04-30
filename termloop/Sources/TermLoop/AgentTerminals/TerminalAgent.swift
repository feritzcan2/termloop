// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// A terminal-agent definition: a CLI executable that runs as the
/// foreground process of a workspace's agent pane. Distinct from
/// `AgentTemplate` (Claude-prompt orchestration) in `Sources/TermLoop/Agents/`.
struct TerminalAgent: Equatable, Hashable, Sendable {
    /// Stable agent-id for Claude Code. Centralized here so all bridge
    /// components refer to the same constant rather than bare strings.
    static let claudeId = "claude"

    /// Stable identifier stored in `Workspace.terminalAgentId`. Lowercase,
    /// no whitespace. Used as the persistence key.
    let id: String
    /// Human-readable name shown in pickers and tab titles.
    let displayName: String
    /// Optional asset-catalog image used for branded UI affordances.
    let iconAssetName: String?
    /// SF Symbol fallback used when no branded asset exists.
    let icon: String
    /// Sidebar status entry key used for this agent's live terminal state.
    let statusKey: String
    /// Bare executable name matched against `$PATH`.
    let executableName: String
    /// Arguments passed after the executable. Empty for v1 built-ins.
    let argv: [String]
    /// Whether this agent should launch via startup bootstrap scripts.
    let usesStartupBootstrap: Bool

    /// Full command string passed to `surfaceConfig.command`. Uses
    /// shell-safe quoting via `TerminalCommandQuoter`.
    func commandLine() -> String {
        TerminalCommandQuoter.join([executableName] + argv)
    }
}

/// Minimal shell-safe quoter — single-quotes any arg containing a special
/// character, otherwise passes through unchanged.
enum TerminalCommandQuoter {
    static func join(_ tokens: [String]) -> String {
        tokens.map(quote).joined(separator: " ")
    }
    static func quote(_ s: String) -> String {
        let special = CharacterSet(charactersIn: " \t\n\"'\\$`&|;()<>*?[]{}")
        if s.rangeOfCharacter(from: special) == nil { return s }
        let escaped = s.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }
}

@MainActor
struct TerminalAgentIconView: View {
    let agent: TerminalAgent?
    var size: CGFloat = 12

    var body: some View {
        Group {
            if let assetName = agent?.iconAssetName, !assetName.isEmpty {
                Image(assetName)
                    .resizable()
                    .interpolation(.high)
                    .antialiased(true)
                    .renderingMode(.original)
                    .scaledToFit()
            } else if let systemName = agent?.icon, !systemName.isEmpty {
                Image(systemName: systemName)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "questionmark.circle")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
    }
}

@MainActor
struct TerminalAgentTitleLabel: View {
    let agent: TerminalAgent
    var title: String? = nil
    var size: CGFloat = 12

    var body: some View {
        Label {
            Text(title ?? agent.displayName)
        } icon: {
            TerminalAgentIconView(agent: agent, size: size)
        }
    }
}
