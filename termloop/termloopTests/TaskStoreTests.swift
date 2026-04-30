import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TaskStoreTests: XCTestCase {
    private var tempRoot: URL!

    override func setUp() async throws {
        tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("TaskStoreTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    func test_createThenLoad_returnsTask() throws {
        let store = TaskStore(projectRootProvider: { [tempRoot] _ in tempRoot! })
        let projectId = UUID()
        let task = TermLoopTask(
            id: UUID(),
            projectId: projectId,
            title: "x",
            branch: "feat/x",
            worktreePath: "/tmp/x",
            status: .idle,
            createdAt: Date(),
            updatedAt: Date(),
            externalLink: nil,
            helperAgentId: nil,
            prInfo: nil,
            mergeState: .empty,
            lastSyncedAt: nil,
            lastSyncError: nil
        )

        try store.create(task)
        XCTAssertEqual(store.tasks(for: projectId).map(\.id), [task.id])

        // New store reads from disk
        let reloaded = TaskStore(projectRootProvider: { [tempRoot] _ in tempRoot! })
        reloaded.load(projectId: projectId)
        XCTAssertEqual(reloaded.tasks(for: projectId).map(\.id), [task.id])
    }

    func test_createDuplicateBranch_throws() throws {
        let store = TaskStore(projectRootProvider: { [tempRoot] _ in tempRoot! })
        let projectId = UUID()
        let base = TermLoopTask(
            id: UUID(), projectId: projectId, title: "a", branch: "feat/x",
            worktreePath: "/tmp/a", status: .idle, createdAt: Date(), updatedAt: Date(),
            externalLink: nil, helperAgentId: nil, prInfo: nil,
            mergeState: .empty, lastSyncedAt: nil, lastSyncError: nil
        )
        try store.create(base)

        let dup = TermLoopTask(
            id: UUID(), projectId: projectId, title: "b", branch: "feat/x",
            worktreePath: "/tmp/b", status: .idle, createdAt: Date(), updatedAt: Date(),
            externalLink: nil, helperAgentId: nil, prInfo: nil,
            mergeState: .empty, lastSyncedAt: nil, lastSyncError: nil
        )

        XCTAssertThrowsError(try store.create(dup)) { error in
            guard case TaskStore.StoreError.duplicateBranch = error else {
                return XCTFail("wrong error: \(error)")
            }
        }
    }

    func test_delete_removesTaskAndPersists() throws {
        let store = TaskStore(projectRootProvider: { [tempRoot] _ in tempRoot! })
        let projectId = UUID()
        let task = TermLoopTask(
            id: UUID(), projectId: projectId, title: "a", branch: "feat/x",
            worktreePath: "/tmp/a", status: .idle, createdAt: Date(), updatedAt: Date(),
            externalLink: nil, helperAgentId: nil, prInfo: nil,
            mergeState: .empty, lastSyncedAt: nil, lastSyncError: nil
        )
        try store.create(task)
        try store.delete(taskId: task.id, projectId: projectId)
        XCTAssertTrue(store.tasks(for: projectId).isEmpty)

        let reloaded = TaskStore(projectRootProvider: { [tempRoot] _ in tempRoot! })
        reloaded.load(projectId: projectId)
        XCTAssertTrue(reloaded.tasks(for: projectId).isEmpty)
    }
}
