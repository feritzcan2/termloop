import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class WorkspaceMetadataStoreTaskIdTests: XCTestCase {
    func test_setTaskId_persistsAndReads() {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()
        let taskId = UUID()

        store.setTaskId(taskId, for: workspaceId)
        XCTAssertEqual(store.taskId(for: workspaceId), taskId)

        store.setTaskId(nil, for: workspaceId)
        XCTAssertNil(store.taskId(for: workspaceId))
    }

    func test_decodeLegacyJSON_missingTaskId_producesNil() throws {
        let legacyJSON = """
        {"branch":"feat/x","terminalAgentId":"claude"}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(WorkspaceMetadataStore.Metadata.self, from: legacyJSON)
        XCTAssertNil(decoded.taskId)
    }
}
