// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation

/// Source of truth for known terminal agents. Built-in for v1; user-defined
/// entries are out of scope.
@MainActor
final class TerminalAgentRegistry: ObservableObject {
    static let shared = TerminalAgentRegistry()

    @Published private(set) var agents: [TerminalAgent]

    private init() {
        self.agents = TerminalAgentRegistry.builtIn
    }

    static let builtIn: [TerminalAgent] = [
        TerminalAgent(
            id: "claude",
            displayName: "Claude Code",
            iconAssetName: "AgentIconClaude",
            icon: "sparkle",
            statusKey: "claude_code",
            executableName: "claude",
            argv: ["--dangerously-skip-permissions"],
            usesStartupBootstrap: true
        ),
        TerminalAgent(
            id: "codex",
            displayName: "Codex CLI",
            iconAssetName: "AgentIconCodex",
            icon: "chevron.left.forwardslash.chevron.right",
            statusKey: "codex",
            executableName: "codex",
            argv: ["--dangerously-bypass-approvals-and-sandbox"],
            usesStartupBootstrap: true
        ),
        TerminalAgent(
            id: "gemini",
            displayName: "Gemini CLI",
            iconAssetName: "AgentIconGemini",
            icon: "sparkles",
            statusKey: "gemini",
            executableName: "gemini",
            argv: [],
            usesStartupBootstrap: false
        ),
        TerminalAgent(
            id: "opencode",
            displayName: "OpenCode",
            iconAssetName: nil,
            icon: "terminal",
            statusKey: "opencode",
            executableName: "opencode",
            argv: [],
            usesStartupBootstrap: false
        ),
    ]

    func agent(id: String) -> TerminalAgent? {
        agents.first { $0.id == id }
    }

    var statusKeys: Set<String> {
        Set(agents.map(\.statusKey))
    }

}
