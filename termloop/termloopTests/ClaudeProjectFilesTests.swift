import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ClaudeProjectFilesTests: XCTestCase {
    private var tempProjectsDir: URL!

    override func setUpWithError() throws {
        tempProjectsDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claude-project-files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempProjectsDir,
            withIntermediateDirectories: true
        )
        ClaudeProjectFiles.projectsRootOverride = tempProjectsDir
    }

    override func tearDownWithError() throws {
        ClaudeProjectFiles.projectsRootOverride = nil
        try? FileManager.default.removeItem(at: tempProjectsDir)
    }

    func testEnsureSessionAvailableFindsLegacyWorktreeSlug() throws {
        let sessionId = "b0ca2611-1a9a-4e82-a794-1f03e33f7f68"
        let currentCwd = "/tmp/repo/.termloop-worktrees/feature__DEMO-466-bacc"
        let legacyCwd = currentCwd.replacingOccurrences(of: "__", with: "--")

        let legacyDir = ClaudeProjectFiles.projectDirectory(forCwd: legacyCwd)
        try FileManager.default.createDirectory(
            at: legacyDir,
            withIntermediateDirectories: true
        )
        let legacyFile = legacyDir.appendingPathComponent("\(sessionId).jsonl")
        try "{}\n".write(to: legacyFile, atomically: true, encoding: .utf8)

        XCTAssertTrue(
            ClaudeProjectFiles.ensureSessionAvailable(
                sessionId: sessionId,
                targetCwd: currentCwd,
                sourceCwds: [currentCwd]
            )
        )

        let targetFile = ClaudeProjectFiles.projectDirectory(forCwd: currentCwd)
            .appendingPathComponent("\(sessionId).jsonl")
        XCTAssertTrue(FileManager.default.fileExists(atPath: targetFile.path))
    }

    func testEnsureSessionAvailableCopiesFromDirectSourceCwd() throws {
        let sessionId = "7a3f0f91-c7a5-4b82-b11a-7a5f98aeb1f2"
        let sourceCwd = "/tmp/repo"
        let targetCwd = "/tmp/repo/.termloop-worktrees/feature"

        let sourceDir = ClaudeProjectFiles.projectDirectory(forCwd: sourceCwd)
        try FileManager.default.createDirectory(
            at: sourceDir,
            withIntermediateDirectories: true
        )
        try "{}\n".write(
            to: sourceDir.appendingPathComponent("\(sessionId).jsonl"),
            atomically: true,
            encoding: .utf8
        )

        XCTAssertTrue(
            ClaudeProjectFiles.ensureSessionAvailable(
                sessionId: sessionId,
                targetCwd: targetCwd,
                sourceCwds: [sourceCwd]
            )
        )

        let targetFile = ClaudeProjectFiles.projectDirectory(forCwd: targetCwd)
            .appendingPathComponent("\(sessionId).jsonl")
        XCTAssertTrue(FileManager.default.fileExists(atPath: targetFile.path))
    }

    /// Regression: when a running agent is moved into a worktree, the
    /// resumed conversation must edit files in the WORKTREE, not in the
    /// source cwd. The transcript carries absolute file_path references
    /// from the source cwd; if those aren't rewritten on migration,
    /// Claude's next Edit/Read silently lands on the wrong branch.
    func testMigrateSessionRewritesAbsolutePathsUnderSourceCwd() throws {
        let sessionId = "f4e2c9a1-aa11-44ee-aa11-001122334455"
        let sourceCwd = "/tmp/repo"
        let targetCwd = "/tmp/repo/.termloop-worktrees/feature"

        let sourceDir = ClaudeProjectFiles.projectDirectory(forCwd: sourceCwd)
        try FileManager.default.createDirectory(
            at: sourceDir,
            withIntermediateDirectories: true
        )

        // Realistic-shape JSONL: one user message, one assistant tool_use
        // referencing an absolute file_path, and one tool_result containing
        // the same source path embedded in text. Plus an unrelated /etc
        // path that must be left alone.
        let lines = [
            #"{"type":"user","message":{"role":"user","content":"please fix /tmp/repo/Sources/Bar.swift"}}"#,
            #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/repo/Sources/Bar.swift","old_string":"x","new_string":"y"}}]}}"#,
            #"{"type":"tool_result","content":"Edited /tmp/repo/Sources/Bar.swift; system file /etc/hosts unchanged"}"#
        ]
        let jsonl = lines.joined(separator: "\n") + "\n"
        try jsonl.write(
            to: sourceDir.appendingPathComponent("\(sessionId).jsonl"),
            atomically: true,
            encoding: .utf8
        )

        XCTAssertTrue(
            ClaudeProjectFiles.migrateSession(
                sessionId: sessionId,
                targetCwd: targetCwd,
                sourceCwds: [sourceCwd]
            )
        )

        let targetFile = ClaudeProjectFiles.projectDirectory(forCwd: targetCwd)
            .appendingPathComponent("\(sessionId).jsonl")
        let migrated = try String(contentsOf: targetFile, encoding: .utf8)

        XCTAssertFalse(
            migrated.contains("\"/tmp/repo/Sources/Bar.swift\""),
            "Migration left the source absolute path \"/tmp/repo/Sources/Bar.swift\" intact in the JSONL — the resumed agent will edit the wrong branch."
        )
        XCTAssertTrue(
            migrated.contains("/tmp/repo/.termloop-worktrees/feature/Sources/Bar.swift"),
            "Migration did not rewrite the source path to the worktree path."
        )
        XCTAssertTrue(
            migrated.contains("/etc/hosts"),
            "Migration must not rewrite paths outside the source cwd."
        )
        // Defensive: don't double-prefix when fromCwd is a substring of toCwd.
        XCTAssertFalse(
            migrated.contains("/.termloop-worktrees/feature/.termloop-worktrees/"),
            "Path was double-prefixed — fromCwd matched again inside the already-rewritten toCwd."
        )
    }

    /// Regression: a session reached through a symlinked cwd can record
    /// transcript paths in either the symlink form or the resolved-realpath
    /// form. On macOS, `/tmp` → `/private/tmp` is the everyday case. A
    /// purely textual rewrite using only the literal `fromCwd` would miss
    /// any path written in the alternate form, so the resumed agent would
    /// keep editing files via `/private/tmp/...` (= the source branch).
    func testMigrateSessionRewritesPathsInResolvedSymlinkForm() throws {
        let sessionId = "11111111-aaaa-bbbb-cccc-222222222222"
        let symlinkCwd = "/tmp/termloop-test-symlink-\(UUID().uuidString.prefix(6))"
        let resolvedCwd = (symlinkCwd as NSString).resolvingSymlinksInPath
        try XCTSkipIf(
            symlinkCwd == resolvedCwd,
            "Test environment doesn't have /tmp -> /private/tmp symlink."
        )
        let targetCwd = symlinkCwd + "/.termloop-worktrees/feature"

        let sourceDir = ClaudeProjectFiles.projectDirectory(forCwd: symlinkCwd)
        try FileManager.default.createDirectory(
            at: sourceDir,
            withIntermediateDirectories: true
        )

        let lines = [
            #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"\#(symlinkCwd)/Sources/A.swift"}}]}}"#,
            #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"\#(resolvedCwd)/Sources/B.swift"}}]}}"#
        ]
        try (lines.joined(separator: "\n") + "\n").write(
            to: sourceDir.appendingPathComponent("\(sessionId).jsonl"),
            atomically: true,
            encoding: .utf8
        )

        XCTAssertTrue(
            ClaudeProjectFiles.migrateSession(
                sessionId: sessionId,
                targetCwd: targetCwd,
                sourceCwds: [symlinkCwd]
            )
        )

        let migrated = try String(
            contentsOf: ClaudeProjectFiles.projectDirectory(forCwd: targetCwd)
                .appendingPathComponent("\(sessionId).jsonl"),
            encoding: .utf8
        )

        XCTAssertTrue(
            migrated.contains("\(targetCwd)/Sources/A.swift"),
            "Symlink-form path was not rewritten."
        )
        XCTAssertTrue(
            migrated.contains("\(targetCwd)/Sources/B.swift"),
            "Realpath-form path was not rewritten — migration only handled the literal fromCwd form."
        )
        XCTAssertFalse(
            migrated.contains("\(resolvedCwd)/Sources/B.swift"),
            "Realpath-form path leaked through; resumed agent would edit the source branch via /private/tmp."
        )
    }

    /// Regression: the JSONL header line carries `cwd` (and sometimes
    /// `originalCwd`). `ClaudeSessionScanner` reads the first `cwd` it
    /// sees, so if migration leaves the header pointing at the source
    /// path, downstream lookups still resolve to the wrong branch even
    /// when every other in-transcript path was rewritten.
    func testMigrateSessionRewritesHeaderCwdAndOriginalCwd() throws {
        let sessionId = "33333333-aaaa-bbbb-cccc-444444444444"
        let sourceCwd = "/tmp/repo-header-test"
        let targetCwd = "/tmp/repo-header-test/.termloop-worktrees/branch"

        let sourceDir = ClaudeProjectFiles.projectDirectory(forCwd: sourceCwd)
        try FileManager.default.createDirectory(
            at: sourceDir,
            withIntermediateDirectories: true
        )

        let lines = [
            #"{"type":"summary","cwd":"\#(sourceCwd)","originalCwd":"\#(sourceCwd)","sessionId":"\#(sessionId)"}"#,
            #"{"type":"user","message":{"role":"user","content":"hi"}}"#
        ]
        try (lines.joined(separator: "\n") + "\n").write(
            to: sourceDir.appendingPathComponent("\(sessionId).jsonl"),
            atomically: true,
            encoding: .utf8
        )

        XCTAssertTrue(
            ClaudeProjectFiles.migrateSession(
                sessionId: sessionId,
                targetCwd: targetCwd,
                sourceCwds: [sourceCwd]
            )
        )

        let migrated = try String(
            contentsOf: ClaudeProjectFiles.projectDirectory(forCwd: targetCwd)
                .appendingPathComponent("\(sessionId).jsonl"),
            encoding: .utf8
        )

        XCTAssertTrue(
            migrated.contains("\"cwd\":\"\(targetCwd)\""),
            "Header `cwd` was not rewritten — ClaudeSessionScanner will route the resumed agent back to the source branch."
        )
        XCTAssertTrue(
            migrated.contains("\"originalCwd\":\"\(targetCwd)\""),
            "Header `originalCwd` was not rewritten."
        )
        XCTAssertFalse(
            migrated.contains("\"\(sourceCwd)\""),
            "Source cwd substring still present in migrated header."
        )
    }

    func testSessionExistsFindsLegacyWorktreeSlug() throws {
        let sessionId = "ae0ede94-9594-4197-a92b-c13e8a75569a"
        let cwd = "/tmp/repo/.termloop-worktrees/feature__DEMO-466-bacc"
        let legacyCwd = cwd.replacingOccurrences(of: "__", with: "--")

        let legacyDir = ClaudeProjectFiles.projectDirectory(forCwd: legacyCwd)
        try FileManager.default.createDirectory(
            at: legacyDir,
            withIntermediateDirectories: true
        )
        try "{}\n".write(
            to: legacyDir.appendingPathComponent("\(sessionId).jsonl"),
            atomically: true,
            encoding: .utf8
        )

        XCTAssertTrue(ClaudeProjectFiles.sessionExists(sessionId: sessionId, cwd: cwd))
    }
}
