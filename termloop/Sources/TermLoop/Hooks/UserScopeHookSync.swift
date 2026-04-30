// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Coordinator for user-scope hook install + project-scope cleanup.
///
/// All callers are `@MainActor` (TerminalAgentRunner, TermLoopSocketCommands,
/// ClaudeRestoreCoordinator, TermLoopHooks.scheduleStartupAgentRestoreSelfHeal).
/// The enum is `@MainActor` too so install runs synchronously before the agent
/// process spawns — async dispatch would race the first SessionStart hook.
@MainActor
enum UserScopeHookSync {
    private static let logger = Logger(subsystem: "com.termloop.fork", category: "hook-sync")
    private static var installedThisProcess: Set<HookManagedAgent> = []
    private static var cleanedThisProcess: Set<String> = []

    static func ensureInstalled(for agent: HookManagedAgent) {
        if installedThisProcess.contains(agent) { return }
        // Cache only on success so a transient failure (permission denied,
        // disk full, file locked) gets retried on the next launch callsite
        // rather than being silently skipped for the rest of the process.
        if TermLoopHooks.ensureHooksInstalled(for: agent) {
            installedThisProcess.insert(agent)
        }
    }

    static func cleanupProjectScope(at projectURL: URL, for agent: HookManagedAgent) {
        ProjectScopeHookCleaner.cleanup(projectURL: projectURL, for: agent)
    }

    static func cleanupProjectScopeAllAgents(at projectURL: URL) {
        let key = projectURL.standardizedFileURL.path
        if cleanedThisProcess.contains(key) { return }
        ProjectScopeHookCleaner.cleanupAllAgents(projectURL: projectURL)
        cleanedThisProcess.insert(key)
    }
}
