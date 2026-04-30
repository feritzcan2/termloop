import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class TaskPullRequestClientTests: XCTestCase {
    func test_gitHostTaskPullRequestClient_mapsHostedPullRequests() async throws {
        let identity = GitRemoteParser.identity(
            remoteName: "origin",
            cloneURL: "https://github.com/acme/app.git"
        )!
        let client = GitHostTaskPullRequestClient { _ in
            StubGitHostProvider(identity: identity)
        }

        let prs = try await client.prList(identity: identity, branches: ["feat/x", "feat/y"])
        let byBranch = Dictionary(uniqueKeysWithValues: prs.map { ($0.branch, $0.info) })

        XCTAssertEqual(byBranch["feat/x"]?.number, 42)
        XCTAssertEqual(byBranch["feat/x"]?.state, .open)
        XCTAssertEqual(byBranch["feat/x"]?.title, "Add x")
        XCTAssertEqual(byBranch["feat/y"]?.number, 7)
        XCTAssertEqual(byBranch["feat/y"]?.state, .merged)
    }
}

private struct StubGitHostProvider: GitHostProvider {
    let identity: GitRemoteIdentity

    func pullRequestURL(number: Int) -> URL? {
        URL(string: "https://github.com/acme/app/pull/\(number)")
    }

    func listPullRequests(branch: String) async throws -> [HostPullRequest] {
        switch branch {
        case "feat/x":
            return [
                HostPullRequest(
                    id: "x",
                    number: 42,
                    title: "Add x",
                    url: URL(string: "https://github.com/acme/app/pull/42")!,
                    sourceBranch: "feat/x",
                    targetBranch: "main",
                    state: .open,
                    updatedAt: nil
                )
            ]
        case "feat/y":
            return [
                HostPullRequest(
                    id: "y",
                    number: 7,
                    title: "Merge y",
                    url: URL(string: "https://github.com/acme/app/pull/7")!,
                    sourceBranch: "feat/y",
                    targetBranch: "main",
                    state: .merged,
                    updatedAt: nil
                )
            ]
        default:
            return []
        }
    }

    func createPullRequest(_ input: CreatePullRequestInput) async throws -> HostPullRequest {
        HostPullRequest(
            id: "created",
            number: 99,
            title: input.title,
            url: URL(string: "https://github.com/acme/app/pull/99")!,
            sourceBranch: input.sourceBranch,
            targetBranch: input.targetBranch,
            state: input.draft ? .draft : .open,
            updatedAt: nil
        )
    }
}
