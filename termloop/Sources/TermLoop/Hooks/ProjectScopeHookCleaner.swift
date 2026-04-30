// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Removes TermLoop-owned hook entries from a project's `.claude`,
/// `.codex`, or `.gemini` config file. User-owned entries and unrelated
/// root-level keys are preserved verbatim.
///
/// Ownership detection matches either the stable CLI marker
/// (`<agent>-hook`) or the legacy bundle/DerivedData path
/// `/TermLoopHooks/<agent>/` that older builds wrote into project configs.
enum ProjectScopeHookCleaner {
    private static let logger = Logger(subsystem: "com.termloop.fork", category: "hook-cleaner")

    static func cleanup(projectURL: URL, for agent: HookManagedAgent) {
        let settingsURL = projectSettingsURL(projectURL: projectURL, for: agent)
        guard FileManager.default.fileExists(atPath: settingsURL.path) else { return }

        do {
            let data = try Data(contentsOf: settingsURL)
            guard var root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                logger.debug("cleanup: \(settingsURL.path, privacy: .public) — non-object JSON, skipping")
                return
            }
            var hooks = (root["hooks"] as? [String: Any]) ?? [:]
            var mutated = false

            for (event, value) in hooks {
                guard let groups = value as? [[String: Any]] else { continue }
                var newGroups: [[String: Any]] = []
                for group in groups {
                    guard let nested = group["hooks"] as? [[String: Any]] else {
                        // Unparseable group — preserve verbatim.
                        newGroups.append(group)
                        continue
                    }
                    // Remove only TermLoop-owned hook entries from the nested
                    // list (mixed groups correctly preserve user hooks).
                    let filteredNested = nested.filter {
                        !isTermLoopOwnedCommand(($0["command"] as? String) ?? "", agent: agent)
                    }
                    if filteredNested.count != nested.count {
                        mutated = true
                    }
                    if !filteredNested.isEmpty {
                        var updatedGroup = group
                        updatedGroup["hooks"] = filteredNested
                        newGroups.append(updatedGroup)
                    }
                    // If filteredNested is empty, drop the group (all hooks
                    // were TermLoop-owned).
                }

                if newGroups.isEmpty {
                    hooks.removeValue(forKey: event)
                    mutated = true
                } else if newGroups.count != groups.count {
                    hooks[event] = newGroups
                    mutated = true
                }
            }

            guard mutated else { return }
            root["hooks"] = hooks

            if shouldDeleteFile(root: root) {
                try FileManager.default.removeItem(at: settingsURL)
                logger.debug("cleanup: deleted empty \(settingsURL.path, privacy: .public)")
            } else {
                let newData = try JSONSerialization.data(
                    withJSONObject: root,
                    options: [.prettyPrinted, .sortedKeys]
                )
                try newData.write(to: settingsURL, options: .atomic)
                logger.debug("cleanup: stripped TermLoop entries from \(settingsURL.path, privacy: .public)")
            }
        } catch {
            logger.warning("cleanup failed for \(settingsURL.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    static func cleanupAllAgents(projectURL: URL) {
        for agent in HookManagedAgent.allCases {
            cleanup(projectURL: projectURL, for: agent)
        }
    }

    private static func projectSettingsURL(projectURL: URL, for agent: HookManagedAgent) -> URL {
        switch agent {
        case .claude: return projectURL.appendingPathComponent(".claude/settings.json")
        case .codex:  return projectURL.appendingPathComponent(".codex/hooks.json")
        case .gemini: return projectURL.appendingPathComponent(".gemini/settings.json")
        }
    }

    /// True if the command is TermLoop-owned for the given agent. Matches
    /// the stable marker (`<agent>-hook`) or the legacy bundle-bash form
    /// `.../TermLoopHooks/<agent>/*.sh` that older builds wrote.
    static func isTermLoopOwnedCommand(_ command: String, agent: HookManagedAgent) -> Bool {
        command.contains(agent.stableCommandMarker)
            || command.contains("/TermLoopHooks/\(agent.rawValue)/")
    }

    /// File is deletion-safe only when `hooks` is empty and no other user keys
    /// remain in the root object.
    private static func shouldDeleteFile(root: [String: Any]) -> Bool {
        let hooks = root["hooks"] as? [String: Any] ?? [:]
        if !hooks.isEmpty { return false }
        let otherKeys = root.keys.filter { $0 != "hooks" }
        return otherKeys.isEmpty
    }
}
