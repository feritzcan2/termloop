import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TaskSyncServiceTests: XCTestCase {
    func test_reconcile_updatesTaskMergeStateAndPR() async throws {
        let projectId = UUID()
        let task = TermLoopTask(
            id: UUID(), projectId: projectId, title: "t", branch: "feat/x",
            worktreePath: "/tmp/wt", status: .active, createdAt: Date(), updatedAt: Date(),
            externalLink: nil, helperAgentId: nil, prInfo: nil,
            mergeState: .empty, lastSyncedAt: nil, lastSyncError: nil
        )
        let tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let store = TaskStore(projectRootProvider: { _ in tempRoot })
        try store.create(task)

        let git = MockGit()
        git.aheadBehindResult = (ahead: 4, behind: 0)
        git.remoteBranches = ["feat/x", "dev"]
        git.ancestorResults = ["origin/main": false, "origin/dev": true]

        let pullRequests = MockTaskPullRequestClient()
        pullRequests.authenticated = true
        let prInfo = TermLoopTask.PRInfo(
            url: URL(string: "https://github.com/a/b/pull/1")!,
            number: 1, state: .open, title: "hi"
        )
        pullRequests.prs = [(branch: "feat/x", info: prInfo)]
        let identity = GitRemoteParser.identity(remoteName: "origin", cloneURL: "https://github.com/a/b.git")!

        let service = TaskSyncService(
            projectId: projectId,
            store: store,
            git: git,
            pullRequests: pullRequests,
            remoteIdentityResolver: { _ in identity },
            projectRoot: "/tmp/repo",
            trackedResolver: TrackedBranchesResolver(gitRunner: git),
            explicitTrackedBranches: nil
        )

        await service.localTick()
        await service.remoteTickForced()

        let updated = store.tasks(for: projectId).first!
        XCTAssertEqual(updated.mergeState.mergedInto, ["dev"])
        XCTAssertEqual(updated.mergeState.aheadBy, 4)
        XCTAssertEqual(updated.prInfo?.number, 1)
        XCTAssertNotNil(updated.lastSyncedAt)
    }
}

private final class MockGit: GitStateProvider, TrackedBranchesResolver.GitRunner {
    var aheadBehindResult: (ahead: Int, behind: Int)?
    var ancestorResults: [String: Bool] = [:]
    var remoteBranches: Set<String> = []

    func fetchAll(projectRoot: String) throws {}
    func defaultBranch(projectRoot: String) -> String? { "main" }
    func hasRemoteBranch(_ name: String, directory: String) -> Bool { remoteBranches.contains(name) }
    func aheadBehind(branch: String, upstream: String, worktreePath: String) -> (ahead: Int, behind: Int)? {
        aheadBehindResult
    }
    func isAncestor(branch: String, of tracked: String, projectRoot: String) -> Bool {
        ancestorResults[tracked] ?? false
    }
}

private final class MockTaskPullRequestClient: TaskPullRequestClient {
    var authenticated = false
    var prs: [(branch: String, info: TermLoopTask.PRInfo)] = []

    func isAuthenticated(identity: GitRemoteIdentity) async -> Bool { authenticated }
    func prList(identity: GitRemoteIdentity, branches: [String]) async throws -> [(branch: String, info: TermLoopTask.PRInfo)] {
        prs.filter { branches.contains($0.branch) }
    }
}
