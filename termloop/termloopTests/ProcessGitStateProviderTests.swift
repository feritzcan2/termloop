import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ProcessGitStateProviderTests: XCTestCase {
    private var repoRoot: URL!

    override func setUp() async throws {
        repoRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gitprov-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repoRoot, withIntermediateDirectories: true)
        // Bare upstream + clone fixture
        try shell(["git", "init", "-q", "-b", "main"], cwd: repoRoot.path)
        try shell(["git", "config", "user.email", "test@example.com"], cwd: repoRoot.path)
        try shell(["git", "config", "user.name", "T"], cwd: repoRoot.path)
        try "hi".write(to: repoRoot.appendingPathComponent("R.md"), atomically: true, encoding: .utf8)
        try shell(["git", "add", "."], cwd: repoRoot.path)
        try shell(["git", "commit", "-qm", "init"], cwd: repoRoot.path)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: repoRoot)
    }

    func test_defaultBranch_returnsMain() {
        let provider = ProcessGitStateProvider()
        // In a repo with only main and no remote, symbolic-ref will fail;
        // fallback: current branch name.
        XCTAssertEqual(provider.defaultBranch(projectRoot: repoRoot.path), "main")
    }

    func test_isAncestor_trueWhenBranchMerged() throws {
        try shell(["git", "checkout", "-q", "-b", "feat/x"], cwd: repoRoot.path)
        try "x".write(to: repoRoot.appendingPathComponent("x.md"), atomically: true, encoding: .utf8)
        try shell(["git", "add", "."], cwd: repoRoot.path)
        try shell(["git", "commit", "-qm", "x"], cwd: repoRoot.path)
        try shell(["git", "checkout", "-q", "main"], cwd: repoRoot.path)
        try shell(["git", "merge", "-q", "--no-ff", "feat/x", "-m", "merge"], cwd: repoRoot.path)

        let provider = ProcessGitStateProvider()
        XCTAssertTrue(provider.isAncestor(branch: "feat/x", of: "main", projectRoot: repoRoot.path))
    }

    private func shell(_ args: [String], cwd: String) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        try p.run()
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, "\(args) failed")
    }
}
