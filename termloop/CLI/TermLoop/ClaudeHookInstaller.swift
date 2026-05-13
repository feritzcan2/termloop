// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// CLI entry point for `termloop install-claude-hooks` and `termloop check-claude-hooks`.
/// Reads and writes `~/.claude/settings.json` idempotently: merges the five
/// hook events teleport needs while preserving any unrelated entries the user
/// already has.
enum ClaudeHookInstaller {
    private static let insideTermLoopGuard =
        "{ [ -n \"$TERMLOOP_SURFACE_ID\" ] || [ -n \"$TERMLOOP_WORKSPACE_ID\" ]; }"
    private static let perAgentDisableGuard =
        "[ \"$TERMLOOP_CLAUDE_HOOKS_DISABLED\" != \"1\" ]"
    private static let globalDisableGuard =
        "[ \"$TERMLOOP_HOOKS_DISABLED\" != \"1\" ]"

    /// Required hook event → persisted shell command.
    ///
    /// The termloop binary is resolved via `TERMLOOP_BUNDLED_CLI_PATH` (set
    /// when TermLoop launches the agent) with a `$PATH` fallback. Env guards
    /// short-circuit to `echo '{}'` outside an TermLoop launch or when
    /// disable flags are set, so stale settings between launches are a safe
    /// no-op.
    static var requiredHooks: [(event: String, command: String)] {
        [
            ("SessionStart",     guardedTermLoopCommand("claude-hook session-start")),
            ("PreToolUse",       guardedTermLoopCommand("claude-hook pre-tool-use")),
            ("UserPromptSubmit", guardedTermLoopCommand("claude-hook prompt-submit")),
            ("Stop",             guardedTermLoopCommand("claude-hook stop")),
            ("SessionEnd",       guardedTermLoopCommand("claude-hook session-end")),
            ("Notification",     guardedTermLoopCommand("claude-hook notification"))
        ]
    }

    /// Substring used by `ClaudeHooksStatus.probe` to recognize a valid entry.
    /// Must match the CLI subcommand form written above.
    static let probeSuffixes: [String: String] = [
        "SessionStart":     "claude-hook session-start",
        "PreToolUse":       "claude-hook pre-tool-use",
        "UserPromptSubmit": "claude-hook prompt-submit",
        "Stop":              "claude-hook stop",
        "SessionEnd":       "claude-hook session-end",
        "Notification":     "claude-hook notification"
    ]

    private static func isInstalledTermLoopHookCommand(_ command: String, suffix: String) -> Bool {
        guard command.contains(suffix) else { return false }
        return command.contains("TERMLOOP_WORKSPACE_ID")
            || command.contains("TERMLOOP_SURFACE_ID")
            || command.contains("TERMLOOP_BUNDLED_CLI_PATH")
    }

    /// True for the current stable marker form. Used at install time to replace
    /// our own output without touching user-owned hooks.
    private static func isTermLoopOwnedClaudeCommand(_ command: String) -> Bool {
        isInstalledTermLoopHookCommand(command, suffix: "claude-hook")
    }

    private static func guardedTermLoopCommand(_ subcommand: String) -> String {
        let bin = "${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}"
        return """
        TERMLOOP_BIN="\(bin)"; \
        \(insideTermLoopGuard) && \(globalDisableGuard) && \(perAgentDisableGuard) \
        && [ -n "$TERMLOOP_BIN" ] && [ -x "$TERMLOOP_BIN" ] \
        && { "$TERMLOOP_BIN" \(subcommand) >/dev/null 2>/dev/null || true; echo '{}'; } \
        || echo '{}'
        """
    }

    static func install(jsonOutput: Bool) throws {
        let path = settingsPath()
        try ensureSettingsDirExists(path: path)

        var root: [String: Any] = readSettings(path: path) ?? [:]
        var hooks: [String: Any] = (root["hooks"] as? [String: Any]) ?? [:]

        var added: [String] = []
        var alreadyPresent: [String] = []

        for (event, command) in requiredHooks {
            var entries: [[String: Any]] = (hooks[event] as? [[String: Any]]) ?? []

            // Fast-path: exact matcher group with our exact command already present.
            let exactMatch = entries.contains { entry in
                guard let nested = entry["hooks"] as? [[String: Any]] else { return false }
                return nested.contains { ($0["command"] as? String) == command }
            }
            if exactMatch {
                alreadyPresent.append(event)
                continue
            }

            // Drop every current TermLoop-owned entry. User-owned hooks are untouched.
            entries = entries.filter { entry in
                if let cmd = entry["command"] as? String, isTermLoopOwnedClaudeCommand(cmd) {
                    return false
                }
                if let nested = entry["hooks"] as? [[String: Any]] {
                    let ownsAny = nested.contains {
                        isTermLoopOwnedClaudeCommand(($0["command"] as? String) ?? "")
                    }
                    return !ownsAny
                }
                return true
            }
            entries.append([
                "matcher": "",
                "hooks": [["type": "command", "command": command]]
            ])
            hooks[event] = entries
            added.append(event)
        }

        if !added.isEmpty {
            root["hooks"] = hooks
            let data = try JSONSerialization.data(
                withJSONObject: root,
                options: [.prettyPrinted, .sortedKeys]
            )
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }

        if jsonOutput {
            let payload: [String: Any] = [
                "path": path,
                "added": added,
                "already_present": alreadyPresent
            ]
            if let encoded = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]),
               let str = String(data: encoded, encoding: .utf8) {
                print(str)
            }
        } else {
            if added.isEmpty {
                print("Claude hooks already installed at \(path)")
            } else {
                print("Installed hooks at \(path): \(added.joined(separator: ", "))")
            }
        }
    }

    static func check(jsonOutput: Bool) throws {
        let path = settingsPath()
        let root = readSettings(path: path) ?? [:]
        let hooks = (root["hooks"] as? [String: Any]) ?? [:]

        var missing: [String] = []
        for (event, _) in requiredHooks {
            let suffix = probeSuffixes[event] ?? event
            let entries = (hooks[event] as? [[String: Any]]) ?? []
            let hasMatch = entries.contains { entry in
                guard let nested = entry["hooks"] as? [[String: Any]] else { return false }
                return nested.contains {
                    isInstalledTermLoopHookCommand(($0["command"] as? String) ?? "", suffix: suffix)
                }
            }
            if !hasMatch { missing.append(event) }
        }

        let installed = missing.isEmpty
        if jsonOutput {
            let payload: [String: Any] = [
                "installed": installed,
                "path": path,
                "missing": missing
            ]
            if let encoded = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]),
               let str = String(data: encoded, encoding: .utf8) {
                print(str)
            }
        } else {
            if installed {
                print("OK — all hooks installed at \(path)")
            } else {
                print("MISSING hooks at \(path): \(missing.joined(separator: ", "))")
            }
        }

        if !installed {
            exit(1)
        }
    }

    // MARK: - Helpers

    private static func settingsPath() -> String {
        let home = NSHomeDirectory()
        return (home as NSString).appendingPathComponent(".claude/settings.json")
    }

    private static func ensureSettingsDirExists(path: String) throws {
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: dir,
            withIntermediateDirectories: true
        )
    }

    private static func readSettings(path: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            return nil
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}
