// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Per-window task selection. There is intentionally **no** `static let shared`.
/// A singleton would let two windows fight over which task is "selected" and
/// fight in subtle ways (sidebar drill-in flicker, detail pane confusion).
/// Reviewers must reject any change introducing one.
@MainActor
public final class TaskSelectionStore: ObservableObject {
    @Published public private(set) var selectedTaskId: UUID?

    public init() {}

    public func select(_ id: UUID?) {
        guard selectedTaskId != id else { return }
        selectedTaskId = id
    }
}
