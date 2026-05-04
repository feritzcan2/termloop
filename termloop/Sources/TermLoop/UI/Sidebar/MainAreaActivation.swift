// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Single entry point for "user clicked an agent / worktree / bridge row to
/// view its terminal." Centralises the three side-effects that must travel
/// together so no caller forgets one:
///
///   1. Close every main-area overlay (Markdown document, GitChanges,
///      AbilityDetail). Otherwise the overlay outlives the row
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

        // 1. Close overlays/settings first — synchronous mutations on
        //    @Published properties so the overlay swap recomputes against a
        //    clean state.
        MainAreaPresentationCoordinator.shared.handleNavigationEvent(
            .workspaceActivation(workspaceId),
            tabManager: tabManager
        )

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

    static func activateAbilityDetailSurface(abilityId: String) {
        MainAreaPresentationCoordinator.shared.handleNavigationEvent(.abilityActivation(abilityId))
        AbilityDetailUIState.shared.show(abilityId)

        let defaults = UserDefaults.standard
        defaults.set(TermLoopSidebarTab.work.rawValue, forKey: TermLoopSidebarTab.storageKey)
        defaults.set(WorkSubTab.agents.rawValue, forKey: WorkSubTab.storageKey)
    }

    /// Ability-agent rows own a split surface: ability detail on top, live
    /// terminal below. Keep that route selected when focusing or re-opening an
    /// existing ability agent instead of treating it like a plain terminal.
    static func activateAbilityWorkspaceTerminal(
        _ workspaceId: UUID,
        abilityId: String,
        on tabManager: TabManager?
    ) {
        guard let tabManager else { return }

        activateAbilityDetailSurface(abilityId: abilityId)

        if tabManager.selectedTabId != workspaceId {
            tabManager.selectedTabId = workspaceId
        }
        TermLoopHooks.applyMainAreaPresentation(tabManager: tabManager, reason: "abilityWorkspaceActivation")
    }

    /// Idempotent close of every main-area overlay store. Each store's
    /// `close()` short-circuits when already closed, so paranoid cleanup
    /// from context-change observers stays free of cost.
    static func closeAllMainAreaOverlays() {
        MarkdownDocumentStore.shared.close()
        GitChangesMainAreaStore.shared.close()
        AbilityDetailUIState.shared.close()
    }
}
