// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Right-click → "Permission Mode" submenu shown inside the workspace
/// context menu. Snapshot-reads `WorkspaceMetadataStore` once when the
/// menu opens — does NOT subscribe via `@ObservedObject` because that
/// store fires on every `report_claude_session` socket event during an
/// active turn, which would dismiss the open NSMenu (same pattern
/// `WorktreeMenuItems` follows in `TermLoopSidebarInjection`).
@MainActor
struct PermissionModeContextMenu: View {
    let workspace: Workspace

    var body: some View {
        let store = WorkspaceMetadataStore.shared
        if let agentId = store
            .terminalAgentId(for: workspace.id)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !agentId.isEmpty {
            let modes = PermissionModeCatalog.surfaceableModes(forAgentId: agentId)
            if !modes.isEmpty {
                let currentRaw = store.permissionMode(for: workspace.id)
                Menu(String(
                    localized: "contextMenu.permissionMode.title",
                    defaultValue: "Permission Mode",
                    table: "TermLoop"
                )) {
                    ForEach(modes) { option in
                        Button {
                            select(mode: option.mode, agentId: agentId)
                        } label: {
                            Label(
                                option.title,
                                systemImage: option.mode.rawValue == currentRaw
                                    ? "checkmark"
                                    : "circle"
                            )
                        }
                    }
                    Divider()
                    Text(String(
                        localized: "contextMenu.permissionMode.restartHint",
                        defaultValue: "Takes effect on next launch.",
                        table: "TermLoop"
                    ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func select(mode: AgentTemplate.PermissionMode, agentId: String) {
        WorkspaceMetadataStore.shared.setPermissionMode(
            mode.rawValue,
            for: workspace.id
        )
        PermissionModePersistence.setLastUsedMode(mode, forAgentId: agentId)
    }
}
