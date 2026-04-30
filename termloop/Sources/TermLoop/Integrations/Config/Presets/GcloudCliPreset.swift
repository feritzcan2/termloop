// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct GcloudCliPreset: IntegrationPreset {
    let id = "cli.gcloud"
    let kind: IntegrationKind = .cli
    let displayName = "gcloud"
    let summary = "Google Cloud CLI"
    let fields: [ConfigField] = [
        ConfigField(id: "project", label: "Project ID", kind: .text, placeholder: "my-project"),
    ]

    func runPreview(values: [String: String]) async -> IntegrationTestResult {
        guard let bin = CLIDiscovery.findBinary(name: "gcloud",
                                                in: CLIDiscovery.pathDirectories()) else {
            return .failure("gcloud not on PATH")
        }
        let (exit, output, ms) = await IntegrationTestSupport.run(
            command: bin.path, args: ["config", "get-value", "account"], timeoutMs: 5_000
        )
        return IntegrationTestResult(success: exit == 0,
                                     message: output.trimmingCharacters(in: .whitespacesAndNewlines),
                                     durationMs: ms, capabilities: [], logPath: nil)
    }

    func persist(values: [String: String]) throws {
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "project", value: values["project"])
    }
}
