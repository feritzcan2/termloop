// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Per-workspace `~/.claude.json` MCP injection.
///
/// `installProjectMCPServers(workspaceCwd:mcpConfigURL:)` merges MCP
/// server entries into `projects["<cwd>"].mcpServers` so Claude Code
/// sees TermLoop-provided MCP servers for the active workspace.
///
/// Hook injection (SessionStart / Stop / etc.) has moved to user-scope
/// ownership via `ClaudeHookInstaller` + `UserScopeHookSync`.
enum TermLoopClaudeHooks {
    private static let logger = Logger(subsystem: "com.termloop.fork", category: "claude-hooks")

    /// Installs project-scoped MCP servers for this workspace into
    /// `~/.claude.json -> projects["<cwd>"].mcpServers`.
    /// Silent on error so agent launch is never blocked.
    static func installProjectMCPServers(
        workspaceCwd: String,
        mcpConfigURL: URL
    ) {
        guard !workspaceCwd.isEmpty else { return }
        do {
            let data = try Data(contentsOf: mcpConfigURL)
            guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let mcpServers = payload["mcpServers"] as? [String: Any],
                  !mcpServers.isEmpty else {
                return
            }
            try mergeProjectMCPServers(workspaceCwd: workspaceCwd, mcpServers: mcpServers)
            logger.debug("claude mcp: injected project mcpServers into \(workspaceCwd, privacy: .public)")
        } catch {
            logger.warning("claude mcp: injection failed (\(error.localizedDescription, privacy: .public)) — continuing")
        }
    }

    private static func mergeProjectMCPServers(
        workspaceCwd: String,
        mcpServers: [String: Any]
    ) throws {
        let fm = FileManager.default
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".claude.json")
        let original = fm.fileExists(atPath: path)
            ? try String(contentsOfFile: path, encoding: .utf8)
            : ""
        let mutation = try ClaudeJSONMCPInstaller.installTransform(
            original,
            workspaceCwd: workspaceCwd,
            mcpServers: mcpServers
        )
        guard mutation.changed else {
            return
        }

        let latest = fm.fileExists(atPath: path)
            ? try String(contentsOfFile: path, encoding: .utf8)
            : ""
        let latestMutation = latest == original
            ? mutation
            : try ClaudeJSONMCPInstaller.installTransform(
                latest,
                workspaceCwd: workspaceCwd,
                mcpServers: mcpServers
        )
        if latestMutation.changed {
            try latestMutation.content.write(toFile: path, atomically: true, encoding: .utf8)
            logger.info("claude.mcp.write server_count=\(mcpServers.count, privacy: .public)")
        }
    }
}
