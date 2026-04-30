import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class ClaudeRestoreCoordinatorTests: XCTestCase {
    func testTermLoopWorktreeRootReturnsRootForNestedPath() {
        let root = WorktreeResolver.path(
            projectFolder: "/Users/test/Projects/ExampleProject",
            branch: "feature/DEMO-466"
        )!
        let nested = root + "/services/api"

        XCTAssertEqual(
            ClaudeRestoreCoordinator.termLoopWorktreeRoot(containing: nested),
            root
        )
    }

    func testTermLoopWorktreeRootReturnsRootPathUnchanged() {
        let root = WorktreeResolver.path(
            projectFolder: "/Users/test/Projects/ExampleProject",
            branch: "feature/DEMO-466"
        )!

        XCTAssertEqual(
            ClaudeRestoreCoordinator.termLoopWorktreeRoot(containing: root),
            root
        )
    }

    func testTermLoopWorktreeRootIgnoresNonTermLoopWorktreePaths() {
        XCTAssertNil(
            ClaudeRestoreCoordinator.termLoopWorktreeRoot(
                containing: "/Users/test/Projects/ExampleProject/legacy-worktrees/legacy"
            )
        )
        XCTAssertNil(
            ClaudeRestoreCoordinator.termLoopWorktreeRoot(
                containing: "/Users/test/Projects/ExampleProject"
            )
        )
    }

    func testBranchNameFromTitleExtractsWorktreeTitleBranch() {
        XCTAssertEqual(
            ClaudeRestoreCoordinator.branchNameFromTitle("feature/DEMO-504 (Claude Code)"),
            "feature/DEMO-504"
        )
        XCTAssertNil(ClaudeRestoreCoordinator.branchNameFromTitle("jira accessin var mi"))
    }

    func testBranchNameFromWorktreeLeafReversesTermLoopSlashEncoding() {
        XCTAssertEqual(
            ClaudeRestoreCoordinator.branchNameFromWorktreeLeaf(
                WorktreeResolver.path(
                    projectFolder: "/Users/test/Projects/ExampleProject",
                    branch: "feature/DEMO-504"
                )!
            ),
            "feature/DEMO-504"
        )
        XCTAssertEqual(
            ClaudeRestoreCoordinator.branchNameFromWorktreeLeaf(
                WorktreeResolver.path(
                    projectFolder: "/Users/test/Projects/ExampleProject",
                    branch: "plain-branch"
                )!
            ),
            "plain-branch"
        )
    }
}
