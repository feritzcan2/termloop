// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Global Codex `~/.codex/config.toml` management.
///
/// `ensureGlobalCodexConfigInstalled()` idempotently writes
/// root `codex_hooks = true` plus a canonical `[mcp_servers.termloop]`
/// section. Per-workspace
/// hooks.json writing has been removed — user-scope `~/.codex/hooks.json`
/// is the single source of truth now, owned by `ClaudeHookInstaller`'s
/// sibling in the CLI (`termloop codex install-hooks`).
enum TermLoopCodexHooks {
    private static let logger = Logger(subsystem: "com.termloop.fork", category: "codex-hooks")

    static func ensureGlobalCodexConfigInstalled() {
        do {
            try ensureFeatureFlagAndBuiltInMCP()
        } catch {
            logger.warning("codex config: failed to install built-in MCP (\(error.localizedDescription, privacy: .public))")
        }
    }

    // MARK: - config.toml

    /// Test seam: lets tests redirect the global `~/.codex/config.toml`
    /// write to a temp directory so test runs don't mutate the developer's
    /// real codex config. Production code never reads this.
    static var configHomeOverride: String?

    private static func ensureFeatureFlagAndBuiltInMCP() throws {
        let fm = FileManager.default
        let codexDir = configHomeOverride.map { "\($0)/.codex" } ?? resolvedCodexHomePath()
        let configPath = "\(codexDir)/config.toml"

        try fm.createDirectory(atPath: codexDir, withIntermediateDirectories: true)

        let original = (try? String(contentsOfFile: configPath, encoding: .utf8)) ?? ""
        let mutation = CodexConfigToml.installTransform(original)
        guard mutation.changed else { return }

        let latest = (try? String(contentsOfFile: configPath, encoding: .utf8)) ?? ""
        let latestMutation = latest == original ? mutation : CodexConfigToml.installTransform(latest)
        guard latestMutation.changed else { return }

        try latestMutation.content.write(
            toFile: configPath,
            atomically: true,
            encoding: .utf8
        )
    }

    #if DEBUG
    /// Test-only pure transform equivalent to the disk write path.
    internal static func applyToTomlContentForTesting(_ content: String) -> CodexConfigToml.Mutation {
        CodexConfigToml.installTransform(content)
    }
    #endif

    private static func resolvedCodexHomePath() -> String {
        if let override = ProcessInfo.processInfo.environment["CODEX_HOME"],
           !override.isEmpty {
            return NSString(string: override).expandingTildeInPath
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".codex")
    }
}
