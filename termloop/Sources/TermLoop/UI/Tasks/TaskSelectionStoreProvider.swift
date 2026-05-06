// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Shares task selection between the main Tasks route and the sidebar drill-in
/// for the same window. The store itself remains per-window: each windowId gets
/// its own `TaskSelectionStore`, and there is no process-wide selected task.
@MainActor
public final class TaskSelectionStoreProvider {
    public static let shared = TaskSelectionStoreProvider()

    private var stores: [UUID: TaskSelectionStore] = [:]

    private init() {}

    public func store(for windowId: UUID) -> TaskSelectionStore {
        if let existing = stores[windowId] { return existing }
        let store = TaskSelectionStore()
        stores[windowId] = store
        return store
    }

    public func remove(windowId: UUID) {
        stores.removeValue(forKey: windowId)
    }

    @discardableResult
    public func closeInlineTerminals(workspaceId: UUID) -> Bool {
        var didClose = false
        for store in stores.values where store.inlineTerminalWorkspaceId == workspaceId {
            didClose = store.closeInlineTerminal() || didClose
        }
        return didClose
    }

    public func removeAll() {
        stores.removeAll()
    }
}
