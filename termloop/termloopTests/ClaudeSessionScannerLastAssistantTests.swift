import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ClaudeSessionScannerLastAssistantTests: XCTestCase {
    func testReturnsNilForMissingDirectory() {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("nope-\(UUID().uuidString)")
        let scanner = ClaudeSessionScanner(projectsDir: tmp)
        XCTAssertNil(scanner.lastAssistantMessage(cwd: "/any/path"))
    }

    func testReturnsLastAssistantFromMostRecentJSONL() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("claudetest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let cwd = "/Users/example/repo"
        let slug = ClaudeSessionScanner.slug(forCwd: cwd)
        let slugDir = tmp.appendingPathComponent(slug, isDirectory: true)
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)

        // Two sessions; newer one wins.
        let older = slugDir.appendingPathComponent("old.jsonl")
        try """
        {"type":"user","cwd":"\(cwd)","message":{"content":"hi"}}
        {"type":"assistant","message":{"content":[{"type":"text","text":"old reply"}]}}
        """.write(to: older, atomically: true, encoding: .utf8)

        // Make newer one's mtime later by writing it after.
        Thread.sleep(forTimeInterval: 0.05)
        let newer = slugDir.appendingPathComponent("new.jsonl")
        try """
        {"type":"user","cwd":"\(cwd)","message":{"content":"hi again"}}
        {"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}
        {"type":"user","message":{"content":"more"}}
        {"type":"assistant","message":{"content":[{"type":"text","text":"second answer"}]}}
        """.write(to: newer, atomically: true, encoding: .utf8)

        let scanner = ClaudeSessionScanner(projectsDir: tmp)
        let msg = scanner.lastAssistantMessage(cwd: cwd)
        XCTAssertEqual(msg, "second answer")
    }

    func testHandlesMultipleContentChunks() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("claudetest2-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let cwd = "/tmp/repo-multi"
        let slug = ClaudeSessionScanner.slug(forCwd: cwd)
        let slugDir = tmp.appendingPathComponent(slug, isDirectory: true)
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)

        let file = slugDir.appendingPathComponent("multi.jsonl")
        try """
        {"type":"user","cwd":"\(cwd)","message":{"content":"q"}}
        {"type":"assistant","message":{"content":[{"type":"text","text":"part one"},{"type":"text","text":"part two"}]}}
        """.write(to: file, atomically: true, encoding: .utf8)

        let scanner = ClaudeSessionScanner(projectsDir: tmp)
        let msg = scanner.lastAssistantMessage(cwd: cwd)
        XCTAssertEqual(msg, "part one\n\npart two")
    }
}
