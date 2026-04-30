// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Single entry point for "user clicked an agent / worktree / bridge row to
/// view its terminal." Centralises the three side-effects that must travel
/// together so no caller forgets one:
///
///   1. Close every main-area overlay (DocEditor, ContextBank file viewer,
///      GitChanges, AbilityDetail). Otherwise the overlay outlives the row
///      tap and the user is forced to hit an explicit close button.
///   2. If the top sidebar tab is `.agents` (catalog), flip it back to
///      `.work + .loop` so the terminal can actually surface — the catalog
///      page wins the overlay priority chain otherwise.
///   3. Set `tabManager.selectedTabId` last, so by the time visibility
///      observers fire the overlay/sidebar state is already consistent.
@MainActor
enum MainAreaActivation {
    static func activateWorkspaceTerminal(_ workspaceId: UUID, on tabManager: TabManager?) {
        guard let tabManager else { return }

        // 1. Close overlays first — synchronous mutations on @Published
        //    properties so the overlay swap recomputes against a clean state.
        closeAllMainAreaOverlays()

        // 2. If user is on the agents catalog top-tab, flip back to work/loop.
        //    Direct UserDefaults writes propagate to all `@AppStorage`
        //    bindings observing the same keys.
        let defaults = UserDefaults.standard
        if defaults.string(forKey: TermLoopSidebarTab.storageKey) == TermLoopSidebarTab.agents.rawValue {
            defaults.set(TermLoopSidebarTab.work.rawValue, forKey: TermLoopSidebarTab.storageKey)
            defaults.set(WorkSubTab.loop.rawValue, forKey: WorkSubTab.storageKey)
        }

        // 3. Select the workspace last so visibility observers see the
        //    final state. Dedupe so re-tapping the active row does not
        //    re-fire `selectedTabId`'s downstream observers.
        if tabManager.selectedTabId != workspaceId {
            tabManager.selectedTabId = workspaceId
        }
    }

    /// Idempotent close of every main-area overlay store. Each store's
    /// `close()` short-circuits when already closed, so paranoid cleanup
    /// from context-change observers stays free of cost.
    static func closeAllMainAreaOverlays() {
        DocEditorStore.shared.close()
        ContextBankFileViewerStore.shared.close()
        GitChangesMainAreaStore.shared.close()
        AbilityDetailUIState.shared.close()
    }
}
