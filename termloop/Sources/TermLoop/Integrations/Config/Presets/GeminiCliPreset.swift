// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct GeminiCliPreset: IntegrationPreset {
    let id = "cli.gemini"
    let kind: IntegrationKind = .agent
    let displayName = "gemini"
    let summary = "Google Gemini CLI"
    let fields: [ConfigField] = [
        ConfigField(id: "apiKey", label: "Google AI / Gemini API Key",
                    kind: .password, secret: true),
        ConfigField(id: "model", label: "Default model", kind: .text,
                    placeholder: "gemini-2.5-pro",
                    defaultValue: "gemini-2.5-pro"),
    ]

    func runPreview(values: [String: String]) async -> IntegrationTestResult {
        guard let bin = CLIDiscovery.findBinary(name: "gemini",
                                                in: CLIDiscovery.pathDirectories()) else {
            return .failure("gemini not on PATH")
        }
        let env = ["GEMINI_API_KEY": values["apiKey"] ?? "",
                   "GOOGLE_API_KEY": values["apiKey"] ?? ""]
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
