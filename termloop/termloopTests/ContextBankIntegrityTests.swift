import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ContextBankIntegrityTests: XCTestCase {
    func testReportsBrokenContextSymlink() throws {
        let root = try makeTemporaryDirectory()
        let claude = root.appendingPathComponent("CLAUDE.md")
        try FileManager.default.createSymbolicLink(atPath: claude.path, withDestinationPath: "AGENTS.md")

        let issues = ContextBankIntegrityChecker.scan(projectRoot: root)

        XCTAssertEqual(issues.map(\.kind), [.brokenSymlink])
        XCTAssertEqual(issues.first?.relativePath, "CLAUDE.md")
    }

    func testReportsContextSymlinkEvenWhenTargetExists() throws {
        let root = try makeTemporaryDirectory()
        let claude = root.appendingPathComponent("CLAUDE.md")
        let agents = root.appendingPathComponent("AGENTS.md")
        try "Context\n".write(to: claude, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: agents.path, withDestinationPath: "CLAUDE.md")

        let issues = ContextBankIntegrityChecker.scan(projectRoot: root)

        XCTAssertEqual(issues.map(\.kind), [.contextSymlink])
        XCTAssertEqual(issues.first?.relativePath, "AGENTS.md")
    }

    func testReportsDivergentSiblingContextFiles() throws {
        let root = try makeTemporaryDirectory()
        try "Claude\n".write(to: root.appendingPathComponent("CLAUDE.md"), atomically: true, encoding: .utf8)
        try "Agents\n".write(to: root.appendingPathComponent("AGENTS.md"), atomically: true, encoding: .utf8)

        let issues = ContextBankIntegrityChecker.scan(projectRoot: root)

        XCTAssertEqual(issues.map(\.kind), [.divergentSiblings])
        XCTAssertEqual(issues.first?.relativePath, ".")
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("contextbank-integrity-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: url)
        }
        return url
    }
}
