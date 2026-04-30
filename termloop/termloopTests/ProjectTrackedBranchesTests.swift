import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ProjectTrackedBranchesTests: XCTestCase {
    func test_projectSnapshotRoundtrip_preservesTrackedBranches() throws {
        let project = Project(
            id: UUID(),
            name: "x",
            folderPath: "/tmp",
            createdAt: Date(),
            defaultTerminalAgentId: nil,
            trackedBranches: ["dev", "master"]
        )
        let snapshot = SessionProjectSnapshot(project)
        let data = try JSONEncoder().encode(snapshot)
        let decodedSnapshot = try JSONDecoder().decode(SessionProjectSnapshot.self, from: data)
        let restored = decodedSnapshot.project
        XCTAssertEqual(restored?.trackedBranches, ["dev", "master"])
    }

    func test_snapshotWithoutTrackedBranches_decodesToNil() throws {
        let json = """
        {
            "id": "\(UUID().uuidString)",
            "name": "x",
            "folderPath": "/tmp",
            "createdAt": 0
        }
        """
        let data = Data(json.utf8)
        let decoded = try JSONDecoder().decode(SessionProjectSnapshot.self, from: data)
        XCTAssertNil(decoded.trackedBranches)
        XCTAssertNil(decoded.project?.trackedBranches)
    }

    func test_trackedBranchesResolver_withExplicit_returnsExplicit() {
        let resolver = TrackedBranchesResolver(
            gitRunner: FixedGitRunner(defaultBranchValue: "main", hasDevBranch: true)
        )
        let result = resolver.resolve(explicit: ["custom", "staging"], projectRoot: "/tmp")
        XCTAssertEqual(result, ["custom", "staging"])
    }

    func test_trackedBranchesResolver_whenNil_autoDetectsDefaultAndDev() {
        let resolver = TrackedBranchesResolver(
            gitRunner: FixedGitRunner(defaultBranchValue: "master", hasDevBranch: true)
        )
        XCTAssertEqual(resolver.resolve(explicit: nil, projectRoot: "/tmp"), ["master", "dev"])
    }

    func test_trackedBranchesResolver_whenNoDev_returnsOnlyDefault() {
        let resolver = TrackedBranchesResolver(
            gitRunner: FixedGitRunner(defaultBranchValue: "main", hasDevBranch: false)
        )
        XCTAssertEqual(resolver.resolve(explicit: nil, projectRoot: "/tmp"), ["main"])
    }
}

private struct FixedGitRunner: TrackedBranchesResolver.GitRunner {
    let defaultBranchValue: String?
    let hasDevBranch: Bool

    func defaultBranch(projectRoot: String) -> String? { defaultBranchValue }
    func hasRemoteBranch(_ name: String, directory: String) -> Bool {
        name == "dev" ? hasDevBranch : false
    }
}
