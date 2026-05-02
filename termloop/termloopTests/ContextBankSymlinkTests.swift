import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ContextBankSymlinkTests: XCTestCase {
    func testPlannerDoesNotCreateLinksToDanglingSymlinkCanonical() throws {
        let root = try makeTemporaryDirectory()
        let claude = root.appendingPathComponent("CLAUDE.md")
        try FileManager.default.createSymbolicLink(
            at: claude,
            withDestinationURL: URL(fileURLWithPath: "AGENTS.md")
        )

        let plan = ContextBankSymlinker.plan(
            projectRoot: root,
            config: ContextBankSymlinkConfig(
                tracked: ["CLAUDE.md", "AGENTS.md"],
                canonical: nil,
                forceOverwriteDivergent: false
            )
        )

        XCTAssertEqual(plan.actionableCount, 0)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: root.appendingPathComponent("AGENTS.md").path)
        )
    }

    func testPlannerStillCreatesMirrorWhenCanonicalIsRegularFile() throws {
        let root = try makeTemporaryDirectory()
        let claude = root.appendingPathComponent("CLAUDE.md")
        try "Root context\n".write(to: claude, atomically: true, encoding: .utf8)

        let plan = ContextBankSymlinker.plan(
            projectRoot: root,
            config: ContextBankSymlinkConfig(
                tracked: ["CLAUDE.md", "AGENTS.md"],
                canonical: nil,
                forceOverwriteDivergent: false
            )
        )

        XCTAssertEqual(plan.createCount, 1)
        XCTAssertEqual(plan.items.first?.linkName, "AGENTS.md")
        XCTAssertEqual(plan.items.first?.targetName, "CLAUDE.md")
        XCTAssertEqual(ContextBankSymlinker.apply(plan), 1)
        XCTAssertEqual(
            try FileManager.default.destinationOfSymbolicLink(
                atPath: root.appendingPathComponent("AGENTS.md").path
            ),
            "CLAUDE.md"
        )
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("contextbank-symlink-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: url)
        }
        return url
    }
}
