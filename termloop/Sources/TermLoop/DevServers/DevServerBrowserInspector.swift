// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
enum DevServerBrowserInspector {
    static let supportedMethods = [
        "browser.screenshot",
        "browser.eval",
        "browser.console.list",
        "browser.errors.list"
    ]

    static func context(for snapshot: DevServerRunSnapshot) -> [String: Any]? {
        guard let workspaceId = snapshot.workspaceId,
              let latestURL = snapshot.latestURL,
              let normalized = DevServerURLDetector.normalize(latestURL),
              let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
            return nil
        }
        let browser = workspace.panels.values
            .compactMap { $0 as? BrowserPanel }
            .first { panel in
                let panelURL = panel.currentURL?.absoluteString
                    ?? panel.preferredURLStringForOmnibar()
                return panelURL.flatMap(DevServerURLDetector.normalize(_:)) == normalized
            }
        guard let browser else { return nil }
        return [
            "workspace_id": workspaceId.uuidString,
            "surface_id": browser.id.uuidString,
            "url": normalized,
            "supported_methods": supportedMethods
        ]
    }
}
