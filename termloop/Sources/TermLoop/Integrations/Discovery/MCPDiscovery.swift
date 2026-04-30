// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct MCPDiscovery: IntegrationDiscovery {
    let kind: IntegrationKind = .mcp

    /// File-mtime-keyed cache for parsed JSON config files.
    /// `~/.claude.json` is large (15+ projects, ~25KB) and is re-decoded
    /// on every refresh otherwise. Static so the cache survives across
    /// `discover` calls but stays per-process.
    private static let parsedJSONCache = JSONFileMtimeCache()

    private final class JSONFileMtimeCache: @unchecked Sendable {
        private var entries: [String: (mtime: Date, size: Int, root: [String: Any]?)] = [:]
        private let lock = NSLock()

        func read(_ url: URL) -> [String: Any]? {
            let path = url.path
            let attrs = try? FileManager.default.attributesOfItem(atPath: path)
            let mtime = attrs?[.modificationDate] as? Date
            let size = (attrs?[.size] as? NSNumber)?.intValue ?? -1
            lock.lock()
            if let hit = entries[path], hit.mtime == mtime, hit.size == size {
                let cached = hit.root
                lock.unlock()
                return cached
            }
            lock.unlock()
            let parsed: [String: Any]?
            if let data = try? Data(contentsOf: url),
               let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                parsed = root
            } else {
                parsed = nil
            }
            lock.lock()
            entries[path] = (mtime ?? .distantPast, size, parsed)
            lock.unlock()
            return parsed
        }
    }

    func discover(projectRoot: URL?) async -> [IntegrationItem] {
        var results: [String: IntegrationItem] = [:]

        let home = FileManager.default.homeDirectoryForCurrentUser

        // Claude user scope — only `root["mcpServers"]`, nothing else.
        let userClaudeJSON = home.appendingPathComponent(".claude.json")
        for item in Self.parseClaudeJSON(file: userClaudeJSON,
                                         projectRoot: projectRoot,
                                         agent: .claude) {
            Self.upsert(item, into: &results)
        }

        // Codex user scope — ~/.codex/config.toml `[mcp_servers.*]`
        let codexConfig = home.appendingPathComponent(".codex/config.toml")
        for item in Self.parseCodexToml(file: codexConfig, agent: .codex) {
            Self.upsert(item, into: &results)
        }

        // Gemini user scope — ~/.gemini/settings.json `mcpServers`
        let geminiSettings = home.appendingPathComponent(".gemini/settings.json")
        for item in Self.parseSimpleMCPFile(file: geminiSettings,
                                            source: .userScope,
                                            agent: .gemini) {
            Self.upsert(item, into: &results)
        }

        // Project `.mcp.json` (wins on collision). Treated as Claude's scope
        // by convention — the file is a Claude/Anthropic primitive.
        if let root = projectRoot {
            let projectMCP = root.appendingPathComponent(".mcp.json")
            for item in Self.parse(file: projectMCP,
                                   source: .projectScope(projectMCP),
                                   agent: .claude) {
                Self.upsert(item, into: &results)
            }
            // Project Gemini settings too
            let geminiProject = root.appendingPathComponent(".gemini/settings.json")
            for item in Self.parseSimpleMCPFile(file: geminiProject,
                                                source: .projectScope(geminiProject),
                                                agent: .gemini) {
                Self.upsert(item, into: &results)
            }
        }
        return Array(results.values)
    }

    private static func upsert(_ item: IntegrationItem,
                               into results: inout [String: IntegrationItem]) {
        results[item.id] = results[item.id]?.merged(with: item) ?? item
    }

    /// Parses a JSON settings file that contains a top-level `mcpServers`
    /// map (used by Gemini CLI, and the legacy `.mcp.json` shape).
    static func parseSimpleMCPFile(file: URL,
                                   source: IntegrationItem.Source,
                                   agent: AbilityAgentFamily) -> [IntegrationItem] {
        guard let root = parsedJSONCache.read(file) else { return [] }
        guard let dict = root["mcpServers"] as? [String: Any] else { return [] }
        return Self.servers(from: dict, source: source, agent: agent)
    }

    /// Claude Code stores MCP config in two places inside `~/.claude.json`:
    /// - top-level `mcpServers` (user scope, applies everywhere)
    /// - `projects["<abs-path>"].mcpServers` (project scope, only the
    ///   current workspace)
    /// Everything else at the top level (`additionalModelCostsCache`,
    /// `projects`, `oauthAccount`, etc.) is Claude internal state and
    /// must be ignored — the previous "fallback to root" logic was what
    /// made them show up as fake MCP servers.
    static func parseClaudeJSON(file: URL,
                                projectRoot: URL?,
                                agent: AbilityAgentFamily) -> [IntegrationItem] {
        guard let root = parsedJSONCache.read(file) else { return [] }
        var out: [IntegrationItem] = []
        if let userServers = root["mcpServers"] as? [String: Any] {
            out.append(contentsOf: servers(from: userServers, source: .userScope, agent: agent))
        }
        if let rootPath = projectRoot?.path,
           let projects = root["projects"] as? [String: Any] {
            // Project keys may include trailing slashes or normalized paths.
            let candidates = [rootPath, rootPath + "/", (rootPath as NSString).standardizingPath]
            for key in candidates {
                if let entry = projects[key] as? [String: Any],
                   let projectServers = entry["mcpServers"] as? [String: Any] {
                    let src: IntegrationItem.Source = .projectScope(file)
                    out.append(contentsOf: servers(from: projectServers, source: src, agent: agent))
                    break
                }
            }
        }
        return out
    }

    private static func servers(from dict: [String: Any],
                                source: IntegrationItem.Source,
                                agent: AbilityAgentFamily) -> [IntegrationItem] {
        var out: [IntegrationItem] = []
        for (name, value) in dict {
            guard let cfg = value as? [String: Any] else { continue }
            out.append(IntegrationItem(
                id: IntegrationItem.makeId(kind: .mcp, name: name),
                kind: .mcp,
                displayName: name,
                summary: summary(for: cfg),
                source: source,
                status: .idle,
                lastTestedAt: nil,
                lastTestDurationMs: nil,
                capabilities: [],
                configRef: nil,
                attachedToActiveSpawn: false,
                binaryPath: cfg["command"] as? String,
                version: nil,
                authSubject: nil,
                availableForAgents: [agent]
            ))
        }
        return out
    }

    /// Parses a project `.mcp.json` file. Only the documented shape
    /// `{ "mcpServers": { "<name>": {...} } }` is accepted — the older
    /// greedy fallback pulled in unrelated top-level keys.
    private static func parse(file: URL,
                              source: IntegrationItem.Source,
                              agent: AbilityAgentFamily) -> [IntegrationItem] {
        guard let root = parsedJSONCache.read(file) else { return [] }
        guard let dict = root["mcpServers"] as? [String: Any] else { return [] }
        return Self.servers(from: dict, source: source, agent: agent)
    }

    private static func summary(for cfg: [String: Any]) -> String {
        if let command = cfg["command"] as? String { return "stdio · \(command)" }
        if let url = cfg["url"] as? String { return "http · \(url)" }
        if let type = cfg["type"] as? String { return type }
        return "mcp"
    }

    /// Tolerant parser for Codex's `~/.codex/config.toml`. Extracts
    /// `[mcp_servers.<name>]` tables and pulls the `command` key if
    /// present. Full TOML grammar isn't necessary — we only need enough
    /// to surface names + summary. Codex's schema is documented as
    /// unstable, so this deliberately fails soft.
    static func parseCodexToml(file: URL, agent: AbilityAgentFamily) -> [IntegrationItem] {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
        var items: [IntegrationItem] = []

        let ns = text as NSString
        let headerPattern = #"^\s*\[mcp_servers\.([A-Za-z0-9_\-]+)\]\s*$"#
        guard let regex = try? NSRegularExpression(pattern: headerPattern,
                                                   options: [.anchorsMatchLines]) else { return [] }
        let matches = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
        for (idx, match) in matches.enumerated() {
            guard match.numberOfRanges >= 2 else { continue }
            let name = ns.substring(with: match.range(at: 1))
            let sectionStart = match.range.location + match.range.length
            let sectionEnd = idx + 1 < matches.count ? matches[idx + 1].range.location : ns.length
            let body = ns.substring(with: NSRange(location: sectionStart,
                                                   length: sectionEnd - sectionStart))
            let command = firstStringValue(in: body, key: "command")
            let summary = command.map { "codex · \($0)" } ?? "codex mcp"
            items.append(IntegrationItem(
                id: IntegrationItem.makeId(kind: .mcp, name: name),
                kind: .mcp,
                displayName: name,
                summary: summary,
                source: .userScope,
                status: .idle,
                lastTestedAt: nil,
                lastTestDurationMs: nil,
                capabilities: [],
                configRef: nil,
                attachedToActiveSpawn: false,
                binaryPath: command,
                version: nil,
                authSubject: nil,
                availableForAgents: [agent]
            ))
        }
        return items
    }

    private static func firstStringValue(in body: String, key: String) -> String? {
        let pattern = "^\\s*\(NSRegularExpression.escapedPattern(for: key))\\s*=\\s*\"([^\"]*)\""
        guard let regex = try? NSRegularExpression(pattern: pattern,
                                                   options: [.anchorsMatchLines]) else { return nil }
        let ns = body as NSString
        guard let match = regex.firstMatch(in: body,
                                           range: NSRange(location: 0, length: ns.length)),
              match.numberOfRanges >= 2 else { return nil }
        return ns.substring(with: match.range(at: 1))
    }
}
