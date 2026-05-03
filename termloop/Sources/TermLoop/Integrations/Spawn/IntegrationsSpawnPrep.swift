// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Prepares per-spawn artifacts for attached integrations:
/// - Generates a temporary MCP config file with only selected servers.
/// - Resolves `${keychain:…}` placeholders into env vars at spawn time so
///   the file on disk never contains plaintext secrets.
/// - Produces a shell-command rewriter that injects CLI flags for agent
///   binaries it recognises (`claude`, `codex`, `aider`).
@MainActor
enum IntegrationsSpawnPrep {
    struct Prepared {
        let mcpConfigURL: URL?
        let envVars: [String: String]
        let attachedItemIds: [String]
        let workspaceTempDir: URL?

        func injectFlagsIfSupported(into shellCommand: String) -> String {
            guard let url = mcpConfigURL else { return shellCommand }
            let trimmed = shellCommand.trimmingCharacters(in: .whitespaces)
            let firstToken = trimmed.components(separatedBy: .whitespaces).first ?? ""
            switch firstToken {
            case "claude":
                // Claude picks up MCP config through the termloop wrapper's
                // merged --settings payload, not a direct CLI flag.
                return shellCommand
            case "codex":
                // Current codex CLI does not accept --mcp-config here.
                // Keep launch commands stable until we wire a TOML-based path.
                return shellCommand
            case "aider":
                return trimmed + " --mcp-config \"\(url.path)\""
            default:
                return shellCommand
            }
        }
    }

    static func prepare(
        items: [IntegrationItem],
        workspaceId: String,
        launchEnvironment: [String: String] = [:]
    ) -> Prepared {
        var env: [String: String] = [:]
        var mcpServers: [String: Any] = [:]
        var tempDir: URL?

        for item in items {
            switch item.kind {
            case .mcp:
                if let data = resolveMCPEntry(
                    item: item,
                    workspaceId: workspaceId,
                    launchEnvironment: launchEnvironment
                ) {
                    mcpServers[item.displayName] = data
                }
            case .webhook:
                let upperName = item.displayName
                    .uppercased()
                    .replacingOccurrences(of: "-", with: "_")
                env["TERMLOOP_WEBHOOK_\(upperName)_URL"] = item.summary
            case .agent, .cli, .claudeHook, .codexHook, .geminiHook:
                break
            }
        }

        var mcpURL: URL?
        if !mcpServers.isEmpty {
            let dir = NSTemporaryDirectory()
                .appending("termloop-integrations-\(workspaceId)/")
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            tempDir = URL(fileURLWithPath: dir, isDirectory: true)
            let file = tempDir!.appendingPathComponent("mcp-config.json")
            let payload: [String: Any] = ["mcpServers": mcpServers]
            if let data = try? JSONSerialization.data(withJSONObject: payload,
                                                      options: [.prettyPrinted]) {
                try? data.write(to: file)
                mcpURL = file
                env["CLAUDE_MCP_CONFIG"] = file.path
                env["CODEX_MCP_CONFIG"] = file.path
            }
        }

        return Prepared(
            mcpConfigURL: mcpURL,
            envVars: env,
            attachedItemIds: items.map(\.id),
            workspaceTempDir: tempDir
        )
    }

    static func cleanup(workspaceId: String) {
        let dir = NSTemporaryDirectory()
            .appending("termloop-integrations-\(workspaceId)")
        try? FileManager.default.removeItem(atPath: dir)
    }

    private static func resolveMCPEntry(
        item: IntegrationItem,
        workspaceId: String,
        launchEnvironment: [String: String]
    ) -> [String: Any]? {
        if item.source == .termLoop, item.displayName == TermLoopBuiltInMCP.serverName {
            return TermLoopBuiltInMCP.configEntry(
                workspaceId: workspaceId,
                launchEnvironment: launchEnvironment
            )
        }
        // Reload the backing `.mcp.json` / `~/.claude.json` entry for this
        // server and expand any `${keychain:…}` placeholders in string
        // values before writing the temp config.
        let sources: [URL] = {
            var urls: [URL] = []
            urls.append(FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".claude.json"))
            if case .projectScope(let url) = item.source { urls.insert(url, at: 0) }
            return urls
        }()

        for url in sources {
            guard let data = try? Data(contentsOf: url) else { continue }
            guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            let servers: [String: Any] = (root["mcpServers"] as? [String: Any]) ?? root
            if let entry = servers[item.displayName] as? [String: Any] {
                return expandPlaceholders(in: entry)
            }
        }
        return nil
    }

    private static func expandPlaceholders(in dict: [String: Any]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in dict {
            if let s = v as? String {
                out[k] = IntegrationConfigStore.shared.expandPlaceholders(in: s)
            } else if let arr = v as? [String] {
                out[k] = arr.map { IntegrationConfigStore.shared.expandPlaceholders(in: $0) }
            } else if let nested = v as? [String: Any] {
                out[k] = expandPlaceholders(in: nested)
            } else {
                out[k] = v
            }
        }
        return out
    }
}
