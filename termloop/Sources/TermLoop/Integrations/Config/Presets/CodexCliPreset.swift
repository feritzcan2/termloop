// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct CodexCliPreset: IntegrationPreset {
    let id = "cli.codex"
    let kind: IntegrationKind = .cli
    let displayName = "codex"
    let summary = "OpenAI Codex CLI"
    let fields: [ConfigField] = [
        ConfigField(id: "apiKey", label: "OpenAI API Key", kind: .password, secret: true),
        ConfigField(id: "model", label: "Default model", kind: .text,
                    placeholder: "gpt-5-codex",
                    defaultValue: "gpt-5-codex"),
    ]

    func runPreview(values: [String: String]) async -> IntegrationTestResult {
        guard let bin = CLIDiscovery.findBinary(name: "codex",
                                                in: CLIDiscovery.pathDirectories()) else {
            return .failure("codex not on PATH")
        }
        let env = ["OPENAI_API_KEY": values["apiKey"] ?? ""]
        let (exit, output, ms) = await IntegrationTestSupport.run(
            command: bin.path, args: ["--version"], env: env, timeoutMs: 5_000
        )
        return IntegrationTestResult(success: exit == 0,
                                     message: output.trimmingCharacters(in: .whitespacesAndNewlines),
                                     durationMs: ms, capabilities: [], logPath: nil)
    }

    func persist(values: [String: String]) throws {
        try IntegrationConfigStore.shared.setSecret(
            presetId: id, key: "apiKey", value: values["apiKey"])
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "model", value: values["model"])
    }
}
