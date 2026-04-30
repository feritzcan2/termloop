// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Allowlist of agent ids whose sessions can host a curator fork. The
/// termloop MCP server (which exposes `context_bank_propose_suggestion`
/// and `context_bank_finalize_run`) is available for Claude and Codex
/// sessions today; Gemini will join once its MCP config surfaces wire up
/// the same tools.
enum AssistantSessionScannerRegistry {
    private static let supportedAgentIds: Set<String> = [
        "claude",
        "codex",
    ]

    static func supports(agentId: String) -> Bool {
        supportedAgentIds.contains(agentId)
    }
}
