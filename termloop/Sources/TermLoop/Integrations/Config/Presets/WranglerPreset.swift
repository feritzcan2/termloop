// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct WranglerPreset: IntegrationPreset {
    let id = "cli.wrangler"
    let kind: IntegrationKind = .cli
    let displayName = "wrangler"
    let summary = "Cloudflare Workers"
    let fields: [ConfigField] = [
        ConfigField(id: "accountId", label: "Account ID", kind: .text,
                    placeholder: "00000000000000000000000000000000"),
        ConfigField(id: "apiToken", label: "API Token", kind: .password,
                    secret: true),
    ]

    func runPreview(values: [String: String]) async -> IntegrationTestResult {
        let env: [String: String] = [
            "CLOUDFLARE_API_TOKEN": values["apiToken"] ?? "",
            "CLOUDFLARE_ACCOUNT_ID": values["accountId"] ?? "",
        ]
        guard let bin = CLIDiscovery.findBinary(name: "wrangler",
                                                in: CLIDiscovery.pathDirectories()) else {
            return .failure("wrangler not on PATH")
        }
        let (exit, output, ms) = await IntegrationTestSupport.run(
            command: bin.path, args: ["whoami"], env: env, timeoutMs: 5_000
        )
        return IntegrationTestResult(success: exit == 0,
                                     message: output.trimmingCharacters(in: .whitespacesAndNewlines),
                                     durationMs: ms, capabilities: [], logPath: nil)
    }

    func persist(values: [String: String]) throws {
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "accountId", value: values["accountId"])
        try IntegrationConfigStore.shared.setSecret(
            presetId: id, key: "apiToken", value: values["apiToken"])
    }
}
