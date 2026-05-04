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
                    gitWorktreeEntry(
                        path: WorktreeResolver.path(
                            projectFolder: "/tmp/project",
                            branch: "feature/ticket"
                        )!,
                        branch: "feature/ticket"
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

    func testWorktreeReconcilePreservesMissingBranchAndProductState() {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()
        let projectId = UUID()
        let missingPath = WorktreeResolver.path(
            projectFolder: "/tmp/project",
            branch: "feature/missing"
        )

        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: projectId,
                branch: "feature/missing",
                worktreePath: missingPath,
                worktreeBaselineHead: "abc123",
                assignedTicket: WorkspaceMetadataStore.AssignedTicket(
                    providerName: "jira",
                    key: "KAN-1",
                    title: "Ticket"
                )
            ),
            forWorkspaceId: workspaceId
        )

        TermLoopHooks.reconcileWorktreeMetadata(worktreesByProject: [projectId: []])

        let restored = store.metadata(forWorkspaceId: workspaceId)
        XCTAssertEqual(restored.branch, "feature/missing")
        XCTAssertEqual(restored.worktreePath, missingPath)
        XCTAssertEqual(restored.worktreeBaselineHead, "abc123")
        XCTAssertEqual(restored.assignedTicket?.key, "KAN-1")
    }

    func testWorktreeReconcilePathRepairPreservesBaselineAndTicket() {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()
        let projectId = UUID()
        let repairedPath = WorktreeResolver.path(
            projectFolder: "/tmp/project",
            branch: "feature/ticket"
        )!

        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: projectId,
                branch: "feature/ticket",
                worktreePath: "/tmp/project/old",
                worktreeBaselineHead: "def456",
                assignedTicket: WorkspaceMetadataStore.AssignedTicket(
                    providerName: "jira",
                    key: "KAN-2",
                    title: "Ticket"
                )
            ),
            forWorkspaceId: workspaceId
        )

        TermLoopHooks.reconcileWorktreeMetadata(
            worktreesByProject: [
                projectId: [
                    gitWorktreeEntry(path: repairedPath, branch: "feature/ticket")
                ]
            ]
        )

        let restored = store.metadata(forWorkspaceId: workspaceId)
        XCTAssertEqual(restored.branch, "feature/ticket")
        XCTAssertEqual(restored.worktreePath, repairedPath)
        XCTAssertEqual(restored.worktreeBaselineHead, "def456")
        XCTAssertEqual(restored.assignedTicket?.key, "KAN-2")
    }

    func testWorktreeReconcileSkipsStaleSnapshotRepairAfterFreshAttach() {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()
        let projectId = UUID()
        let stalePath = "/tmp/project/.termloop-worktrees/stale"
        let freshPath = "/tmp/project/.termloop-worktrees/fresh"

        store.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: projectId,
                branch: "feature/ticket",
                worktreePath: "/tmp/project/old"
            ),
            forWorkspaceId: workspaceId
        )
        let staleBindings = store.branchBindings()

        store.setBranch("feature/ticket", worktreePath: freshPath, forWorkspaceId: workspaceId)

        TermLoopHooks.reconcileWorktreeMetadata(
            worktreesByProject: [
                projectId: [
                    gitWorktreeEntry(path: stalePath, branch: "feature/ticket")
                ]
            ],
            bindings: staleBindings
        )

        let restored = store.metadata(forWorkspaceId: workspaceId)
        XCTAssertEqual(restored.branch, "feature/ticket")
        XCTAssertEqual(restored.worktreePath, freshPath)
    }

    private func gitWorktreeEntry(
        path: String,
        branch: String?,
        head: String = "feedfacecafebeef",
        isMain: Bool = false,
        isLocked: Bool = false,
        isPrunable: Bool = false
    ) -> GitWorktreeService.ListEntry {
        GitWorktreeService.ListEntry(
            path: path,
            branch: branch,
            head: head,
            isMain: isMain,
            isLocked: isLocked,
            isPrunable: isPrunable
        )
    }
}
