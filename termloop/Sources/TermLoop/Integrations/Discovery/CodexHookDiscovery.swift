// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct CodexHookDiscovery: IntegrationDiscovery {
    let kind: IntegrationKind = .codexHook

    func discover(projectRoot: URL?) async -> [IntegrationItem] {
        let hooksURL = Self.codexHomeURL().appendingPathComponent("hooks.json")
        return Self.parse(file: hooksURL)
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
                let matcher = (group["matcher"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let matcherSuffix = matcher.flatMap { $0.isEmpty ? nil : $0 }
                let displayName = matcherSuffix.map { "\(eventName) · \($0)" } ?? eventName
                let idSuffix = matcherSuffix ?? String(idx)
                items.append(IntegrationItem(
                    id: IntegrationItem.makeId(kind: .codexHook, name: "\(eventName)#\(idSuffix)"),
                    kind: .codexHook,
                    displayName: displayName,
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

    private static func codexHomeURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["CODEX_HOME"],
           !override.isEmpty {
            return URL(fileURLWithPath: NSString(string: override).expandingTildeInPath,
                       isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex", isDirectory: true)
    }
}
