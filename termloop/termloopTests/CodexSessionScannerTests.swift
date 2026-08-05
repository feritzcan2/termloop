import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class CodexSessionScannerTests: XCTestCase {
    private var tempDir: URL!
    private var sessionsDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodexSessionScannerTests-\(UUID().uuidString)", isDirectory: true)
        sessionsDir = tempDir.appendingPathComponent("sessions/2026/04/19", isDirectory: true)
        try FileManager.default.createDirectory(at: sessionsDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempDir {
            try? FileManager.default.removeItem(at: tempDir)
        }
        tempDir = nil
        sessionsDir = nil
    }

    func testScanReturnsNewestSessionForMatchingCwd() throws {
        let targetCwd = "/tmp/repo"
        let older = try writeSession(id: "sid-old", cwd: targetCwd, ageSeconds: 90)
        _ = older
        let newer = try writeSession(id: "sid-new", cwd: targetCwd, ageSeconds: 10)
        _ = newer
        try writeSession(id: "sid-other", cwd: "/tmp/other", ageSeconds: 1)

        let scanner = CodexSessionScanner(codexHome: tempDir)
        let results = scanner.scan(cwd: targetCwd)

        XCTAssertEqual(results.map(\.sessionId), ["sid-new", "sid-old"])
        XCTAssertEqual(results.first?.cwd, targetCwd)
    }

    func testScanSkipsFilesOlderThanCutoffWithoutParsingThem() throws {
        let targetCwd = "/tmp/repo"
        try writeSession(id: "sid-old", cwd: targetCwd, ageSeconds: 3_600)
        try writeSession(id: "sid-new", cwd: targetCwd, ageSeconds: 10)

        let scanner = CodexSessionScanner(codexHome: tempDir)
        let cutoff = Date().addingTimeInterval(-60)
        let results = scanner.scan(cwd: targetCwd, newerThan: cutoff)

        XCTAssertEqual(results.map(\.sessionId), ["sid-new"])
    }

    func testRecentUncachedScanSeesSessionCreatedAfterCachedIndex() throws {
        let targetCwd = "/tmp/repo"
        let scanner = CodexSessionScanner(codexHome: tempDir)

        XCTAssertTrue(scanner.scan(cwd: targetCwd).isEmpty)

        try writeSession(id: "sid-late", cwd: targetCwd, ageSeconds: 1)

        XCTAssertTrue(scanner.scan(cwd: targetCwd).isEmpty)
        XCTAssertEqual(
            scanner.scanRecentUncached(cwd: targetCwd, newerThan: Date().addingTimeInterval(-60)).map(\.sessionId),
            ["sid-late"]
        )
    }

    func testLastAssistantMessageReadsLatestAssistantOutput() throws {
        let targetCwd = "/tmp/repo"
        let url = try writeSession(id: "sid-answer", cwd: targetCwd, ageSeconds: 1)
        try """
        {"timestamp":"2026-04-19T10:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first answer"}]}}
        {"timestamp":"2026-04-19T10:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"final answer"}]}}
        """.appendLine(to: url)

        let scanner = CodexSessionScanner(codexHome: tempDir)
        XCTAssertEqual(scanner.lastAssistantMessage(sessionId: "sid-answer", cwd: targetCwd), "final answer")
    }

    func testLifecycleSnapshotReadsLatestLifecycleEvent() throws {
        let targetCwd = "/tmp/repo"
        let url = try writeSession(id: "sid-lifecycle", cwd: targetCwd, ageSeconds: 1)
        try """
        {"timestamp":"2026-04-19T10:00:01Z","type":"event_msg","payload":{"type":"task_started"}}
        {"timestamp":"2026-04-19T10:00:02Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}
        """.appendLine(to: url)

        let scanner = CodexSessionScanner(codexHome: tempDir)
        let snapshot = scanner.lifecycleSnapshot(sessionId: "sid-lifecycle", cwd: targetCwd)

        XCTAssertEqual(snapshot?.activity, .completed)
        XCTAssertEqual(
            snapshot?.timestamp,
            ISO8601DateFormatter().date(from: "2026-04-19T10:00:02Z")
        )
    }

    func testLatestModelReadsNewestTurnContext() throws {
        let targetCwd = "/tmp/repo"
        let url = try writeSession(id: "sid-model", cwd: targetCwd, ageSeconds: 1)
        try """
        {"timestamp":"2026-04-19T10:00:01Z","type":"turn_context","payload":{"model":"gpt-5.5"}}
        {"timestamp":"2026-04-19T10:00:02Z","type":"event_msg","payload":{"type":"task_complete"}}
        {"timestamp":"2026-04-19T10:00:03Z","type":"turn_context","payload":{"model":"gpt-5.6-terra"}}
        {"timestamp":"2026-04-19T10:00:04Z","type":"event_msg","payload":{"type":"task_started"}}
        """.appendLine(to: url)

        let scanner = CodexSessionScanner(codexHome: tempDir)

        XCTAssertEqual(
            scanner.latestModel(sessionId: "sid-model", cwd: targetCwd),
            .gpt56Terra
        )
    }

    func testSessionFileURLResolvesBySessionIdWithoutCwd() throws {
        let targetCwd = "/tmp/repo"
        let target = try writeSession(id: "sid-direct", cwd: targetCwd, ageSeconds: 5)
        try writeSession(id: "sid-other", cwd: "/tmp/other", ageSeconds: 1)

        let scanner = CodexSessionScanner(codexHome: tempDir)
        XCTAssertEqual(
            scanner.sessionFileURL(sessionId: "sid-direct", cwd: nil)?.resolvingSymlinksInPath(),
            target.resolvingSymlinksInPath()
        )
    }

    func testSessionContainingFindsExactPostCutoffTranscript() throws {
        let targetCwd = "/tmp/repo"
        let requestId = UUID().uuidString
        let matching = try writeSession(id: "sid-matching", cwd: targetCwd, ageSeconds: 10)
        try """
        {"timestamp":"2026-04-19T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Request ID: \(requestId)"}}
        """.appendLine(to: matching)
        try writeSession(id: "sid-newer-unrelated", cwd: targetCwd, ageSeconds: 1)

        let scanner = CodexSessionScanner(codexHome: tempDir)
        let recovered = scanner.sessionContaining(
            text: requestId.lowercased(),
            cwd: targetCwd,
            newerThan: Date().addingTimeInterval(-60)
        )

        XCTAssertEqual(recovered?.sessionId, "sid-matching")
        XCTAssertNil(scanner.sessionContaining(
            text: requestId,
            cwd: targetCwd,
            newerThan: Date().addingTimeInterval(60)
        ))
    }

    private func writeSession(id: String, cwd: String, ageSeconds: TimeInterval) throws -> URL {
        let url = sessionsDir.appendingPathComponent("rollout-\(id).jsonl")
        let firstLine = """
        {"timestamp":"2026-04-19T10:00:00Z","type":"session_meta","payload":{"id":"\(id)","timestamp":"2026-04-19T10:00:00Z","cwd":"\(cwd)"}}
        """
        try (firstLine + "\n").write(to: url, atomically: true, encoding: .utf8)
        let timestamp = Date().addingTimeInterval(-ageSeconds)
        try FileManager.default.setAttributes(
            [
                .modificationDate: timestamp,
                .creationDate: timestamp,
            ],
            ofItemAtPath: url.path
        )
        return url
    }
}

private extension String {
    func appendLine(to url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(utf8))
    }
}
