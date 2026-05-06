// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import XCTest
@testable import termloop

@MainActor
final class TaskSelectionStoreTests: XCTestCase {
    func testInitiallyNoSelection() {
        let store = TaskSelectionStore()
        XCTAssertNil(store.selectedTaskId)
    }

    func testSelectThenClear() {
        let store = TaskSelectionStore()
        let id = UUID()
        store.select(id)
        XCTAssertEqual(store.selectedTaskId, id)
        store.select(nil)
        XCTAssertNil(store.selectedTaskId)
    }

    func testTwoStoresAreIndependent() {
        let a = TaskSelectionStore()
        let b = TaskSelectionStore()
        let id = UUID()
        a.select(id)
        XCTAssertEqual(a.selectedTaskId, id)
        XCTAssertNil(b.selectedTaskId, "per-window selection must not leak across stores")
    }

    func testRedundantSelectIsNoop() {
        let store = TaskSelectionStore()
        let id = UUID()
        store.select(id)
        var changeCount = 0
        let cancellable = store.$selectedTaskId.sink { _ in changeCount += 1 }
        defer { cancellable.cancel() }
        // Initial sink fires once; a redundant select must not bump the count.
        let baseline = changeCount
        store.select(id)
        XCTAssertEqual(changeCount, baseline, "selecting the same id must be a no-op")
    }

    func testOpenInlineTerminalIsIdempotentForSameWorkspace() {
        let store = TaskSelectionStore()
        let workspaceId = UUID()

        store.openInlineTerminal(workspaceId: workspaceId)
        XCTAssertEqual(store.inlineTerminalWorkspaceId, workspaceId)

        store.openInlineTerminal(workspaceId: workspaceId)
        XCTAssertEqual(store.inlineTerminalWorkspaceId, workspaceId)
    }


    func testCloseInlineTerminalClearsWorkspace() {
        let store = TaskSelectionStore()
        let workspaceId = UUID()

        XCTAssertTrue(store.openInlineTerminal(workspaceId: workspaceId))
        XCTAssertEqual(store.inlineTerminalWorkspaceId, workspaceId)
        XCTAssertTrue(store.closeInlineTerminal())
        XCTAssertNil(store.inlineTerminalWorkspaceId)
        XCTAssertFalse(store.closeInlineTerminal())
    }

    func testSelectingDifferentTaskKeepsInlineTerminalOpen() {
        let store = TaskSelectionStore()
        let workspaceId = UUID()
        store.openInlineTerminal(workspaceId: workspaceId)

        store.select(UUID())

        XCTAssertEqual(store.inlineTerminalWorkspaceId, workspaceId)
    }

    func testProviderSharesSelectionOnlyWithinWindow() {
        TaskSelectionStoreProvider.shared.removeAll()
        defer { TaskSelectionStoreProvider.shared.removeAll() }
        let windowId = UUID()
        let otherWindowId = UUID()
        let first = TaskSelectionStoreProvider.shared.store(for: windowId)
        let second = TaskSelectionStoreProvider.shared.store(for: windowId)
        let other = TaskSelectionStoreProvider.shared.store(for: otherWindowId)
        let selected = UUID()

        first.select(selected)

        XCTAssertTrue(first === second)
        XCTAssertEqual(second.selectedTaskId, selected)
        XCTAssertNil(other.selectedTaskId, "selection must stay scoped to one window")
    }

    func testProviderRemoveDropsWindowSelection() {
        TaskSelectionStoreProvider.shared.removeAll()
        defer { TaskSelectionStoreProvider.shared.removeAll() }
        let windowId = UUID()
        let first = TaskSelectionStoreProvider.shared.store(for: windowId)
        first.select(UUID())

        TaskSelectionStoreProvider.shared.remove(windowId: windowId)
        let second = TaskSelectionStoreProvider.shared.store(for: windowId)

        XCTAssertFalse(first === second)
        XCTAssertNil(second.selectedTaskId)
    }
}
