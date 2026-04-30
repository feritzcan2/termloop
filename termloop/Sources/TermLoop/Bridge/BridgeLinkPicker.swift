// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

// termloop/Sources/TermLoop/Bridge/BridgeLinkPicker.swift
import Bonsplit
import SwiftUI

/// Submenu listing every other workspace in the same project. Tapping
/// one posts .termLoopOpenBridgeKickoff so the sidebar root can open
/// the kickoff sheet.
@MainActor
struct BridgeLinkPicker: View {
    let source: Workspace
    let tabManager: TabManager

    var body: some View {
        let workspaces = candidates()
        if workspaces.isEmpty {
            Text(String(localized: "bridge.contextMenu.noCandidates",
                        defaultValue: "No eligible workspaces",
                        table: "TermLoop"))
                .disabled(true)
        } else {
            ForEach(workspaces, id: \.id) { target in
                Button { post(source: source, target: target) }
                label: { Label(labelText(for: target), systemImage: "folder") }
            }
        }
    }

    /// Eligible workspaces, sorted by sidebar distance from the source.
    private func candidates() -> [Workspace] {
        let sourceIndex = tabManager.tabs.firstIndex(where: { $0.id == source.id }) ?? 0
        return tabManager.tabs
            .enumerated()
            .compactMap { (idx, target) -> (Workspace, Int)? in
                let result = BridgeCreationValidator.validateLive(
                    source: source.id, target: target.id
                )
                if case .ok = result {
                    return (target, abs(idx - sourceIndex))
                }
                #if DEBUG
                if case .error(let reason) = result {
                    let sMeta = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: source.id)
                    let tMeta = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: target.id)
                    dlog("bridge.picker reject src=\(source.id.uuidString.prefix(8)) dst=\(target.id.uuidString.prefix(8)) reason=\(reason) sAgent=\(sMeta.terminalAgentId ?? "nil") tAgent=\(tMeta.terminalAgentId ?? "nil") sProj=\(sMeta.projectId?.uuidString.prefix(8) ?? "nil") tProj=\(tMeta.projectId?.uuidString.prefix(8) ?? "nil")")
                }
                #endif
                return nil
            }
            .sorted { $0.1 < $1.1 }
            .map { $0.0 }
    }

    private func labelText(for ws: Workspace) -> String {
        let custom = ws.customTitle?.trimmingCharacters(in: .whitespaces)
        return (custom?.isEmpty == false ? custom! : ws.title)
    }

    private func post(source: Workspace, target: Workspace) {
        NotificationCenter.default.post(
            name: .termLoopOpenBridgeKickoff,
            object: nil,
            userInfo: [
                "leftWorkspaceId": source.id.uuidString,
                "rightWorkspaceId": target.id.uuidString
            ]
        )
    }
}
