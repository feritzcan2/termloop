import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class WorktreeReconcilerTests: XCTestCase {
    @MainActor
    func testProjectionKeepsPhysicalWorktreeWhenFreshnessWindowExpires() {
        let projectFolder = "/tmp/termloop-projection-\(UUID().uuidString)"
        let worktreePath = "\(projectFolder)/.termloop-worktrees/feature__agentless"
        let project = Project(
            name: "Projection Expiry",
            folderPath: projectFolder
        )
        WorktreeRegistry.shared.record(
            projectFolder: projectFolder,
            entries: [entry(path: worktreePath, branch: "feature/agentless")],
            capturedAt: Date(timeIntervalSinceNow: -120)
        )
        defer {
            WorktreeRegistry.shared.invalidate(projectFolder: projectFolder)
        }

        let snapshot = WorktreeProjectionStore.shared.snapshot(
            project: project,
            maximumAge: 60
        )

        let projected = snapshot.entry(forWorktreePath: worktreePath)
        XCTAssertEqual(projected?.branch, "feature/agentless")
        XCTAssertEqual(projected?.isPhysical, true)
        XCTAssertEqual(projected?.workspaceIds, [])
    }

    @MainActor
    func testProjectionKeepsLastSuccessfulPhysicalWorktreeDuringInvalidation() {
        let projectFolder = "/tmp/termloop-projection-\(UUID().uuidString)"
        let worktreePath = "\(projectFolder)/.termloop-worktrees/feature__agentless"
        let project = Project(
            name: "Projection Invalidation",
            folderPath: projectFolder
        )
        WorktreeRegistry.shared.record(
            projectFolder: projectFolder,
            entries: [entry(path: worktreePath, branch: "feature/agentless")]
        )
        WorktreeRegistry.shared.markStale(projectFolder: projectFolder)
        defer {
            WorktreeRegistry.shared.invalidate(projectFolder: projectFolder)
        }

        XCTAssertNil(
            WorktreeRegistry.shared.cachedSnapshot(
                projectFolder: projectFolder,
                maximumAge: 60
            )
        )

        let snapshot = WorktreeProjectionStore.shared.snapshot(
            project: project,
            maximumAge: 60
        )

        let projected = snapshot.entry(forWorktreePath: worktreePath)
        XCTAssertEqual(projected?.branch, "feature/agentless")
        XCTAssertEqual(projected?.isPhysical, true)
        XCTAssertEqual(projected?.workspaceIds, [])
    }

    func testHealthyWhenStoredPathMatchesRegisteredExpectedBranch() {
        let path = "/tmp/repo/.termloop-worktrees/feature__x"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: path),
            entries: [entry(path: path, branch: "feature/x")],
            fileExists: { _ in true }
        )

        XCTAssertEqual(status.kind, .healthy)
        XCTAssertEqual(status.path, path)
        XCTAssertEqual(status.pathSource, .metadata)
        XCTAssertEqual(status.observedRef, .branch("feature/x"))
        XCTAssertTrue(status.permitsAgentLaunch)
    }

    func testBranchDriftWhenStoredPathStillRegisteredButObservedBranchDiffers() {
        let path = "/tmp/repo/.termloop-worktrees/feature__x"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: path),
            entries: [entry(path: path, branch: "feature/y")],
            fileExists: { _ in true }
        )

        XCTAssertEqual(status.kind, .branchDrift)
        XCTAssertEqual(status.expectedBranch, "feature/x")
        XCTAssertEqual(status.observedRef, .branch("feature/y"))
        XCTAssertFalse(status.permitsAgentLaunch)
    }

    func testDetachedHeadIsDriftWhenExpectedBranchExists() {
        let path = "/tmp/repo/.termloop-worktrees/feature__x"
        let head = "1234567890abcdef"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: path),
            entries: [entry(path: path, branch: nil, head: head)],
            fileExists: { _ in true }
        )

        XCTAssertEqual(status.kind, .branchDrift)
        XCTAssertEqual(status.observedRef, .detached(head))
    }

    func testPathOnlyDetachedRegistrationCanStillBeHealthy() {
        let path = "/tmp/repo/.termloop-worktrees/manual"
        let head = "abcdef1234567890"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: nil, worktreePath: path),
            entries: [entry(path: path, branch: nil, head: head)],
            fileExists: { _ in true }
        )

        XCTAssertEqual(status.kind, .healthy)
        XCTAssertEqual(status.observedRef, .detached(head))
    }

    func testExistingDiskPathWithoutGitRegistrationIsMissingRegistration() {
        let path = "/tmp/repo/.termloop-worktrees/feature__x"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: path),
            entries: [],
            fileExists: { candidate in candidate == path }
        )

        XCTAssertEqual(status.kind, .missingRegistration)
        XCTAssertEqual(status.path, path)
        XCTAssertFalse(status.permitsAgentLaunch)
    }

    func testMissingDiskPathWithoutGitRegistrationIsMissingPath() {
        let path = "/tmp/repo/.termloop-worktrees/feature__x"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: path),
            entries: [],
            fileExists: { _ in false }
        )

        XCTAssertEqual(status.kind, .missingPath)
        XCTAssertEqual(status.path, path)
    }

    func testBranchOnlyMetadataBackfillsPathFromGitList() {
        let path = "/tmp/repo/.termloop-worktrees/feature__x"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: nil),
            entries: [entry(path: path, branch: "feature/x")],
            fileExists: { _ in false }
        )

        XCTAssertEqual(status.kind, .healthy)
        XCTAssertEqual(status.path, path)
        XCTAssertEqual(status.pathSource, .gitBranchBackfill)
        XCTAssertTrue(status.isBackfillCandidate)
    }

    func testMissingStoredPathBackfillsFromExpectedBranchRegistration() {
        let stalePath = "/tmp/repo/.termloop-worktrees/stale"
        let actualPath = "/tmp/repo/.termloop-worktrees/feature__x"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: stalePath),
            entries: [entry(path: actualPath, branch: "feature/x")],
            fileExists: { _ in false }
        )

        XCTAssertEqual(status.kind, .healthy)
        XCTAssertEqual(status.path, actualPath)
        XCTAssertEqual(status.pathSource, .gitBranchBackfill)
    }

    func testLockedWorktreeKeepsLaunchAllowedButNeedsAttention() {
        let path = "/tmp/repo/.termloop-worktrees/feature__x"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: path),
            entries: [entry(path: path, branch: "feature/x", isLocked: true)],
            fileExists: { _ in true }
        )

        XCTAssertEqual(status.kind, .locked)
        XCTAssertTrue(status.isLocked)
        XCTAssertTrue(status.needsUserAttention)
        XCTAssertTrue(status.permitsAgentLaunch)
    }

    func testPrunableWorktreeBlocksLaunch() {
        let path = "/tmp/repo/.termloop-worktrees/feature__x"
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: path),
            entries: [entry(path: path, branch: "feature/x", isPrunable: true)],
            fileExists: { _ in false }
        )

        XCTAssertEqual(status.kind, .prunable)
        XCTAssertTrue(status.isPrunable)
        XCTAssertFalse(status.permitsAgentLaunch)
    }

    func testGitListFailureProducesUnknownWithoutClearingProductState() {
        struct Failure: Error, CustomStringConvertible {
            let description = "git failed"
        }

        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: "feature/x", worktreePath: "/tmp/repo/wt"),
            failure: Failure()
        )

        XCTAssertEqual(status.kind, .unknown)
        XCTAssertEqual(status.expectedBranch, "feature/x")
        XCTAssertEqual(status.path, "/tmp/repo/wt")
        XCTAssertEqual(status.message, "git failed")
        XCTAssertFalse(status.permitsAgentLaunch)
    }

    func testUnattachedWorkspaceAllowsRepoRootFallback() {
        let status = WorktreeReconciler.status(
            for: .init(expectedBranch: nil, worktreePath: nil),
            entries: [],
            fileExists: { _ in false }
        )

        XCTAssertEqual(status.kind, .unattached)
        XCTAssertTrue(status.permitsAgentLaunch)
    }

    private func entry(
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
