// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct AwsCliPreset: IntegrationPreset {
    let id = "cli.aws"
    let kind: IntegrationKind = .cli
    let displayName = "aws"
    let summary = "AWS CLI"
    let fields: [ConfigField] = [
        ConfigField(id: "region", label: "Region", kind: .text, placeholder: "us-east-1"),
        ConfigField(id: "accessKeyId", label: "Access Key ID", kind: .password, secret: true),
        ConfigField(id: "secretAccessKey", label: "Secret Access Key", kind: .password, secret: true),
    ]

    func runPreview(values: [String: String]) async -> IntegrationTestResult {
        let env = [
            "AWS_DEFAULT_REGION": values["region"] ?? "us-east-1",
            "AWS_ACCESS_KEY_ID": values["accessKeyId"] ?? "",
            "AWS_SECRET_ACCESS_KEY": values["secretAccessKey"] ?? "",
        ]
        guard let bin = CLIDiscovery.findBinary(name: "aws",
                                                in: CLIDiscovery.pathDirectories()) else {
            return .failure("aws not on PATH")
        }
        let (exit, output, ms) = await IntegrationTestSupport.run(
            command: bin.path,
            args: ["sts", "get-caller-identity", "--output", "text"],
            env: env, timeoutMs: 5_000
        )
        return IntegrationTestResult(success: exit == 0,
                                     message: output.trimmingCharacters(in: .whitespacesAndNewlines),
                                     durationMs: ms, capabilities: [], logPath: nil)
    }

    func persist(values: [String: String]) throws {
        try IntegrationConfigStore.shared.setNonSecret(
            presetId: id, key: "region", value: values["region"])
        try IntegrationConfigStore.shared.setSecret(
            presetId: id, key: "accessKeyId", value: values["accessKeyId"])
        try IntegrationConfigStore.shared.setSecret(
            presetId: id, key: "secretAccessKey", value: values["secretAccessKey"])
    }
}
