// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct GeminiHookDiscovery: IntegrationDiscovery {
    let kind: IntegrationKind = .geminiHook

    func discover(projectRoot: URL?) async -> [IntegrationItem] {
        _ = projectRoot  // user-scope only
        let home = FileManager.default.homeDirectoryForCurrentUser
        let settings = home.appendingPathComponent(".gemini/settings.json")
        return Self.parse(file: settings)
    }

    private static func parse(file: URL) -> [IntegrationItem] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return []
        }
        guard let hooks = root["hooks"] as? [String: Any] else { return [] }

        var items: [IntegrationItem] = []
        for (eventName, value) in hooks {
            guard let groups = value as? [[String: Any]] else { continue }
            for (idx, group) in groups.enumerated() {
                items.append(IntegrationItem(
                    id: IntegrationItem.makeId(kind: .geminiHook, name: "\(eventName)#\(idx)"),
                    kind: .geminiHook,
                    displayName: eventName,
                    summary: summarise(group: group),
                    source: .userScope,
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
        return items.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    private static func summarise(group: [String: Any]) -> String {
        guard let hookList = group["hooks"] as? [[String: Any]] else { return "hook" }
        let commands = hookList.compactMap { $0["command"] as? String }
        if commands.isEmpty { return "hook" }
        return commands.joined(separator: " · ")
    }
}
