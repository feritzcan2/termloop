import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TaskBoardStorePersistenceTests: XCTestCase {
    private var tempRoot: URL!

    override func setUp() async throws {
        tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("termloop-tasks-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    func testEmptyLoadProducesEmptyBoard() throws {
        let store = TaskBoardStore(projectRoot: tempRoot, projectId: UUID())
        try store.loadOrCreate()
        XCTAssertEqual(store.fileSnapshot().tasks, [])
        XCTAssertEqual(store.fileSnapshot().schemaVersion, TaskBoardFile.currentSchemaVersion)
        XCTAssertFalse(store.fileSnapshot().settings.remoteSync.remoteItemsEnabled)
        XCTAssertFalse(store.fileSnapshot().settings.remoteSync.isEnabled)
        XCTAssertFalse(store.fileSnapshot().settings.remoteSync.syncAssignedToMe)
        XCTAssertFalse(store.fileSnapshot().settings.remoteSync.syncColumnMovesToRemote)
        XCTAssertEqual(store.fileSnapshot().settings.remoteSync.limit, 50)
    }

    func testRemoteSyncAssignedFlagControlsBoardSyncBehavior() throws {
        let enabled = TaskRemoteSyncSettings(
            remoteItemsEnabled: true,
            syncAssignedToMe: true,
            syncColumnMovesToRemote: true
        )
        XCTAssertTrue(enabled.remoteItemsEnabled)
        XCTAssertTrue(enabled.syncAssignedToMe)
        XCTAssertTrue(enabled.syncColumnMovesToRemote)
        XCTAssertTrue(enabled.isAssignedSyncEnabled)

        let assignedSync = TaskRemoteSyncSettings(
            remoteItemsEnabled: true,
            syncAssignedToMe: true,
            syncColumnMovesToRemote: true
        )
        let decoded = try JSONDecoder.tasks.decode(
            TaskRemoteSyncSettings.self,
            from: JSONEncoder.tasks.encode(assignedSync)
        )
        let encodedText = String(data: try JSONEncoder.tasks.encode(assignedSync), encoding: .utf8) ?? ""
        XCTAssertFalse(encodedText.contains("\"mode\""))
        XCTAssertTrue(encodedText.contains("\"remoteItemsEnabled\""))
        XCTAssertTrue(decoded.remoteItemsEnabled)
        XCTAssertTrue(decoded.syncAssignedToMe)
        XCTAssertTrue(decoded.syncColumnMovesToRemote)
        XCTAssertTrue(decoded.isAssignedSyncEnabled)
    }

    func testDisabledRemoteWorkItemsStripSyncFlags() throws {
        let payload = """
        {
          "remoteItemsEnabled": false,
          "syncAssignedToMe": true,
          "syncColumnMovesToRemote": true,
          "provider": "jira",
          "limit": 30
        }
        """
        let decoded = try JSONDecoder.tasks.decode(TaskRemoteSyncSettings.self, from: Data(payload.utf8))
        XCTAssertFalse(decoded.remoteItemsEnabled)
        XCTAssertFalse(decoded.isEnabled)
        XCTAssertFalse(decoded.syncAssignedToMe)
        XCTAssertFalse(decoded.syncColumnMovesToRemote)
    }

    func testRoundTripPreservesTasks() throws {
        let projectId = UUID()
        let store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store.loadOrCreate()
        let timestamp = Date(timeIntervalSince1970: 1_778_219_200)
        let task = TaskRecord(
            projectId: projectId,
            title: "first",
            columnId: .backlog,
            rank: TaskRanking.initial(),
            createdAt: timestamp,
            updatedAt: timestamp
        )
        try store.appendForTesting(task)
        try store.saveNow()

        let store2 = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store2.loadOrCreate()
        XCTAssertEqual(store2.fileSnapshot().tasks, [task])
    }

    func testLoadInfersOriginWhenStoredTaskDoesNotHaveOrigin() throws {
        let projectId = UUID()
        let taskId = UUID()
        let dir = tempRoot.appendingPathComponent(".termloop")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("tasks.json")
        let payload = """
        {
          "schemaVersion": 2,
          "settings": {},
          "tasks": [
            {
              "bindingGeneration": 1,
              "branch": "feature/local",
              "columnId": "in_progress",
              "createdAt": "2026-05-06T13:39:59Z",
              "id": "\(taskId.uuidString)",
              "projectId": "\(projectId.uuidString)",
              "provisionState": { "ready": {} },
              "rank": "U",
              "title": "feature/local",
              "updatedAt": "2026-05-07T07:16:23Z",
              "worktreePath": "/tmp/feature-local"
            }
          ],
          "updatedAt": "2026-05-07T07:16:23Z"
        }
        """
        try payload.write(to: path, atomically: true, encoding: .utf8)

        let store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store.loadOrCreate()

        let task = try XCTUnwrap(store.fileSnapshot().tasks.first)
        XCTAssertEqual(task.origin, .worktree)
        XCTAssertEqual(task.worktreePath, "/tmp/feature-local")
    }

    func testFutureSchemaVersionThrowsAndPreservesFile() throws {
        let projectId = UUID()
        let dir = tempRoot.appendingPathComponent(".termloop")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("tasks.json")
        let payload = "{\"schemaVersion\": 99, \"tasks\": [], \"updatedAt\": 0}"
        try payload.write(to: path, atomically: true, encoding: .utf8)

        let store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        XCTAssertThrowsError(try store.loadOrCreate()) { error in
            guard case TaskBoardStoreError.unsupportedSchema = error else {
                return XCTFail("expected unsupportedSchema, got \(error)")
            }
        }
        let onDisk = try String(contentsOf: path)
        XCTAssertEqual(onDisk, payload, "future-schema file must be preserved untouched")
    }

    func testCorruptJSONThrowsAndPreservesFile() throws {
        let projectId = UUID()
        let dir = tempRoot.appendingPathComponent(".termloop")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("tasks.json")
        let payload = "{not json"
        try payload.write(to: path, atomically: true, encoding: .utf8)

        let store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        XCTAssertThrowsError(try store.loadOrCreate())
        let onDisk = try String(contentsOf: path)
        XCTAssertEqual(onDisk, payload)
    }

    func testAtomicWriteDoesNotCorruptOnReplace() throws {
        let projectId = UUID()
        let store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store.loadOrCreate()
        for i in 0..<10 {
            let t = TaskRecord(
                projectId: projectId,
                title: "t\(i)",
                columnId: .todo,
                rank: TaskRanking.initial()
            )
            try store.appendForTesting(t)
            try store.saveNow()
        }
        let path = tempRoot.appendingPathComponent(".termloop/tasks.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: path.path))
        let decoded = try JSONDecoder.tasks.decode(TaskBoardFile.self, from: Data(contentsOf: path))
        XCTAssertEqual(decoded.tasks.count, 10)
    }
}
