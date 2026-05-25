// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Pure transforms for TermLoop-owned entries in Claude Code
/// `~/.claude/settings.json`.
///
/// TermLoop owns only its hook command entries under the configured Claude
/// hook events. User hook groups, unknown root keys, and unsupported hook
/// event shapes are preserved.
enum ClaudeSettingsJSON {
    struct Mutation: Equatable {
        let content: String
        let changed: Bool
        let addedEvents: [String]
        let repairedEvents: [String]
        let alreadyPresentEvents: [String]
        let unsupportedEvents: [String]

        var installed: Bool {
            !changed
                && unsupportedEvents.isEmpty
                && Set(alreadyPresentEvents) == Set(SelfRequired.events)
        }
    }

    enum TransformError: Error, LocalizedError {
        case invalidJSON
        case rootIsNotObject
        case cannotSerialize

        var errorDescription: String? {
            switch self {
            case .invalidJSON:
                return "Claude settings.json is not valid JSON. Refusing to overwrite it."
            case .rootIsNotObject:
                return "Claude settings.json root is not a JSON object. Refusing to overwrite it."
            case .cannotSerialize:
                return "Failed to serialize Claude settings.json."
            }
        }
    }

    private enum SelfRequired {
        static let events = [
            "SessionStart",
            "PreToolUse",
            "UserPromptSubmit",
            "Stop",
            "SessionEnd",
            "Notification",
        ]
    }

    static let ownershipMarker = "termloop-managed:v1"

    static var requiredEvents: [String] {
        SelfRequired.events
    }

    static var requiredHooks: [String: String] {
        var hooks: [String: String] = [:]
        for event in SelfRequired.events {
            hooks[event] = canonicalCommand(for: event)
        }
        return hooks
    }

    static let probeSuffixes: [String: String] = [
        "SessionStart": "claude-hook session-start",
        "PreToolUse": "claude-hook pre-tool-use",
        "UserPromptSubmit": "claude-hook prompt-submit",
        "Stop": "claude-hook stop",
        "SessionEnd": "claude-hook session-end",
        "Notification": "claude-hook notification",
    ]

    static func installTransform(_ content: String) throws -> Mutation {
        var root = try parseRoot(content)
        var hooks = (root["hooks"] as? [String: Any]) ?? [:]

        if root["hooks"] != nil, root["hooks"] as? [String: Any] == nil {
            return Mutation(
                content: content,
                changed: false,
                addedEvents: [],
                repairedEvents: [],
                alreadyPresentEvents: [],
                unsupportedEvents: SelfRequired.events
            )
        }

        var added: [String] = []
        var repaired: [String] = []
        var alreadyPresent: [String] = []
        var unsupported: [String] = []
        var mutated = false

        for event in SelfRequired.events {
            let command = canonicalCommand(for: event)
            let canonicalGroup = canonicalHookGroup(command: command)

            guard let rawValue = hooks[event] else {
                hooks[event] = [canonicalGroup]
                added.append(event)
                mutated = true
                continue
            }

            guard let groups = rawValue as? [[String: Any]] else {
                unsupported.append(event)
                continue
            }

            var foundCanonical = false
            var newGroups: [[String: Any]] = []
            var eventMutated = false

            for group in groups {
                if isCanonicalHookGroup(event: event, group: group) {
                    if foundCanonical {
                        eventMutated = true
                        continue
                    }
                    foundCanonical = true
                    newGroups.append(group)
                    continue
                }

                guard let nested = group["hooks"] as? [[String: Any]] else {
                    newGroups.append(group)
                    continue
                }

                let filtered = nested.filter {
                    !isTermLoopOwnedHookEntry($0)
                }
                if filtered.count != nested.count {
                    eventMutated = true
                }
                guard !filtered.isEmpty else {
                    continue
                }

                var updatedGroup = group
                updatedGroup["hooks"] = filtered
                newGroups.append(updatedGroup)
            }

            if !foundCanonical {
                newGroups.append(canonicalGroup)
                if groups.contains(where: { nestedGroupContainsOwnedHook($0) }) {
                    repaired.append(event)
                } else {
                    added.append(event)
                }
                eventMutated = true
            } else {
                if eventMutated {
                    repaired.append(event)
                } else {
                    alreadyPresent.append(event)
                }
            }

            if eventMutated || !jsonEqual(groups, newGroups) {
                hooks[event] = newGroups
                mutated = true
            }
        }

        guard mutated else {
            return Mutation(
                content: content,
                changed: false,
                addedEvents: added,
                repairedEvents: repaired,
                alreadyPresentEvents: alreadyPresent,
                unsupportedEvents: unsupported
            )
        }

        root["hooks"] = hooks
        let updated = try serialize(root)
        return Mutation(
            content: updated,
            changed: updated != content,
            addedEvents: added,
            repairedEvents: repaired,
            alreadyPresentEvents: alreadyPresent,
            unsupportedEvents: unsupported
        )
    }

    static func isCanonicalHookEntry(event: String, entry: [String: Any]) -> Bool {
        guard entry.count == 2,
              (entry["type"] as? String) == "command",
              (entry["command"] as? String) == canonicalCommand(for: event) else {
            return false
        }
        return true
    }

    static func isTermLoopOwnedCommand(_ command: String) -> Bool {
        let lowercase = command.lowercased()
        if lowercase.contains(ownershipMarker) {
            return true
        }
        guard lowercase.contains("claude-hook") else {
            return false
        }
        return lowercase.contains("termloop claude-hook")
            || lowercase.contains("termloop_bundled_cli_path")
            || lowercase.contains("command -v termloop")
            || lowercase.contains("termloop_bin")
    }

    static func canonicalCommand(for event: String) -> String {
        let suffix = probeSuffixes[event] ?? "claude-hook \(event)"
        let bin = "${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}"
        return """
        # \(ownershipMarker)
        TERMLOOP_BIN="\(bin)"; \
        { [ -n "$TERMLOOP_SURFACE_ID" ] || [ -n "$TERMLOOP_WORKSPACE_ID" ]; } \
        && [ "$TERMLOOP_HOOKS_DISABLED" != "1" ] \
        && [ "$TERMLOOP_CLAUDE_HOOKS_DISABLED" != "1" ] \
        && [ -n "$TERMLOOP_BIN" ] && [ -x "$TERMLOOP_BIN" ] \
        && { "$TERMLOOP_BIN" \(suffix) >/dev/null 2>/dev/null || true; echo '{}'; } \
        || echo '{}'
        """
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

    private static func canonicalHookGroup(command: String) -> [String: Any] {
        [
            "matcher": "",
            "hooks": [
                [
                    "type": "command",
                    "command": command,
                ] as [String: Any],
            ],
        ]
    }

    private static func isCanonicalHookGroup(event: String, group: [String: Any]) -> Bool {
        guard group.count == 2,
              (group["matcher"] as? String) == "",
              let hooks = group["hooks"] as? [[String: Any]],
              hooks.count == 1 else {
            return false
        }
        return isCanonicalHookEntry(event: event, entry: hooks[0])
    }

    private static func isTermLoopOwnedHookEntry(_ entry: [String: Any]) -> Bool {
        isTermLoopOwnedCommand((entry["command"] as? String) ?? "")
    }

    private static func nestedGroupContainsOwnedHook(_ group: [String: Any]) -> Bool {
        guard let hooks = group["hooks"] as? [[String: Any]] else {
            return false
        }
        return hooks.contains { isTermLoopOwnedHookEntry($0) }
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
