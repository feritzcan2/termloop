// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit

extension ActiveAgentsPanel {
    func bridgeSourceTitle(
        _ bridge: WorkspaceBridge,
        workspaceById: [UUID: Workspace]
    ) -> String {
        guard let ws = workspaceById[bridge.leftWorkspaceId] else {
            return "Bridge"
        }
        let custom = ws.customTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return custom.isEmpty ? ws.title : custom
    }

    func bridgeRightTitle(
        _ bridge: WorkspaceBridge,
        workspaceById: [UUID: Workspace]
    ) -> String {
        if let override = bridge.rightWorkspaceTitleOverride?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            return override
        }
        guard let ws = workspaceById[bridge.rightWorkspaceId] else {
            return "Linked Workspace"
        }
        let custom = ws.customTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return custom.isEmpty ? ws.title : custom
    }

    func visibleWorkspaceIds(in sessions: [TerminalAgentLiveSession]) -> [UUID] {
        sessions.map(\.core.workspaceId)
    }

    func cachedBranchSummary(
        for workspaceId: UUID?,
        cache: [UUID: String]
    ) -> String? {
        guard let workspaceId else { return nil }
        return cache[workspaceId]
    }

    func buildBranchSummaryIndex(
        workspaceIds: [UUID],
        workspaceById: [UUID: Workspace]
    ) -> [UUID: String] {
        var result: [UUID: String] = [:]
        var seen: Set<UUID> = []
        for workspaceId in workspaceIds {
            guard seen.insert(workspaceId).inserted,
                  let workspace = workspaceById[workspaceId] else {
                continue
            }
            if let summary = workspace.sidebarBranchSummaryForFolderSharing()?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !summary.isEmpty {
                result[workspaceId] = summary
                continue
            }
            let metadataBranch = WorkspaceMetadataStore.shared.branch(for: workspace)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !metadataBranch.isEmpty {
                result[workspaceId] = metadataBranch
            }
        }
        return result
    }

    func elapsedLabel(since: Date) -> String {
        TermLoopSidebarTheme.elapsedLabel(since: since)
    }

    func durationLabel(_ start: Date, _ end: Date) -> String {
        let secs = max(0, Int(end.timeIntervalSince(start)))
        if secs < 60 { return "\(secs)s" }
        return "\(secs / 60)m"
    }

    func promptRenameWorkspace(tabId: UUID) {
        guard let tab = tabManager.tabs.first(where: { $0.id == tabId }) else {
            NSSound.beep()
            return
        }
        let alert = NSAlert()
        alert.messageText = String(localized: "dialog.renameWorkspace.title", defaultValue: "Rename Workspace")
        alert.informativeText = String(localized: "dialog.renameWorkspace.message", defaultValue: "Enter a custom name for this workspace.")
        let input = NSTextField(string: tab.customTitle ?? tab.title)
        input.placeholderString = String(localized: "dialog.renameWorkspace.placeholder", defaultValue: "Workspace name")
        input.frame = NSRect(x: 0, y: 0, width: 240, height: 22)
        alert.accessoryView = input
        alert.addButton(withTitle: String(localized: "common.rename", defaultValue: "Rename"))
        alert.addButton(withTitle: String(localized: "common.cancel", defaultValue: "Cancel"))
        let alertWindow = alert.window
        alertWindow.initialFirstResponder = input
        DispatchQueue.main.async {
            alertWindow.makeFirstResponder(input)
            input.selectText(nil)
        }
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return }
        tabManager.setCustomTitle(tabId: tab.id, title: input.stringValue)
    }
}
