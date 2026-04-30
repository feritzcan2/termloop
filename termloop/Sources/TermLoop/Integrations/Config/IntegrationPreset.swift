// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct ConfigField: Identifiable, Hashable {
    enum Kind: String, Hashable {
        case text
        case password
        case select
        case path
        case toggle
    }

    let id: String
    let label: String
    let kind: Kind
    let secret: Bool
    let placeholder: String?
    let options: [String]
    let defaultValue: String?

    init(id: String, label: String, kind: Kind,
         secret: Bool = false, placeholder: String? = nil,
         options: [String] = [], defaultValue: String? = nil) {
        self.id = id
        self.label = label
        self.kind = kind
        self.secret = secret
        self.placeholder = placeholder
        self.options = options
        self.defaultValue = defaultValue
    }
}

/// A preset captures the knowledge required to test, configure, and persist
/// a specific integration (e.g. wrangler, atlassian, Linear webhook).
protocol IntegrationPreset: Sendable {
    var id: String { get }
    var kind: IntegrationKind { get }
    var displayName: String { get }
    var summary: String { get }
    var fields: [ConfigField] { get }

    /// Preview-test invoked from the config sheet with unpersisted values.
    func runPreview(values: [String: String]) async -> IntegrationTestResult

    /// Persist the configured values. Must split secrets into Keychain and
    /// non-secrets into `config.json`, emitting `${keychain:<preset>:<key>}`
    /// placeholders where necessary.
    func persist(values: [String: String]) throws
}

enum IntegrationPresetRegistry {
    static let all: [IntegrationPreset] = [
        AppInsightsLogsCliPreset(),
        WranglerPreset(),
        GhCliPreset(),
        AwsCliPreset(),
        GcloudCliPreset(),
        CodexCliPreset(),
        GeminiCliPreset(),
        JiraCliPreset(),
        AtlassianMCPPreset(),
    ]

    static func preset(id: String) -> IntegrationPreset? {
        all.first { $0.id == id }
    }

    static func presets(for kind: IntegrationKind) -> [IntegrationPreset] {
        all.filter { $0.kind == kind }
    }
}

struct AppInsightsLogsCliPreset: IntegrationPreset {
    let id = "cli.app-insights-logs"
    let kind: IntegrationKind = .cli
    let displayName = "app-insights-logs"
    let summary = "Azure CLI Application Insights query"
    let fields: [ConfigField] = [
        ConfigField(id: "subscription", label: "Subscription", kind: .text,
                    placeholder: "My Subscription"),
        ConfigField(id: "resourceGroup", label: "Resource Group", kind: .text,
                    placeholder: "rg-observability"),
        ConfigField(id: "app", label: "Application Insights app", kind: .text,
                    placeholder: "my-app-insights"),
    ]

    func runPreview(values: [String: String]) async -> IntegrationTestResult {
        guard let bin = CLIDiscovery.findBinary(name: "az",
                                                in: CLIDiscovery.pathDirectories()) else {
            return .failure("az not on PATH")
        }

        let (authExit, authOutput, authMs) = await IntegrationTestSupport.run(
            command: bin.path,
            args: ["account", "show", "--query", "user.name", "-o", "tsv"],
            timeoutMs: 5_000
        )
        let authTrimmed = authOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard authExit == 0, !authTrimmed.isEmpty else {
            return .failure(authTrimmed.isEmpty ? "run `az login` first" : authTrimmed,
                            durationMs: authMs)
        }

        let (extExit, _, extMs) = await IntegrationTestSupport.run(
            command: bin.path,
            args: ["extension", "show", "-n", "application-insights", "--query", "name", "-o", "tsv"],
            timeoutMs: 5_000
        )
        guard extExit == 0 else {
            return .failure("run `az extension add -n application-insights` first",
                            durationMs: authMs + extMs)
        }

        let subscription = values["subscription"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resourceGroup = values["resourceGroup"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let app = values["app"]?.trimmingCharacters(in: .whitespacesAndNewlines)

        if let subscription, !subscription.isEmpty {
            let (subExit, subOutput, subMs) = await IntegrationTestSupport.run(
                command: bin.path,
                args: ["account", "show", "--query", "name", "-o", "tsv"],
                timeoutMs: 5_000
            )
            let subTrimmed = subOutput.trimmingCharacters(in: .whitespacesAndNewlines)
            guard subExit == 0 else {
                return .failure(subTrimmed.isEmpty ? "could not verify current subscription" : subTrimmed,
                                durationMs: authMs + extMs + subMs)
            }
        }

        if let resourceGroup, !resourceGroup.isEmpty, let app, !app.isEmpty {
            let (appExit, appOutput, appMs) = await IntegrationTestSupport.run(
                command: bin.path,
                args: ["monitor", "app-insights", "component", "show",
                       "--app", app,
                       "--resource-group", resourceGroup,
                       "--query", "name", "-o", "tsv"],
                timeoutMs: 7_000
            )
            let appTrimmed = appOutput.trimmingCharacters(in: .whitespacesAndNewlines)
            guard appExit == 0 else {
                return .failure(appTrimmed.isEmpty ? "could not query Application Insights resource" : appTrimmed,
                                durationMs: authMs + extMs + appMs)
            }
            return IntegrationTestResult(success: true,
                                         message: "authenticated as \(authTrimmed) · app \(appTrimmed)",
                                         durationMs: authMs + extMs + appMs,
                                         capabilities: ["az monitor app-insights query"],
                                         logPath: nil)
        }

        return IntegrationTestResult(success: true,
                                     message: "authenticated as \(authTrimmed) · extension installed",
                                     durationMs: authMs + extMs,
                                     capabilities: ["az monitor app-insights query"],
                                     logPath: nil)
    }

    func persist(values: [String: String]) throws {
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "subscription", value: values["subscription"])
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "resourceGroup", value: values["resourceGroup"])
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "app", value: values["app"])
    }
}
