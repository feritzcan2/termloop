// termloop/termloopTests/BridgeMessageExtractorTests.swift
import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class BridgeMessageExtractorTests: XCTestCase {
    func testReturnsNilForUnsupportedAgent() {
        let extractor = BridgeMessageExtractor(
            claudeScanner: ClaudeSessionScanner(projectsDir: URL(fileURLWithPath: "/nonexistent")),
            codexScanner: CodexSessionScanner(codexHome: URL(fileURLWithPath: "/nonexistent"))
        )
        XCTAssertNil(extractor.lastAssistantMessage(agentId: "gemini", sessionId: nil, cwd: "/tmp"))
        XCTAssertNil(extractor.lastAssistantMessage(agentId: "opencode", sessionId: nil, cwd: "/tmp"))
        XCTAssertNil(extractor.lastAssistantMessage(agentId: "", sessionId: nil, cwd: "/tmp"))
    }

    func testDispatchesToClaudeForClaudeAgent() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("extractor-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let cwd = "/ext/claude"
        let slug = ClaudeSessionScanner.slug(forCwd: cwd)
        let slugDir = tmp.appendingPathComponent(slug)
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)
        let file = slugDir.appendingPathComponent("s.jsonl")
        try """
        {"type":"user","cwd":"\(cwd)","message":{"content":"q"}}
        {"type":"assistant","message":{"content":[{"type":"text","text":"answer"}]}}
        """.write(to: file, atomically: true, encoding: .utf8)

        let extractor = BridgeMessageExtractor(
            claudeScanner: ClaudeSessionScanner(projectsDir: tmp)
        )
        XCTAssertEqual(
            extractor.lastAssistantMessage(agentId: "claude", sessionId: nil, cwd: cwd),
            "answer"
        )
    }

    func testDispatchesToCodexForCodexAgent() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("extractor-codex-\(UUID().uuidString)", isDirectory: true)
        let sessionsDir = tmp.appendingPathComponent("sessions/2026/04/19", isDirectory: true)
        try FileManager.default.createDirectory(at: sessionsDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let cwd = "/ext/codex"
        let file = sessionsDir.appendingPathComponent("rollout-sid.jsonl")
        try """
        {"timestamp":"2026-04-19T10:00:00Z","type":"session_meta","payload":{"id":"sid","timestamp":"2026-04-19T10:00:00Z","cwd":"\(cwd)"}}
        {"timestamp":"2026-04-19T10:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"codex-answer"}]}}
        """.write(to: file, atomically: true, encoding: .utf8)

        let extractor = BridgeMessageExtractor(
            claudeScanner: ClaudeSessionScanner(projectsDir: URL(fileURLWithPath: "/nonexistent")),
            codexScanner: CodexSessionScanner(codexHome: tmp)
        )
        XCTAssertEqual(
            extractor.lastAssistantMessage(agentId: "codex", sessionId: "sid", cwd: cwd),
            "codex-answer"
        )
    }
}
