// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Per-agent "last used permission mode" persistence. Drives the
/// fast-create flow: when the user clicks "Add Claude", the workspace
/// launches with the mode they used last time for that agent.
///
/// Storage: `UserDefaults.standard` keyed `termloop.lastMode.<agentId>`.
/// Default-agent persistence lives on `TermLoopSettings.shared
/// .defaultTerminalAgentId` — read it through that singleton, not here.
enum PermissionModePersistence {
    private static let lastModePrefix = "termloop.lastMode."

    static func lastUsedMode(forAgentId agentId: String) -> AgentTemplate.PermissionMode? {
        let raw = UserDefaults.standard.string(forKey: lastModePrefix + agentId)
        return raw.flatMap { AgentTemplate.PermissionMode(rawValue: $0) }
    }

    static func setLastUsedMode(
        _ mode: AgentTemplate.PermissionMode,
        forAgentId agentId: String
    ) {
        UserDefaults.standard.set(mode.rawValue, forKey: lastModePrefix + agentId)
    }

    /// Resolves the mode the fast-create flow should launch with for the
    /// given agent: last-used if any, else the first catalog entry, else
    /// `.bypassPermissions` for unknown agents (matches legacy default).
    static func resolveLaunchMode(forAgentId agentId: String) -> AgentTemplate.PermissionMode {
        if let last = lastUsedMode(forAgentId: agentId) { return last }
        if let firstCatalog = PermissionModeCatalog.surfaceableModes(forAgentId: agentId).first {
            return firstCatalog.mode
        }
        return .bypassPermissions
    }
}
