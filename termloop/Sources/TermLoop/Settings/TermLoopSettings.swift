// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Singleton holding TermLoop-level user settings that are shared across
/// views and non-view subsystems (resolver, migration, socket dispatch).
/// Today's TermLoop settings are scattered `@AppStorage` wrappers inside
/// `TermLoopSettingsView.swift`; this singleton is the canonical read/write
/// surface for values that need to be accessed outside a view body.
@MainActor
final class TermLoopSettings: ObservableObject {
    static let shared = TermLoopSettings()

    /// Global fallback terminal-agent id, used when a workspace has no
    /// explicit override and the project has no default. First-run default
    /// is `claude`.
    @AppStorage("termloop.defaultTerminalAgentId")
    var defaultTerminalAgentId: String = "claude"
}
