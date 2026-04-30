// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct ClaudeHookDiscovery: IntegrationDiscovery {
    let kind: IntegrationKind = .claudeHook

    func discover(projectRoot: URL?) async -> [IntegrationItem] {
        var results: [String: IntegrationItem] = [:]
        let home = FileManager.default.homeDirectoryForCurrentUser
        let userSettings = home.appendingPathComponent(".claude/settings.json")
        for item in Self.parse(file: userSettings, source: .userScope) {
            results[item.id] = item
        }
        _ = projectRoot  // project-scope branch removed — param kept for protocol conformance
        return Array(results.values)
    }

    private static func parse(file: URL, source: IntegrationItem.Source) -> [IntegrationItem] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        guard let hooks = root["hooks"] as? [String: Any] else { return [] }

        var items: [IntegrationItem] = []
        for (eventName, value) in hooks {
            // Claude Code hook schema is: { "PreToolUse": [ { matcher, hooks: [...] } ] }
            if let array = value as? [[String: Any]] {
                for (idx, entry) in array.enumerated() {
                    let matcher = (entry["matcher"] as? String) ?? "*"
                    let name = "\(eventName) · \(matcher)"
                    let id = IntegrationItem.makeId(kind: .claudeHook,
                                                    name: "\(eventName)#\(idx)#\(matcher)")
                    items.append(IntegrationItem(
                        id: id,
                        kind: .claudeHook,
                        displayName: name,
                        summary: Self.summarise(entry: entry),
                        source: source,
                        status: .idle,
                        lastTestedAt: nil,
                        lastTestDurationMs: nil,
                        capabilities: [],
                        configRef: nil,
                        attachedToActiveSpawn: false,
                        binaryPath: nil,
                        version: nil,
                        authSubject: nil
                    ))
                }
            }
        }
        return items
    }

    private static func summarise(entry: [String: Any]) -> String {
        guard let hookList = entry["hooks"] as? [[String: Any]] else { return "hook" }
        let commands = hookList.compactMap { $0["command"] as? String }
        if commands.isEmpty { return "hook" }
        return commands.joined(separator: " · ")
    }
}
