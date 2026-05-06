// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Per-window task selection. There is intentionally **no** `static let shared`.
/// A singleton would let two windows fight over which task is "selected" and
/// fight in subtle ways (sidebar drill-in flicker, selected task confusion).
/// Reviewers must reject any change introducing one.
@MainActor
public final class TaskSelectionStore: ObservableObject {
    @Published public private(set) var selectedTaskId: UUID?
    @Published public private(set) var inlineTerminalWorkspaceId: UUID?

    public init() {}

    @discardableResult
    public func select(_ id: UUID?) -> Bool {
        guard selectedTaskId != id else { return false }
        selectedTaskId = id
        return true
    }

    @discardableResult
    public func openInlineTerminal(workspaceId: UUID) -> Bool {
        guard inlineTerminalWorkspaceId != workspaceId else { return false }
        inlineTerminalWorkspaceId = workspaceId
        return true
    }

    @discardableResult
    public func closeInlineTerminal() -> Bool {
        guard inlineTerminalWorkspaceId != nil else { return false }
        inlineTerminalWorkspaceId = nil
        return true
    }
}
