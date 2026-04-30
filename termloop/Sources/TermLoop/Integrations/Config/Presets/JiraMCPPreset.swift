// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct AtlassianMCPPreset: IntegrationPreset {
    let id = "mcp.atlassian"
    let kind: IntegrationKind = .mcp
    let displayName = "atlassian"
    let summary = "Atlassian MCP (Jira / Confluence / Compass)"
    let fields: [ConfigField] = [
        ConfigField(id: "server", label: "Jira server URL", kind: .text,
                    placeholder: "https://yourcompany.atlassian.net"),
        ConfigField(id: "email", label: "Email", kind: .text,
                    placeholder: "you@example.com"),
        ConfigField(id: "apiToken", label: "API Token", kind: .password, secret: true),
    ]

    func runPreview(values: [String: String]) async -> IntegrationTestResult {
        // No binary to probe yet — validation only.
        guard let server = values["server"], URL(string: server) != nil else {
            return .failure("invalid server URL")
        }
        guard !(values["apiToken"] ?? "").isEmpty else {
            return .failure("api token required")
        }
        return IntegrationTestResult(success: true,
                                     message: "fields validated",
                                     durationMs: 0,
                                     capabilities: [],
                                     logPath: nil)
    }

    func persist(values: [String: String]) throws {
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "server", value: values["server"])
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "email", value: values["email"])
        try IntegrationConfigStore.shared.setSecret(
            presetId: id, key: "apiToken", value: values["apiToken"])
        // Writing the MCP stanza to ~/.claude.json requires a separate
        // writer; leave as Keychain+config.json today so secrets are safe
        // and the user can hand-wire the MCP command in Claude config.
    }
}
