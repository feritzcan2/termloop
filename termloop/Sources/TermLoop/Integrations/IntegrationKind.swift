// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum IntegrationKind: String, CaseIterable, Codable, Hashable {
    case agent
    case mcp
    case cli
    case webhook
    case claudeHook
    case codexHook
    case geminiHook

    var displayTitle: String {
        switch self {
        case .agent:
            return String(localized: "integrations.category.agent",
                          defaultValue: "Agents", table: "TermLoop")
        case .mcp:
            return String(localized: "integrations.category.mcp",
                          defaultValue: "MCP", table: "TermLoop")
        case .cli:
            return String(localized: "integrations.category.cli",
                          defaultValue: "CLI", table: "TermLoop")
        case .webhook:
            return String(localized: "integrations.category.webhook",
                          defaultValue: "Webhooks", table: "TermLoop")
        case .claudeHook:
            return String(localized: "integrations.category.claudeHook",
                          defaultValue: "Claude Hooks", table: "TermLoop")
        case .codexHook:
            return String(localized: "integrations.category.codexHook",
                          defaultValue: "Codex Hooks", table: "TermLoop")
        case .geminiHook:
            return String(localized: "integrations.category.geminiHook",
                          defaultValue: "Gemini Hooks", table: "TermLoop")
        }
    }

    var shortTag: String {
        switch self {
        case .agent: return "AGENT"
        case .mcp: return "MCP"
        case .cli: return "CLI"
        case .webhook: return "HOOK"
        case .claudeHook: return "CHOOK"
        case .codexHook: return "XHOOK"
        case .geminiHook: return "GHOOK"
        }
    }

    var orderIndex: Int {
        switch self {
        case .agent: return 0
        case .mcp: return 1
        case .cli: return 2
        case .webhook: return 3
        case .claudeHook: return 4
        case .codexHook: return 5
        case .geminiHook: return 6
        }
    }
}
