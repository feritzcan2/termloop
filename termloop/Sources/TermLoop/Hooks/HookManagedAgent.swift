// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Agents whose hooks TermLoop owns and keeps in user-scope config.
///
/// Raw values match the existing agent id strings used in
/// `TerminalAgent` / `WorkspaceMetadataStore.terminalAgentId`, so
/// mapping from an `agent.id: String` uses `HookManagedAgent(rawValue:)`.
enum HookManagedAgent: String, CaseIterable {
    case claude
    case codex
    case gemini

    /// User-scope settings/config file for this agent's hook entries.
    /// Absolute path resolved against `$HOME`.
    var userScopeSettingsPath: String {
        let home = NSHomeDirectory() as NSString
        switch self {
        case .claude: return home.appendingPathComponent(".claude/settings.json")
        case .codex:
            if let override = ProcessInfo.processInfo.environment["CODEX_HOME"],
               !override.isEmpty {
                return (NSString(string: override).expandingTildeInPath as NSString)
                    .appendingPathComponent("hooks.json")
            }
            return home.appendingPathComponent(".codex/hooks.json")
        case .gemini: return home.appendingPathComponent(".gemini/settings.json")
        }
    }

    /// Command marker substring used to identify TermLoop-owned entries
    /// in both user-scope and project-scope config files.
    var stableCommandMarker: String {
        switch self {
        case .claude: return "claude-hook"
        case .codex:  return "codex-hook"
        case .gemini: return "gemini-hook"
        }
    }

    /// Env-var name that disables this agent's hooks individually.
    /// Combined with the global `TERMLOOP_HOOKS_DISABLED` check.
    var perAgentDisableEnvVar: String {
        switch self {
        case .claude: return "TERMLOOP_CLAUDE_HOOKS_DISABLED"
        case .codex:  return "TERMLOOP_CODEX_HOOKS_DISABLED"
        case .gemini: return "TERMLOOP_GEMINI_HOOKS_DISABLED"
        }
    }
}
