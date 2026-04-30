import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class WorkspacePullRequestSidebarTests: XCTestCase {
    func testSidebarPullRequestsIgnoreStaleWorkspaceLevelCacheWithoutPanelState() throws {
        let workspace = Workspace(title: "Test")
        let panelId = UUID()
        let staleURL = try XCTUnwrap(URL(string: "https://github.com/feritzcan2/termloop/pull/1640"))

        workspace.pullRequest = SidebarPullRequestState(
            number: 1640,
            label: "PR",
            url: staleURL,
            status: .open,
            branch: "main"
        )
        workspace.gitBranch = SidebarGitBranchState(branch: "main", isDirty: false)

        XCTAssertEqual(workspace.sidebarPullRequestsInDisplayOrder(orderedPanelIds: [panelId]), [])
    }

    func testSidebarPullRequestsFilterBranchMismatchPerPanel() throws {
        let workspace = Workspace(title: "Test")
        let panelId = UUID()
        let staleURL = try XCTUnwrap(URL(string: "https://github.com/feritzcan2/termloop/pull/1640"))

        workspace.panelGitBranches[panelId] = SidebarGitBranchState(branch: "main", isDirty: false)
        workspace.panelPullRequests[panelId] = [SidebarPullRequestState(
            number: 1640,
            label: "PR",
            url: staleURL,
            status: .open,
            branch: "feature/old"
        )]

        XCTAssertEqual(workspace.sidebarPullRequestsInDisplayOrder(orderedPanelIds: [panelId]), [])
    }

    func testSidebarPullRequestsPreferBestStateAcrossPanels() throws {
        let workspace = Workspace(title: "Test")
        let firstPanelId = UUID()
        let secondPanelId = UUID()
        let url = try XCTUnwrap(URL(string: "https://github.com/feritzcan2/termloop/pull/1640"))

        workspace.panelGitBranches[firstPanelId] = SidebarGitBranchState(branch: "feature/work", isDirty: false)
        workspace.panelGitBranches[secondPanelId] = SidebarGitBranchState(branch: "feature/work", isDirty: false)
        workspace.panelPullRequests[firstPanelId] = [SidebarPullRequestState(
            number: 1640,
            label: "PR",
            url: url,
            status: .open,
            branch: "feature/work",
            isStale: true
        )]
        workspace.panelPullRequests[secondPanelId] = [SidebarPullRequestState(
            number: 1640,
            label: "PR",
            url: url,
            status: .merged,
            branch: "feature/work"
        )]

        XCTAssertEqual(
            workspace.sidebarPullRequestsInDisplayOrder(orderedPanelIds: [firstPanelId, secondPanelId]),
            [
                SidebarPullRequestState(
                    number: 1640,
                    label: "PR",
                    url: url,
                    status: .merged,
                    branch: "feature/work"
                )
            ]
        )
    }

    /// Regression: a single branch can own several PRs in parallel — the
    /// concrete shipping case is two merged PRs into `development` plus one
    /// open PR into `master`. Before the panelPullRequests pluralization
    /// the producer narrowed to a single "lead" PR per branch and the
    /// sidebar would show only one. With the multi-PR storage every PR
    /// must surface so OPEN PRs / MERGED PRs sections render correctly.
    func testSidebarPullRequestsSurfaceEveryPRForBranch() throws {
        let workspace = Workspace(title: "Test")
        let panelId = UUID()
        let firstMergedURL = try XCTUnwrap(URL(string: "https://dev.azure.com/Org/Repo/_git/Repo/pullrequest/11876"))
        let secondMergedURL = try XCTUnwrap(URL(string: "https://dev.azure.com/Org/Repo/_git/Repo/pullrequest/11877"))
        let openMasterURL = try XCTUnwrap(URL(string: "https://dev.azure.com/Org/Repo/_git/Repo/pullrequest/11899"))

        workspace.panelGitBranches[panelId] = SidebarGitBranchState(
            branch: "feature/DEMO-466",
            isDirty: false
        )
        // Producer-side ordering is open > merged > closed; tie-broken by
        // updatedAt desc, then PR number desc. setPanelPullRequests stores
        // the list as-is, so the input is what `sidebarPullRequestsInDisplayOrder`
        // will surface.
        workspace.setPanelPullRequests(panelId: panelId, [
            SidebarPullRequestState(
                number: 11899,
                label: "PR",
                url: openMasterURL,
                status: .open,
                branch: "feature/DEMO-466",
                baseBranch: "master"
            ),
            SidebarPullRequestState(
                number: 11877,
                label: "PR",
                url: secondMergedURL,
                status: .merged,
                branch: "feature/DEMO-466",
                baseBranch: "development"
            ),
            SidebarPullRequestState(
                number: 11876,
                label: "PR",
                url: firstMergedURL,
                status: .merged,
                branch: "feature/DEMO-466",
                baseBranch: "development"
            )
        ])

        let surfaced = workspace.sidebarPullRequestsInDisplayOrder(orderedPanelIds: [panelId])
        XCTAssertEqual(
            surfaced.map(\.number),
            [11899, 11877, 11876],
            "Every PR for the branch should surface, ordered open-first"
        )
        XCTAssertEqual(
            Set(surfaced.compactMap(\.baseBranch)),
            ["master", "development"],
            "Both base branches should be preserved (sidebar bucketing depends on this)"
        )
        XCTAssertEqual(
            workspace.primaryPanelPullRequest(panelId: panelId)?.number,
            11899,
            "primaryPanelPullRequest should return the lead (open) PR"
        )
    }

}
