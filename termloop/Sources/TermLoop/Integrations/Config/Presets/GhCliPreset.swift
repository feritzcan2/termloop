// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct GhCliPreset: IntegrationPreset {
    let id = "cli.gh"
    let kind: IntegrationKind = .cli
    let displayName = "gh"
    let summary = "GitHub CLI"
    let fields: [ConfigField] = [
        ConfigField(id: "token", label: "Personal Access Token", kind: .password, secret: true),
    ]

    func runPreview(values: [String: String]) async -> IntegrationTestResult {
        let env = ["GH_TOKEN": values["token"] ?? ""]
        guard let bin = CLIDiscovery.findBinary(name: "gh",
                                                in: CLIDiscovery.pathDirectories()) else {
            return .failure("gh not on PATH")
        }
        let (exit, output, ms) = await IntegrationTestSupport.run(
            command: bin.path, args: ["auth", "status"], env: env, timeoutMs: 5_000
        )
        return IntegrationTestResult(success: exit == 0,
                                     message: output.trimmingCharacters(in: .whitespacesAndNewlines),
                                     durationMs: ms, capabilities: [], logPath: nil)
    }

    func persist(values: [String: String]) throws {
        try IntegrationConfigStore.shared.setSecret(presetId: id, key: "token",
                                                    value: values["token"])
    }
}
