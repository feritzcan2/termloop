// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Right-click menu for the sidebar's `+` button. Lists every registered
/// `TerminalAgent` (Claude, Codex, Gemini, OpenCode, …) plus a "Default"
/// entry that defers to the project / global default. Selecting an entry
/// calls `onPick(agentId)` with `nil` meaning "use default".
@MainActor
struct NewWorkspaceAgentPickerMenu: View {
    @ObservedObject private var registry = TerminalAgentRegistry.shared
    let onPick: (_ agentId: String?) -> Void

    var body: some View {
        Button(String(
            localized: "folder.newWorkspace.default",
            defaultValue: "New Workspace (Default Agent)",
            table: "TermLoop"
        )) {
            onPick(nil)
        }
        Divider()
        ForEach(registry.agents, id: \.id) { agent in
            Button {
                onPick(agent.id)
            } label: {
                Label(agent.displayName, systemImage: agent.icon)
            }
        }
    }
}
