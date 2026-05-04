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

    func testBranchOnlySetBranchPreservesPathForSameBranchButClearsOnBranchChange() {
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

    func testSetWorktreePathPreservesProductState() {
        let store = WorkspaceMetadataStore.shared
        let id = UUID()
        let oldPath = "/tmp/project/.termloop-worktrees/old"
        let newPath = "/tmp/project/.termloop-worktrees/new"

        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                branch: "feature/x",
                worktreePath: oldPath,
                worktreeBaselineHead: "abc123",
                assignedTicket: WorkspaceMetadataStore.AssignedTicket(
                    providerName: "jira",
                    key: "KAN-9",
                    title: "Ticket"
                )
            ),
            forWorkspaceId: id
        )

        store.setWorktreePath(newPath, forWorkspaceId: id)

        let metadata = store.metadata(forWorkspaceId: id)
        XCTAssertEqual(metadata.branch, "feature/x")
        XCTAssertEqual(metadata.worktreePath, newPath)
        XCTAssertEqual(metadata.worktreeBaselineHead, "abc123")
        XCTAssertEqual(metadata.assignedTicket?.key, "KAN-9")
    }

    func testSetWorktreePathGenerationGuardRejectsStaleRepair() {
        let store = WorkspaceMetadataStore.shared
        let id = UUID()

        store.setBranch("feature/x", worktreePath: "/tmp/project/old", forWorkspaceId: id)
        let initialGeneration = store.branchBindings().first?.generation

        XCTAssertTrue(store.setWorktreePath(
            "/tmp/project/new",
            forWorkspaceId: id,
            expectedGeneration: initialGeneration
        ))
        XCTAssertFalse(store.setWorktreePath(
            "/tmp/project/stale",
            forWorkspaceId: id,
            expectedGeneration: initialGeneration
        ))
        XCTAssertEqual(store.worktreePath(forWorkspaceId: id), "/tmp/project/new")
    }

    func testAdoptWorktreeBranchPreservesProductState() {
        let store = WorkspaceMetadataStore.shared
        let id = UUID()
        let path = "/tmp/project/.termloop-worktrees/observed"

        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                branch: "feature/expected",
                worktreePath: path,
                worktreeBaselineHead: "abc123",
                assignedTicket: WorkspaceMetadataStore.AssignedTicket(
                    providerName: "jira",
                    key: "KAN-9",
                    title: "Ticket"
                )
            ),
            forWorkspaceId: id
        )

        store.adoptWorktreeBranch(
            "feature/observed",
            worktreePath: path,
            baselineHead: "def456",
            forWorkspaceId: id
        )

        let metadata = store.metadata(forWorkspaceId: id)
        XCTAssertEqual(metadata.branch, "feature/observed")
        XCTAssertEqual(metadata.worktreePath, path)
        XCTAssertEqual(metadata.worktreeBaselineHead, "def456")
        XCTAssertEqual(metadata.assignedTicket?.key, "KAN-9")
    }

    func testWorkspaceIdsWithWorktreePathUsesPhysicalPathAndProjectScope() {
        let store = WorkspaceMetadataStore.shared
        let projectId = UUID()
        let otherProjectId = UUID()
        let first = UUID()
        let second = UUID()
        let otherProject = UUID()
        let path = "/tmp/project/.termloop-worktrees/feature"

        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: projectId,
                branch: "feature/expected",
                worktreePath: path
            ),
            forWorkspaceId: first
        )
        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: projectId,
                branch: "feature/drifted",
                worktreePath: "\(path)/../feature"
            ),
            forWorkspaceId: second
        )
        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: otherProjectId,
                branch: "feature/expected",
                worktreePath: path
            ),
            forWorkspaceId: otherProject
        )

        XCTAssertEqual(
            Set(store.workspaceIds(withWorktreePath: path, projectId: projectId)),
            Set([first, second])
        )
        XCTAssertEqual(
            Set(store.workspaceIds(withWorktreePath: path)),
            Set([first, second, otherProject])
        )
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
