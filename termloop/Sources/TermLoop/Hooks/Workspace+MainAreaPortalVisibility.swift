// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit

/// Extension adding a terminal portal visibility toggle for sidebar-owned
/// overlays that replace the main terminal area.
/// cmux's `WindowTerminalHostView` is a window-level NSView that sits above
/// SwiftUI — a SwiftUI `.overlay` (or a conditional swap that unmounts the
/// anchor) can't actually cover or hide it, because the portal is
/// explicitly designed to keep the hosted terminal visible across transient
/// SwiftUI tree changes. The only reliable way to get the terminal out of
/// the way while we render a full-area overlay is to tell the hosted
/// view to hide itself directly.
///
/// Lives in `Sources/TermLoop/Hooks/` (per K2) so upstream Workspace.swift
/// stays untouched.
@MainActor
extension Workspace {
    /// Toggle isHidden on every terminal panel's hosted NSView in this
    /// workspace. When hiding we also flip `visibleInUI` via
    /// `setVisibleInUI(false)` so the portal's reconcile logic agrees with
    /// the NSView state and doesn't fight us on the next sync pass.
    func termLoopSetTerminalsVisible(_ visible: Bool) {
        terminalPanels.forEach { setPortalVisibility(for: $0, visible: visible) }
    }

    /// Toggle every BrowserPanel's window-level portal for main-area routes.
    /// BrowserPanel portals intentionally survive transient SwiftUI anchor loss;
    /// route changes therefore need the same explicit lifecycle command that
    /// terminal panels use. `visible == true` only updates an existing portal
    /// entry; normal BrowserPanelView binding remains the source of truth for
    /// creating/rebinding anchors when the workspace view is rendered again.
    /// For that reason, `visible == true` is intentionally a no-op: blindly
    /// revealing every browser panel would bypass Bonsplit's per-pane selected
    /// tab visibility and can resurrect hidden browser tabs.
    func termLoopSetBrowserPortalsVisible(_ visible: Bool, source: String, zPriority: Int) {
        guard !visible else { return }
        browserPanels.forEach { browser in
            browser.hideBrowserPortalView(source: source)
        }
    }

    /// Hide all known AppKit portals for this workspace while preserving the
    /// Workspace object so ContentView can clear retiring state afterwards.
    func termLoopHideAllPortalsForMainArea(source: String) {
        terminalPanels.forEach { setPortalVisibility(for: $0, visible: false) }
        browserPanels.forEach { $0.hideBrowserPortalView(source: source) }
    }

    private var terminalPanels: [TerminalPanel] {
        panels.values.compactMap { $0 as? TerminalPanel }
    }

    private var browserPanels: [BrowserPanel] {
        panels.values.compactMap { $0 as? BrowserPanel }
    }

    private func setPortalVisibility(for terminal: TerminalPanel, visible: Bool) {
        terminal.hostedView.setVisibleInUI(visible)
        TerminalWindowPortalRegistry.updateEntryVisibility(
            for: terminal.hostedView,
            visibleInUI: visible
        )
        if !visible {
            TerminalWindowPortalRegistry.hideHostedView(terminal.hostedView)
        }
    }
}
