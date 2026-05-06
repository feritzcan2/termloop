// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TaskBoardStoreProviderTests: XCTestCase {
    func testRemoveDropsProjectStoreAndRoot() throws {
        TaskBoardStoreProvider.shared.removeAll()
        defer { TaskBoardStoreProvider.shared.removeAll() }
        let projectId = UUID()
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("tasks-provider-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        TaskBoardStoreProvider.shared.registerProjectRoot(root, for: projectId)
        let first = try XCTUnwrap(TaskBoardStoreProvider.shared.store(for: projectId))

        TaskBoardStoreProvider.shared.remove(projectId: projectId)
        let second = TaskBoardStoreProvider.shared.store(for: projectId)

        XCTAssertNotNil(first)
        XCTAssertNil(second)
    }
}
