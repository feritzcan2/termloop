import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class WorkspaceMetadataStoreWorktreePathTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        WorkspaceMetadataStore.shared.restore([:])
    }

    func testSetBranchStoresPhysicalWorktreePath() throws {
        let store = WorkspaceMetadataStore.shared
        let id = UUID()
        let path = "/tmp/project/.termloop-worktrees/custom-folder"

        store.setBranch("git/runner-telemetry", worktreePath: path, forWorkspaceId: id)

        XCTAssertEqual(store.metadata(forWorkspaceId: id).branch, "git/runner-telemetry")
        XCTAssertEqual(store.worktreePath(forWorkspaceId: id), path)
        XCTAssertEqual(store.branchBindings().first?.worktreePath, path)

        let encoded = try JSONEncoder().encode(store.snapshot())
        let decoded = try JSONDecoder().decode(
            [String: WorkspaceMetadataStore.Metadata].self,
            from: encoded
        )
        XCTAssertEqual(decoded[id.uuidString]?.worktreePath, path)
    }

    func testLegacySetBranchPreservesPathForSameBranchButClearsOnBranchChange() {
        let store = WorkspaceMetadataStore.shared
        let id = UUID()
        let path = "/tmp/project/.termloop-worktrees/custom-folder"

        store.setBranch("feature/a", worktreePath: path, forWorkspaceId: id)
        store.setBranch("feature/a", forWorkspaceId: id)
        XCTAssertEqual(store.worktreePath(forWorkspaceId: id), path)

        store.setBranch("feature/b", forWorkspaceId: id)
        XCTAssertNil(store.worktreePath(forWorkspaceId: id))

        store.setBranch("feature/b", worktreePath: path, forWorkspaceId: id)
        store.setBranch(nil, forWorkspaceId: id)
        XCTAssertNil(store.metadata(forWorkspaceId: id).branch)
        XCTAssertNil(store.worktreePath(forWorkspaceId: id))
    }

    func testDecodeLegacyJSONMissingWorktreePathProducesNil() throws {
        let legacyJSON = """
        {"branch":"feat/x","terminalAgentId":"claude"}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(WorkspaceMetadataStore.Metadata.self, from: legacyJSON)
        XCTAssertNil(decoded.worktreePath)
    }

    func testWorktreeRootPathRequiresBranchBinding() {
        let store = WorkspaceMetadataStore.shared
        let id = UUID()
        let path = "/tmp/project"

        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: UUID(),
                worktreePath: path
            ),
            forWorkspaceId: id
        )

        XCTAssertNil(store.worktreeRootPath(forWorkspaceId: id))

        store.setBranch("feature/x", worktreePath: path, forWorkspaceId: id)

        XCTAssertEqual(store.worktreeRootPath(forWorkspaceId: id), path)
    }
}
