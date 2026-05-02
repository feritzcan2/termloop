import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ContextBankMirrorTests: XCTestCase {
    func testPlannerDoesNotCreateCopiesFromDanglingSymlinkCanonical() throws {
        let root = try makeTemporaryDirectory()
        let claude = root.appendingPathComponent("CLAUDE.md")
        try FileManager.default.createSymbolicLink(
            at: claude,
            withDestinationURL: URL(fileURLWithPath: "AGENTS.md")
        )

        let plan = ContextBankMirrorPlanner.plan(
            projectRoot: root,
            config: ContextBankMirrorConfig(
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

    func testPlannerCreatesRealMirrorCopyWhenCanonicalIsRegularFile() throws {
        let root = try makeTemporaryDirectory()
        let claude = root.appendingPathComponent("CLAUDE.md")
        try "Root context\n".write(to: claude, atomically: true, encoding: .utf8)

        let plan = ContextBankMirrorPlanner.plan(
            projectRoot: root,
            config: ContextBankMirrorConfig(
                tracked: ["CLAUDE.md", "AGENTS.md"],
                canonical: nil,
                forceOverwriteDivergent: false
            )
        )

        XCTAssertEqual(plan.createCount, 1)
        XCTAssertEqual(plan.items.first?.linkName, "AGENTS.md")
        XCTAssertEqual(plan.items.first?.targetName, "CLAUDE.md")
        XCTAssertEqual(ContextBankMirrorPlanner.apply(plan), 1)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("AGENTS.md"), encoding: .utf8), "Root context\n")
        XCTAssertFalse(try isSymbolicLink(root.appendingPathComponent("AGENTS.md")))
    }

    func testPlannerReplacesLegacySymlinkWithRealCopy() throws {
        let root = try makeTemporaryDirectory()
        let claude = root.appendingPathComponent("CLAUDE.md")
        let agents = root.appendingPathComponent("AGENTS.md")
        try "Root context\n".write(to: claude, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: agents.path, withDestinationPath: "CLAUDE.md")

        let plan = ContextBankMirrorPlanner.plan(
            projectRoot: root,
            config: ContextBankMirrorConfig(
                tracked: ["CLAUDE.md", "AGENTS.md"],
                canonical: nil,
                forceOverwriteDivergent: false
            )
        )

        XCTAssertEqual(plan.convertCount, 1)
        XCTAssertEqual(ContextBankMirrorPlanner.apply(plan), 1)
        XCTAssertEqual(try String(contentsOf: agents, encoding: .utf8), "Root context\n")
        XCTAssertFalse(try isSymbolicLink(agents))
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("contextbank-mirror-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: url)
        }
        return url
    }

    private func isSymbolicLink(_ url: URL) throws -> Bool {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs[.type] as? FileAttributeType) == .typeSymbolicLink
    }
}
