// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// What the user has selected in the Context Bank tree. Drives the
/// right-pane view: a file selection shows the file's content; a
/// suggestion selection shows its diff + reasoning + Accept/Reject.
/// `.none` is the empty state.
enum ContextBankSelection: Equatable, Hashable {
    case none
    case file(URL)
    /// `id` is `ContextBankSuggestion.id`. The view looks the suggestion
    /// up in the store rather than embedding it so updates flow through
    /// the published array (status changes, deletions on accept/reject).
    case suggestion(UUID)
}
