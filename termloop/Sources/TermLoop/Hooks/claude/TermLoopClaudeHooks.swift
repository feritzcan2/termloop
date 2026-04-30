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
        var root: [String: Any] = [:]
        if fm.fileExists(atPath: path),
           let data = fm.contents(atPath: path),
           let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            root = parsed
        }

        var projects = (root["projects"] as? [String: Any]) ?? [:]
        var project = (projects[workspaceCwd] as? [String: Any]) ?? [:]
        var mergedServers = (project["mcpServers"] as? [String: Any]) ?? [:]
        for (key, value) in mcpServers {
            mergedServers[key] = value
        }
        project["mcpServers"] = mergedServers
        projects[workspaceCwd] = project
        root["projects"] = projects

        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}
