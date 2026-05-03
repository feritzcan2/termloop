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
    private static let termLoopMCPServerName = "termloop"
    private static let volatileTermLoopMCPEnvKeys: Set<String> = [
        "TERMLOOP_SOCKET_PATH",
        "TERMLOOP_SOCKET",
        "TERMLOOP_BUNDLED_CLI_PATH",
        "TERMLOOP_WORKSPACE_ID",
        "TERMLOOP_ASK_TO_REQUEST_ID",
        "TERMLOOP_ASK_TO_REPLY_TOKEN",
        "TERMLOOP_SURFACE_ID",
        "TERMLOOP_PANEL_ID",
        "TERMLOOP_AGENT_ID",
        "TERMLOOP_BUNDLE_ID",
        "TERMLOOP_TAG",
        "TERMLOOP_DEBUG_LOG",
        "TERMLOOP_DEBUG_BG_LOG",
        "TERMLOOP_ENABLED_MCP_TOOLS",
        "TERMLOOP_PORT",
        "TERMLOOP_PORT_END",
        "TERMLOOP_PORT_RANGE",
    ]

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
        scrubPersistedTermLoopMCPEntries(in: &projects)
        var project = (projects[workspaceCwd] as? [String: Any]) ?? [:]
        var mergedServers = (project["mcpServers"] as? [String: Any]) ?? [:]
        for (key, value) in mcpServers {
            mergedServers[key] = sanitizedProjectMCPServer(name: key, value: value)
        }
        project["mcpServers"] = mergedServers
        projects[workspaceCwd] = project
        root["projects"] = projects

        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    private static func scrubPersistedTermLoopMCPEntries(in projects: inout [String: Any]) {
        for (projectPath, rawProject) in projects {
            guard var project = rawProject as? [String: Any],
                  var servers = project["mcpServers"] as? [String: Any],
                  let existing = servers[termLoopMCPServerName] else {
                continue
            }
            guard isTermLoopMCPServer(existing) else { continue }
            servers[termLoopMCPServerName] = sanitizedTermLoopMCPServer(existing)
            project["mcpServers"] = servers
            projects[projectPath] = project
        }
    }

    private static func sanitizedProjectMCPServer(name: String, value: Any) -> Any {
        guard name == termLoopMCPServerName else { return value }
        return sanitizedTermLoopMCPServer(value)
    }

    private static func sanitizedTermLoopMCPServer(_ value: Any) -> Any {
        guard var entry = value as? [String: Any] else {
            return value
        }

        // Claude's project-scope MCP config is persistent. Socket path,
        // workspace id, bundled CLI path, and per-launch tool gates must come
        // from the current TermLoop-launched process environment; persisting
        // them pins future agents to whichever tagged dev build wrote the
        // config first.
        if var env = normalizedEnvDictionary(entry["env"]) {
            for key in volatileTermLoopMCPEnvKeys {
                env.removeValue(forKey: key)
            }
            if env.isEmpty {
                entry.removeValue(forKey: "env")
            } else {
                entry["env"] = env
            }
        }

        entry["command"] = "/bin/sh"
        entry["args"] = [
            "-lc",
            "exec \"${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}\" termloop-mcp",
        ]
        return entry
    }

    private static func normalizedEnvDictionary(_ raw: Any?) -> [String: Any]? {
        if let env = raw as? [String: Any] {
            return env
        }
        if let env = raw as? [String: String] {
            var normalized: [String: Any] = [:]
            for (key, value) in env {
                normalized[key] = value
            }
            return normalized
        }
        return nil
    }

    private static func isTermLoopMCPServer(_ value: Any) -> Bool {
        guard let entry = value as? [String: Any] else {
            return false
        }
        if let env = normalizedEnvDictionary(entry["env"]),
           env.keys.contains(where: { volatileTermLoopMCPEnvKeys.contains($0) }) {
            return true
        }
        let command = entry["command"] as? String ?? ""
        let args = stringArray(entry["args"])
        return ([command] + args).joined(separator: " ").contains("termloop-mcp")
    }

    private static func stringArray(_ raw: Any?) -> [String] {
        if let strings = raw as? [String] {
            return strings
        }
        if let values = raw as? [Any] {
            return values.compactMap { $0 as? String }
        }
        return []
    }
}
