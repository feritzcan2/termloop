import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ClaudeSessionScannerTests: XCTestCase {
    private var tempProjectsDir: URL!

    override func setUpWithError() throws {
        tempProjectsDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claude-session-scanner-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempProjectsDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempProjectsDir)
    }

    private func fixtureURL(_ name: String) -> URL {
        Bundle(for: Self.self).url(
            forResource: name, withExtension: "jsonl",
            subdirectory: "Fixtures/SessionResume")!
    }

    func test_scan_emptyForCwdWithoutSlugDir() {
        let scanner = ClaudeSessionScanner(projectsDir: tempProjectsDir)
        XCTAssertEqual(scanner.scan(cwd: "/nonexistent/path"), [])
    }

    func test_scan_extractsMetadataFromFixture() throws {
        let slug = "-tmp-sample-repo"
        let slugDir = tempProjectsDir.appendingPathComponent(slug)
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)
        let sid = "abc123"
        let dest = slugDir.appendingPathComponent("\(sid).jsonl")
        try FileManager.default.copyItem(at: fixtureURL("session-sample"), to: dest)

        let scanner = ClaudeSessionScanner(projectsDir: tempProjectsDir)
        let results = scanner.scan(cwd: "/tmp/sample-repo")

        XCTAssertEqual(results.count, 1)
        let m = results[0]
        XCTAssertEqual(m.sessionId, sid)
        XCTAssertEqual(m.cwd, "/tmp/sample-repo")
        XCTAssertEqual(m.title, "fix the tab lag issue")
        XCTAssertGreaterThanOrEqual(m.messageCount, 3)
        XCTAssertTrue(m.lastAssistantSnippet.contains("Found it"))
        XCTAssertFalse(m.previewLines.isEmpty)
    }

    func test_scan_findsSessionsForCwdContainingDot() throws {
        // Claude Code's on-disk slug replaces both `/` and `.` with `-`, so
        // `/tmp/repo/.termloop-worktrees/branch` maps to `-tmp-repo--termloop-worktrees-branch`
        // (double dash). The scanner must match that encoding.
        let cwd = "/tmp/repo/.termloop-worktrees/branch"
        let slug = ClaudeSessionScanner.slug(forCwd: cwd)
        XCTAssertEqual(slug, "-tmp-repo--termloop-worktrees-branch")
        let slugDir = tempProjectsDir.appendingPathComponent(slug)
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)
        let content = """
        {"type":"user","cwd":"/tmp/repo/.termloop-worktrees/branch","message":{"role":"user","content":"hello"},"timestamp":"2026-04-15T10:00:00Z"}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"world"}]},"timestamp":"2026-04-15T10:00:01Z"}

        """
        try content.write(
            to: slugDir.appendingPathComponent("dotted.jsonl"),
            atomically: true, encoding: .utf8)

        let scanner = ClaudeSessionScanner(projectsDir: tempProjectsDir)
        let r = scanner.scan(cwd: cwd)
        XCTAssertEqual(r.count, 1, "slug function must replace `.` with `-` like Claude Code does")
        let result = try XCTUnwrap(r.first)
        XCTAssertEqual(result.title, "hello")
    }

    func test_scan_malformedLinesAreSkipped() throws {
        let slug = "-tmp-mal"
        let slugDir = tempProjectsDir.appendingPathComponent(slug)
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)
        let content = """
        {"type":"user","cwd":"/tmp/mal","message":{"role":"user","content":"hi"},"timestamp":"2026-04-14T10:00:00Z"}
        {not valid json
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"timestamp":"2026-04-14T10:00:01Z"}

        """
        try content.write(
            to: slugDir.appendingPathComponent("sid.jsonl"),
            atomically: true, encoding: .utf8)

        let scanner = ClaudeSessionScanner(projectsDir: tempProjectsDir)
        let r = scanner.scan(cwd: "/tmp/mal")
        XCTAssertEqual(r.count, 1)
        XCTAssertEqual(r[0].title, "hi")
    }

    func test_scan_newerThanSkipsOlderFilesWithoutParsingThem() throws {
        let cwd = "/tmp/repo"
        let slugDir = tempProjectsDir.appendingPathComponent(ClaudeSessionScanner.slug(forCwd: cwd))
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)

        let oldURL = slugDir.appendingPathComponent("old.jsonl")
        try """
        {"type":"user","cwd":"\(cwd)","message":{"role":"user","content":"old"},"timestamp":"2026-04-14T10:00:00Z"}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"old reply"}]},"timestamp":"2026-04-14T10:00:01Z"}
        """.write(to: oldURL, atomically: true, encoding: .utf8)

        let newURL = slugDir.appendingPathComponent("new.jsonl")
        try """
        {"type":"user","cwd":"\(cwd)","message":{"role":"user","content":"new"},"timestamp":"2026-04-15T10:00:00Z"}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"new reply"}]},"timestamp":"2026-04-15T10:00:01Z"}
        """.write(to: newURL, atomically: true, encoding: .utf8)

        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-3_600)],
            ofItemAtPath: oldURL.path
        )
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-10)],
            ofItemAtPath: newURL.path
        )

        let scanner = ClaudeSessionScanner(projectsDir: tempProjectsDir)
        let results = scanner.scan(cwd: cwd, newerThan: Date().addingTimeInterval(-60))

        XCTAssertEqual(results.map(\.sessionId), ["new"])
    }

    func test_scan_multipleCwds_mergesAndDedupesBySessionId() throws {
        let rootCwd = "/tmp/repo"
        let worktreeCwd = "/tmp/repo/.termloop-worktrees/feature"

        let rootDir = tempProjectsDir.appendingPathComponent(ClaudeSessionScanner.slug(forCwd: rootCwd))
        let worktreeDir = tempProjectsDir.appendingPathComponent(ClaudeSessionScanner.slug(forCwd: worktreeCwd))
        try FileManager.default.createDirectory(at: rootDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: worktreeDir, withIntermediateDirectories: true)

        let sharedSession = "shared"
        let rootShared = rootDir.appendingPathComponent("\(sharedSession).jsonl")
        try """
        {"type":"user","cwd":"\(rootCwd)","message":{"role":"user","content":"older root"},"timestamp":"2026-04-14T10:00:00Z"}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"root reply"}]},"timestamp":"2026-04-14T10:00:01Z"}
        """.write(to: rootShared, atomically: true, encoding: .utf8)

        let worktreeShared = worktreeDir.appendingPathComponent("\(sharedSession).jsonl")
        try """
        {"type":"user","cwd":"\(worktreeCwd)","message":{"role":"user","content":"newer worktree"},"timestamp":"2026-04-15T10:00:00Z"}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"worktree reply"}]},"timestamp":"2026-04-15T10:00:01Z"}
        """.write(to: worktreeShared, atomically: true, encoding: .utf8)

        let rootOnly = rootDir.appendingPathComponent("root-only.jsonl")
        try """
        {"type":"user","cwd":"\(rootCwd)","message":{"role":"user","content":"root only"},"timestamp":"2026-04-13T10:00:00Z"}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"root only reply"}]},"timestamp":"2026-04-13T10:00:01Z"}
        """.write(to: rootOnly, atomically: true, encoding: .utf8)

        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 100)],
            ofItemAtPath: rootShared.path
        )
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 300)],
            ofItemAtPath: worktreeShared.path
        )
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 200)],
            ofItemAtPath: rootOnly.path
        )

        let scanner = ClaudeSessionScanner(projectsDir: tempProjectsDir)
        let results = scanner.scan(cwds: [rootCwd, worktreeCwd, rootCwd])

        XCTAssertEqual(results.map(\.sessionId), ["shared", "root-only"])
        XCTAssertEqual(results.first?.cwd, worktreeCwd, "newest duplicate should win")
    }

    func test_sessionFileURL_resolvesExactSessionId() throws {
        let cwd = "/tmp/repo/.termloop-worktrees/branch"
        let slugDir = tempProjectsDir.appendingPathComponent(ClaudeSessionScanner.slug(forCwd: cwd))
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)
        let expected = slugDir.appendingPathComponent("exact.jsonl")
        try "{}\n".write(to: expected, atomically: true, encoding: .utf8)
        try "{}\n".write(
            to: slugDir.appendingPathComponent("other.jsonl"),
            atomically: true,
            encoding: .utf8
        )

        let scanner = ClaudeSessionScanner(projectsDir: tempProjectsDir)
        let resolved = scanner.sessionFileURL(sessionId: "exact", cwd: cwd)

        XCTAssertEqual(resolved, expected)
    }

    func test_sessionContainingFindsExactPostCutoffTranscript() throws {
        let cwd = "/tmp/repo"
        let requestId = UUID().uuidString
        let slugDir = tempProjectsDir.appendingPathComponent(ClaudeSessionScanner.slug(forCwd: cwd))
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)

        let matching = slugDir.appendingPathComponent("matching.jsonl")
        try """
        {"type":"user","cwd":"\(cwd)","message":{"role":"user","content":"Request ID: \(requestId)"}}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}
        """.write(to: matching, atomically: true, encoding: .utf8)

        let unrelated = slugDir.appendingPathComponent("unrelated.jsonl")
        try """
        {"type":"user","cwd":"\(cwd)","message":{"role":"user","content":"newer unrelated session"}}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"other"}]}}
        """.write(to: unrelated, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(1)],
            ofItemAtPath: unrelated.path
        )

        let scanner = ClaudeSessionScanner(projectsDir: tempProjectsDir)
        let recovered = scanner.sessionContaining(
            text: requestId.lowercased(),
            cwd: cwd,
            newerThan: Date().addingTimeInterval(-60)
        )

        XCTAssertEqual(recovered?.sessionId, "matching")
        XCTAssertNil(scanner.sessionContaining(
            text: requestId,
            cwd: cwd,
            newerThan: Date().addingTimeInterval(60)
        ))
    }
}
