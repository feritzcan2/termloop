// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Drives the in-app TermLoop Settings overlay. When `isOpen` is true the
/// `AgentMainAreaOverlaySwap` swaps the Ghostty terminal anchor for the
/// `TermLoopSettingsPage` view (see `System/Systems/UILayout/UILayout.md`).
///
/// Terminal NSView hide/unhide is **not** done here on purpose. The swap's
/// `onChange(of: overlayMode)` handler already calls
/// `setAllWorkspaceTerminalsVisible(...)` from the unified
/// `shouldShowWorkspaceTerminals(for:)` reducer, so a manual call here would
/// race that reducer and create a terminal-visible flicker when closing
/// Settings while another overlay (Markdown Document / Git Changes /
/// Context Bank / Agents) is still active. Match the overlay-store pattern:
/// just flip
/// the `@Published` flag and let the swap reconcile.
///
/// Replaces the legacy standalone settings NSWindow — the menu shortcut
/// (`Cmd+Option+,`) and the titlebar gear button both route through here.
@MainActor
final class TermLoopSettingsPageStore: ObservableObject {
    static let shared = TermLoopSettingsPageStore()

    @Published private(set) var isOpen: Bool = false

    private init() {}

    func open() {
        guard !isOpen else { return }
        isOpen = true
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
    }

    func toggle() {
        if isOpen { close() } else { open() }
    }
}
