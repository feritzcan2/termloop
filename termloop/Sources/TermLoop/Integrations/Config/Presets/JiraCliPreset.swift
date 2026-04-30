// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct JiraCliPreset: IntegrationPreset {
    let id = "cli.jira"
    let kind: IntegrationKind = .cli
    let displayName = "jira"
    let summary = "Atlassian Jira CLI"
    let fields: [ConfigField] = [
        ConfigField(id: "server", label: "Jira server URL", kind: .text,
                    placeholder: "https://yourcompany.atlassian.net"),
        ConfigField(id: "login", label: "Login (email)", kind: .text,
                    placeholder: "feritzcan93@gmail.com"),
        ConfigField(id: "apiToken", label: "API Token", kind: .password, secret: true),
        ConfigField(id: "authType", label: "Auth type", kind: .select,
                    options: ["basic", "bearer"], defaultValue: "basic"),
    ]

    func runPreview(values: [String: String]) async -> IntegrationTestResult {
        guard let bin = CLIDiscovery.findBinary(name: "jira",
                                                in: CLIDiscovery.pathDirectories()) else {
            return .failure("jira not on PATH")
        }
        let env = [
            "JIRA_API_TOKEN": values["apiToken"] ?? "",
            "JIRA_SERVER": values["server"] ?? "",
            "JIRA_LOGIN": values["login"] ?? "",
            "JIRA_AUTH_TYPE": values["authType"] ?? "basic",
        ]
        let (exit, output, ms) = await IntegrationTestSupport.run(
            command: bin.path, args: ["me"], env: env, timeoutMs: 7_000
        )
        return IntegrationTestResult(success: exit == 0,
                                     message: output.trimmingCharacters(in: .whitespacesAndNewlines),
                                     durationMs: ms, capabilities: [], logPath: nil)
    }

    func persist(values: [String: String]) throws {
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "server", value: values["server"])
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "login", value: values["login"])
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "authType", value: values["authType"])
        try IntegrationConfigStore.shared.setSecret(
            presetId: id, key: "apiToken", value: values["apiToken"])
    }
}
