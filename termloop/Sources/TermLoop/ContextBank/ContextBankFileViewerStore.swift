// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// When `openFile` is non-nil the main area swaps from Ghostty to the
/// read-only markdown viewer. Follows the same overlay pattern documented in
/// `System/Systems/UILayout/UILayout.md` (see `AgentMainAreaOverlayMode` in
/// `TermLoopHooks.swift`). Visibility-hiding of the workspace terminals is
/// done by the overlay swap container in one place — this store just owns
/// the selection.
@MainActor
final class ContextBankFileViewerStore: ObservableObject {
    static let shared = ContextBankFileViewerStore()

    @Published var openFile: ContextBankFile?

    private init() {}

    func open(_ file: ContextBankFile) {
        openFile = file
    }

    func close() {
        guard openFile != nil else { return }
        openFile = nil
    }
}
