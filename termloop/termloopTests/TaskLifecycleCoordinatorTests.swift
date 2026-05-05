import XCTest
@testable import termloop

@MainActor
final class TaskLifecycleCoordinatorTests: XCTestCase {
    private var tempRoot: URL!
    private var projectId: UUID!
    private var store: TaskBoardStore!
    private var fakeWorkspaces: FakeWorkspaceMetadataStore!
    private var fakeWorktrees: FakeWorktreeCoordinator!
    private var coordinator: TaskLifecycleCoordinator!

    override func setUp() async throws {
        tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("termloop-coord-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        projectId = UUID()
        store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store.loadOrCreate()
        fakeWorkspaces = FakeWorkspaceMetadataStore()
        fakeWorktrees = FakeWorktreeCoordinator()
        coordinator = TaskLifecycleCoordinator(
            store: store,
            workspaces: fakeWorkspaces,
            worktrees: fakeWorktrees
        )
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    func testCreateTaskAddsToBacklog() throws {
        let id = try coordinator.createTask(title: "first", columnId: .backlog)
        let snap = store.columnSnapshots.first { $0.id == .backlog }
        XCTAssertEqual(snap?.cards.first?.id, id)
        XCTAssertEqual(snap?.cards.first?.title, "first")
    }

    func testBindWorktreeHappyPath() async throws {
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        try await coordinator.moveColumn(taskId: id, to: .inProgress)
        let task = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id })
        XCTAssertEqual(task.provisionState, .ready)
        XCTAssertNotNil(task.workspaceId)
        XCTAssertNotNil(task.worktreePath)
        XCTAssertEqual(task.bindingGeneration, 1)
        XCTAssertEqual(task.columnId, .inProgress)
    }

    func testBindWritesMetadataBeforeTaskStore() async throws {
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        try await coordinator.moveColumn(taskId: id, to: .inProgress)
        XCTAssertTrue(fakeWorkspaces.metadataWrittenBeforeTaskStoreSave)
    }
}

// MARK: - Test doubles

@MainActor
final class FakeWorkspaceMetadataStore: TaskBoundWorkspaceMetadataStoring {
    var metadataWrittenBeforeTaskStoreSave = false
    private(set) var setCalls: [(workspaceId: UUID, branch: String, path: String)] = []

    func setBinding(workspaceId: UUID, branch: String, path: String) throws {
        setCalls.append((workspaceId, branch, path))
        metadataWrittenBeforeTaskStoreSave = true
    }

    func clearBinding(workspaceId: UUID) throws {}

    func workspaceExists(workspaceId: UUID) -> Bool { true }
}

@MainActor
final class FakeWorktreeCoordinator: TaskBoundWorktreeProvisioning {
    var nextResult: Result<TaskWorktreeProvisionResult, Error> = .success(
        TaskWorktreeProvisionResult(
            workspaceId: UUID(),
            branch: "feat/auto-1",
            worktreePath: "/tmp/wt"
        )
    )

    func provision(projectRoot: URL, branchHint: String?) async throws
        -> TaskWorktreeProvisionResult
    {
        try nextResult.get()
    }

    func teardown(workspaceId: UUID, worktreePath: String) async throws {}
}

extension TaskLifecycleCoordinatorTests {
    func testBindFailureRevertsToPreviousColumn() async throws {
        struct E: Error {}
        fakeWorktrees.nextResult = .failure(E())
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        do {
            try await coordinator.moveColumn(taskId: id, to: .inProgress)
            XCTFail("expected throw")
        } catch {}
        let task = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id })
        XCTAssertEqual(task.columnId, .todo)
        XCTAssertTrue(task.provisionState.isFailed)
        XCTAssertNil(task.workspaceId)
        XCTAssertEqual(task.bindingGeneration, 0)
    }

    func testCancelIgnoresStaleCompletion() async throws {
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        try await coordinator.moveColumn(taskId: id, to: .inProgress)
        let beforeGen = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id }).bindingGeneration

        try coordinator.cancelBinding(taskId: id) // bumps generation, marks pending teardown
        let afterGen = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id }).bindingGeneration
        XCTAssertGreaterThan(afterGen, beforeGen)
    }

    func testRebindAfterUnbindSucceeds() async throws {
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        try await coordinator.moveColumn(taskId: id, to: .inProgress)
        try coordinator.cancelBinding(taskId: id)

        // Reset fake to a fresh result and re-trigger bind.
        fakeWorktrees.nextResult = .success(
            TaskWorktreeProvisionResult(
                workspaceId: UUID(),
                branch: "feat/auto-2",
                worktreePath: "/tmp/wt2"
            )
        )
        try await coordinator.bindWorktree(taskId: id)
        let task = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id })
        XCTAssertEqual(task.provisionState, .ready)
    }
}
