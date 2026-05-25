// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Pure transform for Claude Code `~/.claude.json` project MCP entries.
///
/// TermLoop only mutates the active workspace project entry:
/// `projects[workspaceCwd].mcpServers`. Other projects and root keys are
/// preserved.
enum ClaudeJSONMCPInstaller {
    struct Mutation: Equatable {
        let content: String
        let changed: Bool
    }

    enum TransformError: Error, LocalizedError {
        case invalidJSON
        case rootIsNotObject
        case projectsIsNotObject
        case projectIsNotObject(String)
        case mcpServersIsNotObject(String)
        case cannotSerialize

        var errorDescription: String? {
            switch self {
            case .invalidJSON:
                return "~/.claude.json is not valid JSON. Refusing to overwrite it."
            case .rootIsNotObject:
                return "~/.claude.json root is not a JSON object. Refusing to overwrite it."
            case .projectsIsNotObject:
                return "~/.claude.json projects is not a JSON object. Refusing to overwrite it."
            case .projectIsNotObject(let path):
                return "~/.claude.json project entry is not an object for \(path). Refusing to overwrite it."
            case .mcpServersIsNotObject(let path):
                return "~/.claude.json project mcpServers is not an object for \(path). Refusing to overwrite it."
            case .cannotSerialize:
                return "Failed to serialize ~/.claude.json."
            }
        }
    }

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

    static func installTransform(
        _ content: String,
        workspaceCwd: String,
        mcpServers: [String: Any]
    ) throws -> Mutation {
        guard !workspaceCwd.isEmpty, !mcpServers.isEmpty else {
            return Mutation(content: content, changed: false)
        }

        var root = try parseRoot(content)
        var projects: [String: Any]
        if let rawProjects = root["projects"] {
            guard let parsedProjects = rawProjects as? [String: Any] else {
                throw TransformError.projectsIsNotObject
            }
            projects = parsedProjects
        } else {
            projects = [:]
        }

        var project: [String: Any]
        if let rawProject = projects[workspaceCwd] {
            guard let parsedProject = rawProject as? [String: Any] else {
                throw TransformError.projectIsNotObject(workspaceCwd)
            }
            project = parsedProject
        } else {
            project = [:]
        }

        var mergedServers: [String: Any]
        if let rawServers = project["mcpServers"] {
            guard let parsedServers = rawServers as? [String: Any] else {
                throw TransformError.mcpServersIsNotObject(workspaceCwd)
            }
            mergedServers = parsedServers
        } else {
            mergedServers = [:]
        }

        let originalServers = mergedServers
        for (key, value) in mcpServers {
            mergedServers[key] = sanitizedProjectMCPServer(name: key, value: value)
        }

        guard !jsonEqual(originalServers, mergedServers) else {
            return Mutation(content: content, changed: false)
        }

        project["mcpServers"] = mergedServers
        projects[workspaceCwd] = project
        root["projects"] = projects

        let updated = try serialize(root)
        return Mutation(content: updated, changed: updated != content)
    }

    static func sanitizedProjectMCPServer(name: String, value: Any) -> Any {
        guard name == termLoopMCPServerName else { return value }
        return sanitizedTermLoopMCPServer(value)
    }

    static func sanitizedTermLoopMCPServer(_ value: Any) -> Any {
        guard var entry = value as? [String: Any] else {
            return value
        }

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

    static func parseRoot(_ content: String) throws -> [String: Any] {
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return [:]
        }
        guard let data = content.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) else {
            throw TransformError.invalidJSON
        }
        guard let root = parsed as? [String: Any] else {
            throw TransformError.rootIsNotObject
        }
        return root
    }

    static func serialize(_ root: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(root),
              let data = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted]),
              let content = String(data: data, encoding: .utf8) else {
            throw TransformError.cannotSerialize
        }
        return content
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

    private static func jsonEqual(_ lhs: Any, _ rhs: Any) -> Bool {
        switch (lhs, rhs) {
        case let (lhs as [String: Any], rhs as [String: Any]):
            guard Set(lhs.keys) == Set(rhs.keys) else { return false }
            return lhs.keys.allSatisfy { key in
                guard let lhsValue = lhs[key], let rhsValue = rhs[key] else { return false }
                return jsonEqual(lhsValue, rhsValue)
            }
        case let (lhs as [Any], rhs as [Any]):
            guard lhs.count == rhs.count else { return false }
            return zip(lhs, rhs).allSatisfy { jsonEqual($0, $1) }
        case let (lhs as String, rhs as String):
            return lhs == rhs
        case let (lhs as NSNumber, rhs as NSNumber):
            return lhs == rhs
        case (_ as NSNull, _ as NSNull):
            return true
        default:
            return false
        }
    }
}
