// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
enum TerminalAgentStatusKeys {
    static func key(forAgentId agentId: String) -> String {
        TerminalAgentRegistry.shared.agent(id: agentId)?.statusKey ?? agentId
    }

    static func key(forWorkspaceId workspaceId: UUID) -> String? {
        TerminalAgentResolver.resolve(workspaceId: workspaceId)?.statusKey
    }
}
