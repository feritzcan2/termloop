// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit

extension TabManager {
    /// Close entry point for the sidebar's X-button popover confirmation.
    /// The popover has already captured the user's intent, so we skip the
    /// center-screen `NSAlert` path that `closeWorkspaceWithConfirmation`
    /// uses — but still respect the child-exit hook
    /// (`TermLoopHooks.workspaceWillClose`) so agent/terminal running
    /// confirmations stay consistent across entry points.
    @MainActor
    func closeWorkspaceFromSidebarPopover(_ workspace: Workspace) {
        let continuation: (Bool) -> Void = { [weak self] shouldClose in
            guard shouldClose, let self else { return }
            self.finalizeSidebarPopoverClose(workspace)
        }
        if TermLoopHooks.workspaceWillClose(workspace: workspace, completion: continuation) {
            return
        }
        finalizeSidebarPopoverClose(workspace)
    }

    @MainActor
    private func finalizeSidebarPopoverClose(_ workspace: Workspace) {
        if tabs.count <= 1 {
            if let window {
                window.performClose(nil)
            } else {
                AppDelegate.shared?.closeMainWindowContainingTabId(workspace.id)
            }
        } else {
            closeWorkspace(workspace)
        }
    }
}
