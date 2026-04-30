// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

/// Child-exit on the last local panel should not immediately tear down the
/// workspace. Instead, prompt before closing so the user keeps the option
/// to stay in the workspace. Lives here so
/// `TabManager.closePanelAfterChildExited` stays a single-line hook call
/// inside marker blocks (K2/K3). The alert assembly is inlined (rather
/// than calling TabManager's private `confirmClose`) so the extension is
/// self-contained; it still honors `confirmCloseHandler` for tests.
@MainActor
extension TabManager {
    /// Returns `true` when the prompt has already handled the exit (caller
    /// should early-return); `false` when the workspace isn't in the
    /// "last local panel" state and upstream teardown should run.
    func confirmCloseExitedLastLocalSurface(tab: Workspace, surfaceId: UUID) -> Bool {
        guard tab.panels.count == 1,
              !tab.isRemoteWorkspace,
              tab.panels[surfaceId] != nil else {
            return false
        }

        let title = String(localized: "dialog.childExitedTerminal.title",
                           defaultValue: "Delete terminal?")
        let message = String(
            localized: "dialog.childExitedTerminal.message",
            defaultValue: "The terminal process exited. Close this terminal?"
        )
        let acceptCmdD = tabs.count <= 1

        let shouldClose = presentChildExitConfirmation(
            title: title,
            message: message,
            acceptCmdD: acceptCmdD
        )
        guard shouldClose else { return true }

        if tabs.count <= 1 {
            if let window {
                window.performClose(nil)
            } else {
                AppDelegate.shared?.closeMainWindowContainingTabId(tab.id)
            }
        } else {
            closeWorkspace(tab)
        }
        return true
    }

    private func presentChildExitConfirmation(
        title: String,
        message: String,
        acceptCmdD: Bool
    ) -> Bool {
        if let confirmCloseHandler {
            return confirmCloseHandler(title, message, acceptCmdD)
        }
        _ = acceptCmdD

        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "dialog.closeTab.close",
                                          defaultValue: "Close"))
        alert.addButton(withTitle: String(localized: "dialog.closeTab.cancel",
                                          defaultValue: "Cancel"))

        if let closeButton = alert.buttons.first {
            closeButton.keyEquivalent = "\r"
            closeButton.keyEquivalentModifierMask = []
            alert.window.defaultButtonCell = closeButton.cell as? NSButtonCell
            alert.window.initialFirstResponder = closeButton
        }
        if let cancelButton = alert.buttons.dropFirst().first {
            cancelButton.keyEquivalent = "\u{1b}"
        }

        if NSApp.activationPolicy() == .regular {
            NSApp.activate(ignoringOtherApps: true)
        }

        return alert.runModal() == .alertFirstButtonReturn
    }
}
