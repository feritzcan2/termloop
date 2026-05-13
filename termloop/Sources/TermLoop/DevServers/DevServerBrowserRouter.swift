// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

@MainActor
enum DevServerBrowserRouter {
    static func install() {
        DevServerRunCoordinator.shared.onFirstURL = { snapshot, url in
            open(snapshot: snapshot, url: url, focus: true)
        }
        DevServerRunCoordinator.shared.onOpenURL = { snapshot, url, focus in
            open(snapshot: snapshot, url: url, focus: focus)
        }
    }

    @discardableResult
    static func open(snapshot: DevServerRunSnapshot, url: URL, focus: Bool = true) -> Bool {
        guard let workspaceId = snapshot.workspaceId else { return false }
        if focus, let tabManager = AppDelegate.shared?.tabManagerFor(tabId: workspaceId) {
            return tabManager.openBrowser(inWorkspace: workspaceId, url: url, preferSplitRight: true) != nil
        }
        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else { return false }
        if let paneId = workspace.topRightBrowserReusePane() ?? workspace.bonsplitController.focusedPaneId ?? workspace.bonsplitController.allPaneIds.first {
            return workspace.newBrowserSurface(inPane: paneId, url: url, focus: focus) != nil
        }
        guard let sourcePanelId = workspace.focusedPanelId ?? workspace.panels.keys.sorted(by: { $0.uuidString < $1.uuidString }).first else {
            return false
        }
        return workspace.newBrowserSplit(from: sourcePanelId, orientation: .horizontal, url: url, focus: focus) != nil
    }
}
