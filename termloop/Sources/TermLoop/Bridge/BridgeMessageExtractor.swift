// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

// termloop/Sources/TermLoop/Bridge/BridgeMessageExtractor.swift
import Foundation

/// v1: dispatches last-assistant-message extraction to ClaudeSessionScanner,
/// CodexSessionScanner, and GeminiSessionScanner. Unsupported agent ids
/// return nil as a defensive safeguard — UI/runtime validation should have
/// filtered them already.
final class BridgeMessageExtractor {
    static let shared = BridgeMessageExtractor()

    struct AssistantMessageSnapshot: Equatable {
        let text: String
    }

    private let claudeScanner: ClaudeSessionScanner
    private let codexScanner: CodexSessionScanner
    private let geminiScanner: GeminiSessionScanner

    init(
        claudeScanner: ClaudeSessionScanner = ClaudeSessionScanner.shared,
        codexScanner: CodexSessionScanner = CodexSessionScanner.shared,
        geminiScanner: GeminiSessionScanner = GeminiSessionScanner.shared
    ) {
        self.claudeScanner = claudeScanner
        self.codexScanner = codexScanner
        self.geminiScanner = geminiScanner
    }

    func lastAssistantMessage(agentId: String, sessionId: String?, cwd: String, newerThan: Date? = nil) -> String? {
        assistantMessageSnapshot(agentId: agentId, sessionId: sessionId, cwd: cwd, newerThan: newerThan)?.text
    }

    /// `newerThan` restricts the session-less cwd fallback to files modified
    /// at or after the given date. Bridges pass `bridge.createdAt` so pre-existing
    /// agent sessions in the shared cwd (e.g. the user's main Claude/Codex
    /// session running in the source workspace's directory) cannot be picked
    /// up as the helper's response.
    func assistantMessageSnapshot(
        agentId: String,
        sessionId: String?,
        cwd: String,
        newerThan: Date? = nil
    ) -> AssistantMessageSnapshot? {
        switch agentId {
        case TerminalAgent.claudeId:
            if let sessionId, !sessionId.isEmpty {
                return claudeScanner.assistantMessageSnapshot(sessionId: sessionId, cwd: cwd)
                    .map { AssistantMessageSnapshot(text: $0.text) }
            }
            return claudeScanner.assistantMessageSnapshot(cwd: cwd, newerThan: newerThan)
                .map { AssistantMessageSnapshot(text: $0.text) }
        case "codex":
            if let sessionId, !sessionId.isEmpty {
                return codexScanner.assistantMessageSnapshot(sessionId: sessionId, cwd: cwd)
                    .map { AssistantMessageSnapshot(text: $0.text) }
            }
            return codexScanner.assistantMessageSnapshot(cwd: cwd, newerThan: newerThan)
                .map { AssistantMessageSnapshot(text: $0.text) }
        case "gemini":
            if let sessionId, !sessionId.isEmpty {
                return geminiScanner.assistantMessageSnapshot(sessionId: sessionId, cwd: cwd)
                    .map { AssistantMessageSnapshot(text: $0.text) }
            }
            return geminiScanner.assistantMessageSnapshot(cwd: cwd, newerThan: newerThan)
                .map { AssistantMessageSnapshot(text: $0.text) }
        default:                     return nil
        }
    }
}
