import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

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

    func testRestoreTaskReturnsArchivedTaskToActiveColumn() throws {
        let id = try coordinator.createTask(title: "first", columnId: .backlog)
        try coordinator.archiveTask(id)
        XCTAssertEqual(store.archivedSnapshots.first?.id, id)
        XCTAssertFalse(store.columnSnapshots.contains { column in
            column.cards.contains { $0.id == id }
        })

        try coordinator.restoreTask(id)

        XCTAssertTrue(store.archivedSnapshots.isEmpty)
        let snap = store.columnSnapshots.first { $0.id == .backlog }
        XCTAssertEqual(snap?.cards.first?.id, id)
        XCTAssertNil(store.fileSnapshot().tasks.first { $0.id == id }?.archivedAt)
    }

    func testMoveManualTaskToInProgressDoesNotProvision() async throws {
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        try await coordinator.moveColumn(taskId: id, to: .inProgress)
        let task = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id })
        XCTAssertEqual(task.columnId, .inProgress)
        XCTAssertEqual(task.provisionState, .none)
        XCTAssertNil(task.workspaceId)
        XCTAssertNil(task.worktreePath)
        XCTAssertTrue(fakeWorktrees.provisionCalls.isEmpty)
    }

    func testExplicitBindWorktreeHappyPath() async throws {
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        try await coordinator.bindWorktree(taskId: id)
        let task = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id })
        XCTAssertEqual(task.provisionState, .ready)
        XCTAssertNotNil(task.workspaceId)
        XCTAssertNotNil(task.worktreePath)
        XCTAssertEqual(task.bindingGeneration, 1)
    }

    func testExplicitBindWritesMetadataBeforeTaskStore() async throws {
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        try await coordinator.bindWorktree(taskId: id)
        XCTAssertTrue(fakeWorkspaces.metadataWrittenBeforeTaskStoreSave)
    }

    func testMovePathOnlyReadyTaskDoesNotReProvision() async throws {
        struct ShouldNotProvision: Error {}
        fakeWorktrees.nextResult = .failure(ShouldNotProvision())
        let id = UUID()
        try store.appendForTesting(TaskRecord(
            id: id,
            projectId: projectId,
            title: "path-only",
            columnId: .todo,
            rank: TaskRanking.initial(),
            workspaceId: nil,
            worktreePath: "/tmp/existing-worktree",
            branch: "feat/existing",
            bindingGeneration: 1,
            provisionState: .ready
        ))
        try store.saveNow()

        try await coordinator.moveColumn(taskId: id, to: .inProgress)

        let task = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id })
        XCTAssertEqual(task.columnId, .inProgress)
        XCTAssertEqual(task.provisionState, .ready)
        XCTAssertNil(task.workspaceId)
        XCTAssertEqual(task.worktreePath, "/tmp/existing-worktree")
        XCTAssertTrue(fakeWorkspaces.setCalls.isEmpty)
    }

    func testPendingTaskCannotMoveColumnsWhileProvisioning() async throws {
        let id = UUID()
        try store.appendForTesting(TaskRecord(
            id: id,
            projectId: projectId,
            title: "pending",
            columnId: .inProgress,
            rank: TaskRanking.initial(),
            provisionState: .pending
        ))
        try store.saveNow()

        do {
            try await coordinator.moveColumn(taskId: id, to: .done)
            XCTFail("expected provisionInFlight")
        } catch {
            XCTAssertEqual(error as? TaskLifecycleError, .provisionInFlight(id))
        }

        let task = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id })
        XCTAssertEqual(task.columnId, .inProgress)
        XCTAssertEqual(task.provisionState, .pending)
        XCTAssertEqual(fakeWorktrees.provisionCalls.count, 0)
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
            worktreePath: "/tmp/wt",
            createdWorktree: true
        )
    )
    var suspendProvision = false
    var suspendedContinuation: CheckedContinuation<TaskWorktreeProvisionResult, Error>?
    private(set) var provisionCalls: [(projectRoot: URL, branchHint: String?, allowDirty: Bool)] = []
    private(set) var teardownCalls: [(workspaceId: UUID?, worktreePath: String, projectRoot: URL)] = []

    func provision(projectRoot: URL, branchHint: String?, allowDirty: Bool) async throws
        -> TaskWorktreeProvisionResult
    {
        provisionCalls.append((projectRoot: projectRoot, branchHint: branchHint, allowDirty: allowDirty))
        if suspendProvision {
            return try await withCheckedThrowingContinuation { continuation in
                suspendedContinuation = continuation
            }
        }
        return try nextResult.get()
    }

    func resumeProvision(_ result: Result<TaskWorktreeProvisionResult, Error>) {
        let continuation = suspendedContinuation
        suspendedContinuation = nil
        suspendProvision = false
        switch result {
        case .success(let provisionResult):
            continuation?.resume(returning: provisionResult)
        case .failure(let error):
            continuation?.resume(throwing: error)
        }
    }

    func teardown(workspaceId: UUID?, worktreePath: String, projectRoot: URL) async throws {
        teardownCalls.append((workspaceId, worktreePath, projectRoot))
    }
}

extension TaskLifecycleCoordinatorTests {
    func testBindFailureRevertsToPreviousColumn() async throws {
        struct E: Error {}
        fakeWorktrees.nextResult = .failure(E())
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        do {
            try await coordinator.bindWorktree(taskId: id)
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
        try await coordinator.bindWorktree(taskId: id)
        let beforeGen = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id }).bindingGeneration

        try coordinator.cancelBinding(taskId: id) // bumps generation, marks pending teardown
        let afterGen = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id }).bindingGeneration
        XCTAssertGreaterThan(afterGen, beforeGen)
    }

    func testCancelDuringProvisionIgnoresAndTearsDownStaleCompletion() async throws {
        fakeWorktrees.suspendProvision = true
        let staleWorkspaceId = UUID()
        let stalePath = "/tmp/stale-wt"
        let id = try coordinator.createTask(title: "feat", columnId: .todo)

        let moveTask = _Concurrency.Task { @MainActor in
            try await self.coordinator.bindWorktree(taskId: id)
        }
        while fakeWorktrees.suspendedContinuation == nil {
            await _Concurrency.Task.yield()
        }

        try coordinator.cancelBinding(taskId: id)
        fakeWorktrees.resumeProvision(
            .success(TaskWorktreeProvisionResult(
                workspaceId: staleWorkspaceId,
                branch: "feat/stale",
                worktreePath: stalePath,
                createdWorktree: true
            ))
        )
        try await moveTask.value

        let task = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id })
        XCTAssertEqual(task.columnId, .todo)
        XCTAssertEqual(task.provisionState, .none)
        XCTAssertNil(task.workspaceId)
        XCTAssertTrue(fakeWorkspaces.setCalls.isEmpty)
        XCTAssertEqual(fakeWorktrees.teardownCalls.first?.workspaceId, staleWorkspaceId)
        XCTAssertEqual(fakeWorktrees.teardownCalls.first?.worktreePath, stalePath)
    }

    func testRebindAfterUnbindSucceeds() async throws {
        let id = try coordinator.createTask(title: "feat", columnId: .todo)
        try await coordinator.bindWorktree(taskId: id)
        try coordinator.cancelBinding(taskId: id)

        // Reset fake to a fresh result and re-trigger bind.
        fakeWorktrees.nextResult = .success(
            TaskWorktreeProvisionResult(
                workspaceId: UUID(),
                branch: "feat/auto-2",
                worktreePath: "/tmp/wt2",
                createdWorktree: true
            )
        )
        try await coordinator.bindWorktree(taskId: id)
        let task = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == id })
        XCTAssertEqual(task.provisionState, .ready)
    }
}
