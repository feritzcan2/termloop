// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Probes `~/.claude/settings.json` for the six Claude Code hooks that the
/// teleport feature relies on (SessionStart, PreToolUse, UserPromptSubmit,
/// Stop, SessionEnd, Notification). Result is cached for 5 seconds to keep
/// `workspace.list` hot-path cheap — the file is tiny but this still runs
/// on every summary build.
@MainActor
final class ClaudeHooksStatus: ObservableObject {
    static let shared = ClaudeHooksStatus()

    @Published private(set) var installed: Bool = false
    private var lastCheck: Date = .distantPast
    private let cacheInterval: TimeInterval = 5.0

    private init() {
        refreshIfStale()
    }

    /// Substring each required hook's `command` must contain. Values are the
    /// stable CLI subcommand suffixes written by `ClaudeHookInstaller`.
    /// PreToolUse is included so the probe catches the global installer's
    /// output end-to-end.
    static let requiredHooks: [String: String] = [
        "SessionStart":     "claude-hook session-start",
        "PreToolUse":       "claude-hook pre-tool-use",
        "UserPromptSubmit": "claude-hook prompt-submit",
        "Stop":              "claude-hook stop",
        "SessionEnd":       "claude-hook session-end",
        "Notification":     "claude-hook notification"
    ]

    private static func isTermLoopHookCommand(_ command: String, suffix: String) -> Bool {
        guard command.contains(suffix) else { return false }
        return command.contains("TERMLOOP_WORKSPACE_ID")
            || command.contains("TERMLOOP_SURFACE_ID")
            || command.contains("TERMLOOP_BUNDLED_CLI_PATH")
    }

    func refreshIfStale() {
        if Date().timeIntervalSince(lastCheck) >= cacheInterval {
            installed = Self.probe()
            lastCheck = Date()
        }
    }

    /// Force refresh (used by the install CLI after writing settings).
    func markDirty() {
        lastCheck = .distantPast
        refreshIfStale()
    }

    static func probe() -> Bool {
        let path = settingsPath()
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hooks = root["hooks"] as? [String: Any] else {
            return false
        }
        for (event, expectedCommandSuffix) in requiredHooks {
            guard let entries = hooks[event] as? [[String: Any]] else { return false }
            let match = entries.contains { entry in
                guard let nested = entry["hooks"] as? [[String: Any]] else { return false }
                return nested.contains {
                    isTermLoopHookCommand(($0["command"] as? String) ?? "", suffix: expectedCommandSuffix)
                }
            }
            if !match { return false }
        }
        return true
    }

    static func settingsPath() -> String {
        let home = NSHomeDirectory()
        return (home as NSString).appendingPathComponent(".claude/settings.json")
    }
}

/// Probes `~/.codex/hooks.json` and `~/.codex/config.toml` for the Codex hook
/// wiring that the terminal-agent activity pipeline relies on. Result is
/// cached for a short interval so repeated UI summaries don't thrash disk.
@MainActor
final class CodexHooksStatus: ObservableObject {
    static let shared = CodexHooksStatus()

    @Published private(set) var installed: Bool = false
    @Published private(set) var reviewRequired: Bool
    @Published private(set) var reviewWorkspaceId: UUID?
    private var lastCheck: Date = .distantPast
    private let cacheInterval: TimeInterval = 5.0

    private static let reviewProbeDefaultSessionBudget = 5
    private static let reviewProbeRemainingSessionsKey = "termloop.codexHooks.reviewProbeRemainingSessions"
    private static let reviewRequiredKey = "termloop.codexHooks.reviewRequired"
    private static let reviewWorkspaceIdKey = "termloop.codexHooks.reviewWorkspaceId"

    private init() {
        let defaults = UserDefaults.standard
        self.reviewRequired = defaults.bool(forKey: Self.reviewRequiredKey)
        if let rawWorkspaceId = defaults.string(forKey: Self.reviewWorkspaceIdKey) {
            self.reviewWorkspaceId = UUID(uuidString: rawWorkspaceId)
        } else {
            self.reviewWorkspaceId = nil
        }
        refreshIfStale()
    }

    static let requiredHooks: [String: String] = [
        "SessionStart":      "codex-hook session-start",
        "UserPromptSubmit":  "codex-hook prompt-submit",
        "Stop":              "codex-hook stop",
        "PermissionRequest": "codex-hook permission-request"
    ]

    func refreshIfStale() {
        if Date().timeIntervalSince(lastCheck) >= cacheInterval {
            installed = Self.probe()
            lastCheck = Date()
        }
    }

    func markDirty() {
        lastCheck = .distantPast
        refreshIfStale()
    }

    func resetReviewProbeBudget() {
        UserDefaults.standard.set(Self.reviewProbeDefaultSessionBudget, forKey: Self.reviewProbeRemainingSessionsKey)
    }

    func claimReviewProbeSession(workspaceId: UUID) -> Bool {
        guard installed, !reviewRequired else { return false }
        let defaults = UserDefaults.standard
        let remaining: Int
        if defaults.object(forKey: Self.reviewProbeRemainingSessionsKey) == nil {
            remaining = Self.reviewProbeDefaultSessionBudget
        } else {
            remaining = defaults.integer(forKey: Self.reviewProbeRemainingSessionsKey)
        }
        guard remaining > 0 else { return false }
        defaults.set(remaining - 1, forKey: Self.reviewProbeRemainingSessionsKey)
        reviewWorkspaceId = workspaceId
        defaults.set(workspaceId.uuidString, forKey: Self.reviewWorkspaceIdKey)
        return true
    }

    func markReviewRequired(workspaceId: UUID?) {
        reviewRequired = true
        if let workspaceId {
            reviewWorkspaceId = workspaceId
            UserDefaults.standard.set(workspaceId.uuidString, forKey: Self.reviewWorkspaceIdKey)
        }
        UserDefaults.standard.set(true, forKey: Self.reviewRequiredKey)
    }

    func markCodexHookObserved() {
        guard reviewRequired || reviewWorkspaceId != nil else {
            UserDefaults.standard.set(0, forKey: Self.reviewProbeRemainingSessionsKey)
            return
        }
        reviewRequired = false
        reviewWorkspaceId = nil
        let defaults = UserDefaults.standard
        defaults.set(false, forKey: Self.reviewRequiredKey)
        defaults.removeObject(forKey: Self.reviewWorkspaceIdKey)
        defaults.set(0, forKey: Self.reviewProbeRemainingSessionsKey)
    }

    static func outputIndicatesReviewRequired(_ text: String) -> Bool {
        let lowercased = text.lowercased()
        return lowercased.contains("hooks need review before they can run")
            || lowercased.contains("hook needs review before it can run")
            || lowercased.contains("open /hooks to review")
            || lowercased.contains("open /hooks")
    }

    static func probe() -> Bool {
        let fm = FileManager.default
        let hooksPath = hooksFilePath()
        let configPath = configTomlPath()
        guard fm.fileExists(atPath: hooksPath),
              fm.fileExists(atPath: configPath),
              let hooksData = try? Data(contentsOf: URL(fileURLWithPath: hooksPath)),
              let root = try? JSONSerialization.jsonObject(with: hooksData) as? [String: Any],
              let hooks = root["hooks"] as? [String: Any],
              let config = try? String(contentsOfFile: configPath, encoding: .utf8),
              config.contains("codex_hooks = true"),
              config.contains("[mcp_servers.termloop]"),
              config.contains("termloop-mcp") else {
            return false
        }

        for (event, expectedCommandSuffix) in requiredHooks {
            guard let entries = hooks[event] as? [[String: Any]] else { return false }
            let match = entries.contains { entry in
                guard let nested = entry["hooks"] as? [[String: Any]] else { return false }
                return nested.contains {
                    isInstalledTermLoopCodexCommand(
                        ($0["command"] as? String) ?? "",
                        suffix: expectedCommandSuffix
                    )
                }
            }
            if !match { return false }
        }
        return true
    }

    private static func isInstalledTermLoopCodexCommand(_ command: String, suffix: String) -> Bool {
        guard command.contains(suffix) else { return false }
        return command.contains("TERMLOOP_WORKSPACE_ID")
            || command.contains("TERMLOOP_SURFACE_ID")
            || command.contains("TERMLOOP_BUNDLED_CLI_PATH")
            || command.contains("termloop codex-hook")
    }

    static func codexHomePath() -> String {
        if let override = ProcessInfo.processInfo.environment["CODEX_HOME"],
           !override.isEmpty {
            return NSString(string: override).expandingTildeInPath
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".codex")
    }

    static func hooksFilePath() -> String {
        (codexHomePath() as NSString).appendingPathComponent("hooks.json")
    }

    static func configTomlPath() -> String {
        (codexHomePath() as NSString).appendingPathComponent("config.toml")
    }
}

@MainActor
final class GeminiHooksStatus: ObservableObject {
    static let shared = GeminiHooksStatus()

    @Published private(set) var installed: Bool = false
    private var lastCheck: Date = .distantPast
    private let cacheInterval: TimeInterval = 5.0

    private init() {
        refreshIfStale()
    }

    static let requiredHooks: [String: String] = [
        "SessionStart": "gemini-hook session-start",
        "BeforeAgent": "gemini-hook prompt-submit",
        "AfterAgent": "gemini-hook stop",
        "SessionEnd": "gemini-hook session-end"
    ]

    func refreshIfStale() {
        if Date().timeIntervalSince(lastCheck) >= cacheInterval {
            installed = Self.probe()
            lastCheck = Date()
        }
    }

    func markDirty() {
        lastCheck = .distantPast
        refreshIfStale()
    }

    static func probe() -> Bool {
        let path = settingsPath()
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hooks = root["hooks"] as? [String: Any] else {
            return false
        }

        for (event, expectedCommandSuffix) in requiredHooks {
            guard let entries = hooks[event] as? [[String: Any]] else { return false }
            let match = entries.contains { entry in
                guard let nested = entry["hooks"] as? [[String: Any]] else { return false }
                return nested.contains { ($0["command"] as? String)?.contains(expectedCommandSuffix) == true }
            }
            if !match { return false }
        }
        return true
    }

    static func settingsPath() -> String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".gemini/settings.json")
    }
}

@MainActor
final class OpenCodeHooksStatus: ObservableObject {
    static let shared = OpenCodeHooksStatus()

    @Published private(set) var installed: Bool = false
    private var lastCheck: Date = .distantPast
    private let cacheInterval: TimeInterval = 5.0

    private init() {
        refreshIfStale()
    }

    private static let hookMarker = "termloop opencode-hook"

    func refreshIfStale() {
        if Date().timeIntervalSince(lastCheck) >= cacheInterval {
            installed = Self.probe()
            lastCheck = Date()
        }
    }

    func markDirty() {
        lastCheck = .distantPast
        refreshIfStale()
    }

    static func probe() -> Bool {
        guard let content = try? String(contentsOfFile: pluginPath(), encoding: .utf8) else {
            return false
        }
        return content.contains(hookMarker)
    }

    static func configDirectoryPath() -> String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".config/opencode")
    }

    static func pluginsDirectoryPath() -> String {
        (configDirectoryPath() as NSString).appendingPathComponent("plugins")
    }

    static func pluginPath() -> String {
        (pluginsDirectoryPath() as NSString).appendingPathComponent("termloop-opencode.js")
    }
}
