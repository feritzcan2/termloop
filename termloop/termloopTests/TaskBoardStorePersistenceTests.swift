import XCTest
@testable import termloop

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
    }

    func testRoundTripPreservesTasks() throws {
        let projectId = UUID()
        let store = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store.loadOrCreate()
        let task = TaskRecord(
            projectId: projectId,
            title: "first",
            columnId: .backlog,
            rank: TaskRanking.initial()
        )
        try store.appendForTesting(task)
        try store.saveNow()

        let store2 = TaskBoardStore(projectRoot: tempRoot, projectId: projectId)
        try store2.loadOrCreate()
        XCTAssertEqual(store2.fileSnapshot().tasks, [task])
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
        let decoded = try JSONDecoder().decode(TaskBoardFile.self, from: Data(contentsOf: path))
        XCTAssertEqual(decoded.tasks.count, 10)
    }
}
