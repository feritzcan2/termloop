// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// CLI entry point for `termloop install-claude-hooks` and `termloop check-claude-hooks`.
/// Reads and writes `~/.claude/settings.json` idempotently: merges the six
/// hook events teleport needs while preserving any unrelated entries the user
/// already has.
enum ClaudeHookInstaller {
    private static let logger = Logger(subsystem: "com.termloop.fork", category: "claude-hooks")

    private struct UnsupportedSettingsShapeError: Error, LocalizedError {
        let events: [String]

        var errorDescription: String? {
            "Claude settings.json has unsupported hook shape for: \(events.joined(separator: ", ")). Refusing to overwrite those entries."
        }
    }

    /// Required hook event → persisted shell command.
    ///
    /// The termloop binary is resolved via `TERMLOOP_BUNDLED_CLI_PATH` (set
    /// when TermLoop launches the agent) with a `$PATH` fallback. Env guards
    /// short-circuit to `echo '{}'` outside an TermLoop launch or when
    /// disable flags are set, so stale settings between launches are a safe
    /// no-op.
    static var requiredHooks: [String: String] {
        ClaudeSettingsJSON.requiredHooks
    }

    /// Substring used by `ClaudeHooksStatus.probe` to recognize a valid entry.
    /// Must match the CLI subcommand form written above.
    static var probeSuffixes: [String: String] {
        ClaudeSettingsJSON.probeSuffixes
    }

    static func install(jsonOutput: Bool) throws {
        let path = settingsPath()
        try ensureSettingsDirExists(path: path)

        let original = try readSettingsContent(path: path)
        let mutation = try ClaudeSettingsJSON.installTransform(original)
        var finalMutation = mutation
        if mutation.changed {
            let latest = try readSettingsContent(path: path)
            finalMutation = latest == original
                ? mutation
                : try ClaudeSettingsJSON.installTransform(latest)
            if finalMutation.changed {
                try finalMutation.content.write(toFile: path, atomically: true, encoding: .utf8)
                let eventCount = finalMutation.addedEvents.count + finalMutation.repairedEvents.count
                logger.info("claude.settings.write event_count=\(eventCount, privacy: .public)")
            }
        }

        if jsonOutput {
            let payload: [String: Any] = [
                "path": path,
                "changed": finalMutation.changed,
                "added": finalMutation.addedEvents,
                "repaired": finalMutation.repairedEvents,
                "already_present": finalMutation.alreadyPresentEvents,
                "unsupported": finalMutation.unsupportedEvents,
            ]
            if let encoded = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]),
               let str = String(data: encoded, encoding: .utf8) {
                print(str)
            }
        } else {
            if finalMutation.changed {
                let changedEvents = (finalMutation.addedEvents + finalMutation.repairedEvents)
                    .joined(separator: ", ")
                print("Installed hooks at \(path): \(changedEvents)")
            } else if finalMutation.unsupportedEvents.isEmpty {
                print("Claude hooks already installed at \(path)")
            } else {
                print("Claude hooks need manual review at \(path): unsupported hook shape for \(finalMutation.unsupportedEvents.joined(separator: ", "))")
            }
        }

        if !finalMutation.unsupportedEvents.isEmpty {
            throw UnsupportedSettingsShapeError(events: finalMutation.unsupportedEvents)
        }
    }

    static func check(jsonOutput: Bool) throws {
        let path = settingsPath()
        let mutation = try ClaudeSettingsJSON.installTransform(readSettingsContent(path: path))
        let needsInstall = mutation.changed
        let installed = !needsInstall && mutation.unsupportedEvents.isEmpty
        if jsonOutput {
            let payload: [String: Any] = [
                "installed": installed,
                "path": path,
                "needs_install": needsInstall,
                "added_if_installed": mutation.addedEvents,
                "repaired_if_installed": mutation.repairedEvents,
                "unsupported": mutation.unsupportedEvents,
            ]
            if let encoded = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]),
               let str = String(data: encoded, encoding: .utf8) {
                print(str)
            }
        } else {
            if installed {
                print("OK — all hooks installed at \(path)")
            } else if !mutation.unsupportedEvents.isEmpty {
                print("UNSUPPORTED hook shape at \(path): \(mutation.unsupportedEvents.joined(separator: ", "))")
            } else {
                let missingOrStale = mutation.addedEvents + mutation.repairedEvents
                print("MISSING or STALE hooks at \(path): \(missingOrStale.joined(separator: ", "))")
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

    private static func readSettingsContent(path: String) throws -> String {
        guard FileManager.default.fileExists(atPath: path) else {
            return ""
        }
        return try String(contentsOfFile: path, encoding: .utf8)
    }
}
