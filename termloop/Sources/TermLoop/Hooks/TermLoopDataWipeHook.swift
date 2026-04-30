// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

#if DEBUG
extension TermLoopHooks {
    /// Debug menu entry point: wipes every piece of per-build state we can
    /// safely reset (UserDefaults for this bundle ID, upstream session JSON,
    /// TermLoop sidecar JSON) and quits the app so nothing re-saves. Shared
    /// resources under `~/Library/Application Support/termloop/` (socket,
    /// password, `termloop/instances.json`, `termloop/runs`, `termloop/logs`,
    /// `agent-templates`) are left untouched because they belong to other
    /// tagged builds as well.
    @MainActor
    static func promptDeleteAllBuildData() {
        let bundleId = Bundle.main.bundleIdentifier ?? "com.termloop.app"

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "termloop.deleteAllData.alert.title",
            defaultValue: "Delete all data for this build?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "termloop.deleteAllData.alert.message",
            defaultValue: """
                Resets UserDefaults and clears the saved session and TermLoop state for \(bundleId). \
                The app will quit immediately. Shared resources (socket, agent templates, TermLoop runs/logs) are not touched.
                """,
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "termloop.deleteAllData.alert.confirm",
            defaultValue: "Delete and Quit",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "termloop.deleteAllData.alert.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))

        guard alert.runModal() == .alertFirstButtonReturn else { return }

        performDeleteAllBuildData(bundleId: bundleId)

        NSApp.terminate(nil)
    }

    private static func performDeleteAllBuildData(bundleId: String) {
        let fm = FileManager.default
        let defaults = UserDefaults.standard
        defaults.removePersistentDomain(forName: bundleId)
        defaults.synchronize()

        guard let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return
        }
        let cmuxDir = appSupport.appendingPathComponent("cmux", isDirectory: true)
        let termloopDir = appSupport.appendingPathComponent("termloop", isDirectory: true)
        let safeBundleId = bundleId.replacingOccurrences(
            of: "[^A-Za-z0-9._-]",
            with: "_",
            options: .regularExpression
        )
        let targets = [
            cmuxDir.appendingPathComponent("session-\(safeBundleId).json", isDirectory: false),
            cmuxDir.appendingPathComponent("termloop-session-\(safeBundleId).json", isDirectory: false),
            termloopDir.appendingPathComponent("session-\(safeBundleId).json", isDirectory: false),
            termloopDir.appendingPathComponent("termloop-session-\(safeBundleId).json", isDirectory: false),
        ]
        for url in targets {
            try? fm.removeItem(at: url)
        }
    }
}
#endif
