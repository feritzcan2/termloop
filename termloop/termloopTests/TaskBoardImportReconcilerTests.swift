import XCTest
@testable import termloop

@MainActor
final class TaskBoardImportReconcilerTests: XCTestCase {
    private var tempRoot: URL!
    private var projectId: UUID!
    private var store: TaskBoardStore!

    override func setUp() async throws {
        tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("termloop-recon-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        projectId = UUID()
        store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store.loadOrCreate()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    func testOrphanWorktreesBecomeInProgressTasks() throws {
        let workspaces = StubWorkspaceLister(items: [
            .init(workspaceId: UUID(), branch: "feat/a", path: "/tmp/a"),
            .init(workspaceId: UUID(), branch: "feat/b", path: "/tmp/b"),
        ])
        let reconciler = TaskBoardImportReconciler(store: store, workspaces: workspaces)
        try reconciler.run()
        let inProg = store.columnSnapshots.first { $0.id == .inProgress }
        XCTAssertEqual(inProg?.cards.count, 2)
        XCTAssertEqual(Set(inProg?.cards.map(\.title) ?? []), ["feat/a", "feat/b"])
    }

    func testReRunIsIdempotent() throws {
        let ws = StubWorkspaceLister(items: [
            .init(workspaceId: UUID(), branch: "feat/a", path: "/tmp/a"),
        ])
        let reconciler = TaskBoardImportReconciler(store: store, workspaces: ws)
        try reconciler.run()
        try reconciler.run()
        let inProg = store.columnSnapshots.first { $0.id == .inProgress }
        XCTAssertEqual(inProg?.cards.count, 1)
    }

    func testKeyIncludesProjectId() throws {
        // Same path string in two projects must yield two tasks (one per project).
        let path = "/tmp/shared"
        let workspaces = StubWorkspaceLister(items: [
            .init(workspaceId: UUID(), branch: "feat/x", path: path),
        ])
        let r1 = TaskBoardImportReconciler(store: store, workspaces: workspaces)
        try r1.run()

        let otherProject = UUID()
        let store2 = TaskBoardStore(
            projectRoot: tempRoot.appendingPathComponent("other"),
            projectId: otherProject
        )
        try FileManager.default.createDirectory(
            at: tempRoot.appendingPathComponent("other"),
            withIntermediateDirectories: true
        )
        try store2.loadOrCreate()
        let r2 = TaskBoardImportReconciler(store: store2, workspaces: workspaces)
        try r2.run()
        XCTAssertEqual(store2.fileSnapshot().tasks.count, 1)
    }

    func testInterruptedPendingRecoversAsFailed() throws {
        // Task left in .pending without a live workspace becomes .failed("interrupted").
        var task = TaskRecord(
            projectId: projectId,
            title: "stuck",
            columnId: .inProgress,
            rank: TaskRanking.initial()
        )
        task.provisionState = .pending
        try store.appendForTesting(task)
        try store.saveNow()

        let reconciler = TaskBoardImportReconciler(
            store: store,
            workspaces: StubWorkspaceLister(items: [])
        )
        try reconciler.run()
        let updated = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == task.id })
        if case .failed(let reason) = updated.provisionState {
            XCTAssertTrue(reason.lowercased().contains("interrupt"))
        } else {
            XCTFail("expected .failed, got \(updated.provisionState)")
        }
    }

    func testExistingWorktreePathRecoversFromMissingEvenWithoutWorkspaceMetadata() throws {
        let worktreePath = "/tmp/existing-worktree"
        var task = TaskRecord(
            projectId: projectId,
            title: "existing",
            columnId: .inProgress,
            rank: TaskRanking.initial(),
            workspaceId: UUID(),
            worktreePath: worktreePath,
            branch: "feat/existing",
            bindingGeneration: 1,
            provisionState: .failed(reason: TaskProvisionFailureReason.worktreeMissing)
        )
        task.updatedAt = Date(timeIntervalSince1970: 1)
        try store.appendForTesting(task)
        try store.saveNow()

        let reconciler = TaskBoardImportReconciler(
            store: store,
            workspaces: StubWorkspaceLister(items: [
                .init(workspaceId: nil, branch: "feat/existing", path: worktreePath),
            ])
        )
        try reconciler.run()

        let updated = try XCTUnwrap(store.fileSnapshot().tasks.first { $0.id == task.id })
        XCTAssertEqual(updated.provisionState, .ready)
        XCTAssertNil(updated.workspaceId)
        XCTAssertEqual(updated.worktreePath, worktreePath)
        XCTAssertEqual(updated.branch, "feat/existing")
    }

    func testExternalPathOnlyAutoImportsArePruned() throws {
        let externalPath = "/private/tmp/termloop-mobile-phone-only"
        let task = TaskRecord(
            projectId: projectId,
            title: "termloop-mobile-phone-only",
            columnId: .inProgress,
            rank: TaskRanking.initial(),
            workspaceId: nil,
            worktreePath: externalPath,
            branch: "termloop-mobile-phone-only",
            bindingGeneration: 1,
            provisionState: .ready
        )
        try store.appendForTesting(task)
        try store.saveNow()

        let reconciler = TaskBoardImportReconciler(
            store: store,
            workspaces: StubWorkspaceLister(items: [])
        )
        try reconciler.run()

        XCTAssertNil(store.fileSnapshot().tasks.first { $0.id == task.id })
    }

    func testManagedPathOnlyAutoImportsAreKept() throws {
        let projectRoot = StubWorkspaceLister.projectRoot(for: projectId)
        let managedPath = projectRoot
            .appendingPathComponent(".termloop-worktrees/tasks")
            .path
        let task = TaskRecord(
            projectId: projectId,
            title: "tasks",
            columnId: .inProgress,
            rank: TaskRanking.initial(),
            workspaceId: nil,
            worktreePath: managedPath,
            branch: "tasks",
            bindingGeneration: 1,
            provisionState: .ready
        )
        try store.appendForTesting(task)
        try store.saveNow()

        let reconciler = TaskBoardImportReconciler(
            store: store,
            workspaces: StubWorkspaceLister(items: [
                .init(workspaceId: nil, branch: "tasks", path: managedPath),
            ])
        )
        try reconciler.run()

        XCTAssertNotNil(store.fileSnapshot().tasks.first { $0.id == task.id })
    }
}

// MARK: - Test stub

@MainActor
final class StubWorkspaceLister: TaskBoardWorkspaceListing {
    struct Item { let workspaceId: UUID?; let branch: String; let path: String }
    let items: [Item]
    init(items: [Item]) { self.items = items }

    func workspaces(in projectId: UUID) -> [TaskWorkspaceDescriptor] {
        items.map { .init(
            workspaceId: $0.workspaceId,
            projectId: projectId,
            branch: $0.branch,
            worktreePath: $0.path
        ) }
    }

    func projectRoot(for projectId: UUID) -> URL {
        Self.projectRoot(for: projectId)
    }

    static func projectRoot(for projectId: UUID) -> URL {
        URL(fileURLWithPath: "/tmp/projects").appendingPathComponent(projectId.uuidString)
    }
}
