import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TermLoopHooksRestorePruneTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        WorkspaceMetadataStore.shared.restore([:])
    }

    func testPrunePredicateMatchesTaggedWorkspaceIds() {
        let store = WorkspaceMetadataStore.shared
        let taggedId = UUID()
        let normalId = UUID()
        store.setAgentSession(kind: .abilityCreator, spawnedAt: Date(), forWorkspaceId: taggedId)

        XCTAssertTrue(TermLoopHooks.shouldPruneOnRestore(workspaceId: taggedId))
        XCTAssertFalse(TermLoopHooks.shouldPruneOnRestore(workspaceId: normalId))
    }

    func testWorktreeReconcileRepairsStalePathForExistingBranch() {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()
        let projectId = UUID()

        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: projectId,
                branch: "feature/ticket",
                worktreePath: "/tmp/project"
            ),
            forWorkspaceId: workspaceId
        )

        TermLoopHooks.reconcileWorktreeMetadata(
            worktreesByProject: [
                projectId: [
                    TermLoopHooks.WorktreeReconcileEntry(
                        branch: "feature/ticket",
                        path: WorktreeResolver.path(
                            projectFolder: "/tmp/project",
                            branch: "feature/ticket"
                        )!
                    )
                ]
            ]
        )

        let restored = store.metadata(forWorkspaceId: workspaceId)
        XCTAssertEqual(restored.branch, "feature/ticket")
        XCTAssertEqual(
            restored.worktreePath,
            WorktreeResolver.path(projectFolder: "/tmp/project", branch: "feature/ticket")
        )
    }

    func testWorktreeReconcileClearsMissingBranchWithoutExistingPath() {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()
        let projectId = UUID()

        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: projectId,
                branch: "feature/missing",
                worktreePath: WorktreeResolver.path(
                    projectFolder: "/tmp/project",
                    branch: "feature/missing"
                )
            ),
            forWorkspaceId: workspaceId
        )

        TermLoopHooks.reconcileWorktreeMetadata(worktreesByProject: [projectId: []])

        let restored = store.metadata(forWorkspaceId: workspaceId)
        XCTAssertNil(restored.branch)
        XCTAssertNil(restored.worktreePath)
    }
}
