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
}
