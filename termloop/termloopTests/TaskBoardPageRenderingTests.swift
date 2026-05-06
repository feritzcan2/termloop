// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

/// Sanity tests for the Tasks page route plumbing. Detail rendering is mostly
/// pure SwiftUI and verified manually; the contracts that DO matter are the
/// route resolution (Task 11 — covered by `MainAreaPresentationPolicy_TaskBoardTests`)
/// and the store-snapshot invariants below.
@MainActor
final class TaskBoardPageRenderingTests: XCTestCase {
    private var tempRoot: URL!

    override func setUp() async throws {
        tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("tasks-rendering-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    func testColumnSnapshotsExposeAllFiveColumnsAlways() throws {
        let store = TaskBoardStore(projectRoot: tempRoot, projectId: UUID())
        try store.loadOrCreate()
        // Empty store still emits 5 columns so the board renders skeletons.
        XCTAssertEqual(store.columnSnapshots.count, 5)
        XCTAssertEqual(store.columnSnapshots.map(\.id), TaskColumnId.allCases)
    }

    func testEmptyStoreHasNoDerivedDetail() throws {
        let store = TaskBoardStore(projectRoot: tempRoot, projectId: UUID())
        try store.loadOrCreate()
        XCTAssertNil(TaskAgentProjectionBuilder.detailSnapshot(in: store, selectedTaskId: UUID()))
    }

    func testMissingSelectionDoesNotSynthesizeDetail() throws {
        let store = TaskBoardStore(projectRoot: tempRoot, projectId: UUID())
        try store.loadOrCreate()
        XCTAssertNil(
            TaskAgentProjectionBuilder.detailSnapshot(in: store, selectedTaskId: UUID()),
            "selecting a non-existent task must not synthesize a snapshot"
        )
    }

    func testDerivedDetailIsPerSelection() throws {
        let projectId = UUID()
        let store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store.loadOrCreate()
        let task = TaskRecord(
            projectId: projectId,
            title: "selected",
            columnId: .todo,
            rank: TaskRanking.initial()
        )
        try store.appendForTesting(task)

        let detail = TaskAgentProjectionBuilder.detailSnapshot(in: store, selectedTaskId: task.id)
        XCTAssertEqual(detail?.id, task.id)
        XCTAssertEqual(detail?.title, "selected")
    }

    func testArchivedTasksDoNotAppearInColumnSnapshots() throws {
        let projectId = UUID()
        let store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store.loadOrCreate()
        var task = TaskRecord(
            projectId: projectId,
            title: "x",
            columnId: .backlog,
            rank: TaskRanking.initial()
        )
        try store.appendForTesting(task)
        XCTAssertEqual(store.columnSnapshots.first { $0.id == .backlog }?.cards.count, 1)

        // Archive in-place; rebuild snapshots by re-appending the modified copy
        // through the public mutate path is not exposed in tests, so simulate
        // by constructing a fresh store from disk after a saveNow.
        task.archivedAt = Date()
        // We can't mutate via the test seam easily; verify via the documented
        // invariant by constructing a store from a file with an archived task.
        let file = TaskBoardFile(tasks: [task])
        let url = tempRoot.appendingPathComponent(".termloop/tasks.json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try JSONEncoder.tasks.encode(file).write(to: url, options: .atomic)

        let restored = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try restored.loadOrCreate()
        XCTAssertTrue(restored.columnSnapshots.allSatisfy { $0.cards.isEmpty },
                      "archived tasks must not appear in any column snapshot")
    }
}
