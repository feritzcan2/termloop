import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ProjectScopeHookCleanerTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phc-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    func test_removesTermLoopOwnedEntry_preservesUserEntry() throws {
        let settingsURL = tempDir.appendingPathComponent(".claude/settings.json")
        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let contents: [String: Any] = [
            "hooks": [
                "SessionStart": [
                    [
                        "hooks": [
                            ["type": "command", "command": "termloop claude-hook session-start"]
                        ]
                    ] as [String: Any],
                    [
                        "hooks": [
                            ["type": "command", "command": "my-custom-hook.sh"]
                        ]
                    ] as [String: Any]
                ]
            ]
        ]
        try JSONSerialization.data(withJSONObject: contents).write(to: settingsURL)

        ProjectScopeHookCleaner.cleanup(projectURL: tempDir, for: .claude)

        let updated = try JSONSerialization.jsonObject(with: Data(contentsOf: settingsURL)) as! [String: Any]
        let hooks = updated["hooks"] as! [String: Any]
        let sessionStart = hooks["SessionStart"] as! [[String: Any]]
        XCTAssertEqual(sessionStart.count, 1)
        let firstHookList = sessionStart[0]["hooks"] as! [[String: Any]]
        XCTAssertEqual(firstHookList.first?["command"] as? String, "my-custom-hook.sh")
    }

    func test_deletesFile_whenAllTermLoopOwned() throws {
        let settingsURL = tempDir.appendingPathComponent(".codex/hooks.json")
        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let contents: [String: Any] = [
            "hooks": [
                "Stop": [
                    [
                        "hooks": [
                            ["type": "command", "command": "termloop codex-hook stop"]
                        ]
                    ] as [String: Any]
                ]
            ]
        ]
        try JSONSerialization.data(withJSONObject: contents).write(to: settingsURL)

        ProjectScopeHookCleaner.cleanup(projectURL: tempDir, for: .codex)

        XCTAssertFalse(FileManager.default.fileExists(atPath: settingsURL.path))
    }

    func test_keepsFile_whenRootHasOtherKeys() throws {
        let settingsURL = tempDir.appendingPathComponent(".gemini/settings.json")
        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let contents: [String: Any] = [
            "theme": "dark",
            "hooks": [
                "SessionStart": [
                    [
                        "hooks": [
                            ["type": "command", "command": "termloop gemini-hook session-start"]
                        ]
                    ] as [String: Any]
                ]
            ]
        ]
        try JSONSerialization.data(withJSONObject: contents).write(to: settingsURL)

        ProjectScopeHookCleaner.cleanup(projectURL: tempDir, for: .gemini)

        XCTAssertTrue(FileManager.default.fileExists(atPath: settingsURL.path))
        let updated = try JSONSerialization.jsonObject(with: Data(contentsOf: settingsURL)) as! [String: Any]
        XCTAssertEqual(updated["theme"] as? String, "dark")
    }

    func test_detectsOwnedForms() {
        // Current stable marker.
        XCTAssertTrue(ProjectScopeHookCleaner.isTermLoopOwnedCommand(
            "termloop claude-hook session-start",
            agent: .claude
        ))
        XCTAssertTrue(ProjectScopeHookCleaner.isTermLoopOwnedCommand(
            "TERMLOOP_BIN=\"${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}\" ; exec $TERMLOOP_BIN gemini-hook stop",
            agent: .gemini
        ))
        XCTAssertFalse(ProjectScopeHookCleaner.isTermLoopOwnedCommand(
            "/usr/local/bin/my-tool --arg",
            agent: .claude
        ))
        XCTAssertFalse(ProjectScopeHookCleaner.isTermLoopOwnedCommand(
            "/usr/local/bin/my-codex-hook --arg",
            agent: .codex
        ))
        // Wrong agent — not owned.
        XCTAssertFalse(ProjectScopeHookCleaner.isTermLoopOwnedCommand(
            "termloop claude-hook session-start",
            agent: .codex
        ))
        XCTAssertFalse(ProjectScopeHookCleaner.isTermLoopOwnedCommand(
            "termloop codex-hook stop",
            agent: .claude
        ))
    }
}
