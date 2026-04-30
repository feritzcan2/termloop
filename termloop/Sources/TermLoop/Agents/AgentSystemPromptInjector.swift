// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Single source of truth for "inject a per-invocation system / developer
/// prompt into an agent CLI." Terminal spawn paths resolve their extra argv
/// + prompt prefix through this helper so the user's system-prompt setting
/// behaves identically everywhere.
///
/// - claude: `--append-system-prompt "<text>"` (native flag).
/// - codex: `-c model_instructions_file="<path>"` — always via a tempfile.
///   Codex's `-c key=value` takes TOML; file path side-steps shell/TOML
///   quoting.
/// - gemini / opencode / unknown: no native per-invocation flag; we
///   prepend the text to the user's first turn via `promptPrefix`.
enum AgentSystemPromptInjector {
    enum DeliveryMode: String {
        case none
        case appendSystemPromptFlag
        case instructionsFile
        case promptPrefix
    }

    struct Resolution {
        let extraArgv: [String]
        let promptPrefix: String?
        /// Exact system-instruction text delivered to the agent transport.
        /// For claude/codex this is the flag/file contents; for prompt-prefix
        /// agents this is the literal prefixed text sent with the first turn.
        let deliveredSystemInstructions: String?
        let deliveryMode: DeliveryMode

        static let empty = Resolution(
            extraArgv: [],
            promptPrefix: nil,
            deliveredSystemInstructions: nil,
            deliveryMode: .none
        )
    }

    /// Per-invocation delivery mode for an agent's system prompt, independent
    /// of whether one is actually being sent. Callers (e.g. AskToBridgeLauncher)
    /// query this to decide whether to feed a target_prompt at all — for
    /// `.promptPrefix` agents any non-empty system prompt would land in the
    /// helper's first user turn and get "answered" before the real handoff.
    static func deliveryMode(forAgentId agentId: String) -> DeliveryMode {
        switch agentId {
        case "claude": return .appendSystemPromptFlag
        case "codex":  return .instructionsFile
        default:       return .promptPrefix
        }
    }

    static func resolve(agentId: String, systemPrompt: String?) throws -> Resolution {
        let userPrompt = systemPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !userPrompt.isEmpty else { return .empty }
        switch agentId {
        case "claude":
            return Resolution(
                extraArgv: ["--append-system-prompt", userPrompt],
                promptPrefix: nil,
                deliveredSystemInstructions: userPrompt,
                deliveryMode: .appendSystemPromptFlag
            )
        case "codex":
            let url = try writeInstructionsFile(userPrompt)
            return Resolution(
                extraArgv: ["-c", "model_instructions_file=\"\(url.path)\""],
                promptPrefix: nil,
                deliveredSystemInstructions: userPrompt,
                deliveryMode: .instructionsFile
            )
        default:
            // promptPrefix delivery types the text into the agent's first
            // user turn. Only honor an explicit user system prompt — bare
            // launches stay idle so the helper isn't tricked into "answering"
            // an auto-injected prefix before the real handoff arrives.
            let prefix = "System instructions for this session:\n\(userPrompt)\n\n---\n\n"
            return Resolution(
                extraArgv: [],
                promptPrefix: prefix,
                deliveredSystemInstructions: prefix,
                deliveryMode: .promptPrefix
            )
        }
    }

    private static func writeInstructionsFile(_ text: String) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("termloop-system-prompts", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fileURL = dir.appendingPathComponent("instructions-\(UUID().uuidString).md")
        try text.write(to: fileURL, atomically: true, encoding: .utf8)
        return fileURL
    }
}
