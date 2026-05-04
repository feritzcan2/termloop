// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Drives the main-area swap so the Git Changes view can replace Ghostty
/// instead of opening as a modal sheet. The `@Published` presentation drives
/// the overlay switch in `AgentMainAreaOverlaySwap`; portal visibility is
/// handled centrally by the main-area presentation coordinator so this store
/// does not duplicate that bookkeeping.
@MainActor
final class GitChangesMainAreaStore: ObservableObject {
    static let shared = GitChangesMainAreaStore()

    @Published private(set) var presentation: WorktreeChangesPresentation?

    private init() {}

    func show(_ presentation: WorktreeChangesPresentation) {
        self.presentation = presentation
    }

    func close() {
        guard presentation != nil else { return }
        self.presentation = nil
    }

    func closeIfShowing(workspaceId: UUID) {
        if presentation?.workspaceId == workspaceId {
            presentation = nil
        }
    }
}
