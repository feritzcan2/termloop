import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ClaudeHookInstallerCommandTests: XCTestCase {
    func test_requiredHooks_useBundledCLIResolver() {
        for (_, command) in ClaudeHookInstaller.requiredHooks {
            XCTAssertTrue(
                command.contains("${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}"),
                "Command does not use bundled-CLI fallback: \(command)"
            )
            XCTAssertTrue(
                command.contains("TERMLOOP_HOOKS_DISABLED"),
                "Command missing global disable guard: \(command)"
            )
            XCTAssertTrue(
                command.contains("TERMLOOP_CLAUDE_HOOKS_DISABLED"),
                "Command missing per-agent disable guard: \(command)"
            )
            XCTAssertTrue(
                command.contains("TERMLOOP_SURFACE_ID") || command.contains("TERMLOOP_WORKSPACE_ID"),
                "Command missing workspace/surface guard: \(command)"
            )
        }
    }

    func test_requiredHooks_noLegacyBundlePaths() {
        for (_, command) in ClaudeHookInstaller.requiredHooks {
            XCTAssertFalse(
                command.contains("/TermLoopHooks/"),
                "Command still references legacy bundle path: \(command)"
            )
            XCTAssertFalse(
                command.contains(".sh"),
                "Command still references .sh script: \(command)"
            )
        }
    }

    func test_requiredHooks_coversAllSixClaudeEvents() {
        let events = Set(ClaudeHookInstaller.requiredHooks.map(\.event))
        XCTAssertEqual(events, [
            "SessionStart",
            "PreToolUse",
            "UserPromptSubmit",
            "Stop",
            "SessionEnd",
            "Notification"
        ])
    }

    func test_statusProbeSuffixes_matchInstallerOutput() {
        for (event, suffix) in ClaudeHooksStatus.requiredHooks {
            let installerCommand = ClaudeHookInstaller.requiredHooks.first { $0.event == event }?.command
            XCTAssertNotNil(installerCommand, "Status expects event \(event) but installer does not write it")
            XCTAssertTrue(
                installerCommand?.contains(suffix) ?? false,
                "Status probe suffix '\(suffix)' not found in installer command for event \(event)"
            )
        }
    }

    func test_probeSuffixes_matchRequiredHooks() {
        for (event, suffix) in ClaudeHookInstaller.probeSuffixes {
            let matching = ClaudeHookInstaller.requiredHooks.first { $0.event == event }
            XCTAssertNotNil(matching, "probeSuffixes event \(event) has no requiredHooks entry")
            XCTAssertTrue(
                matching?.command.contains(suffix) ?? false,
                "probeSuffixes suffix '\(suffix)' not found in requiredHooks command for \(event)"
            )
        }
    }
}
