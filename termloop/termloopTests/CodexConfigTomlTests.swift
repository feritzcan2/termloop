import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

/// Tests for the marker-block management in TermLoopCodexHooks via the
/// pure `applyToTomlContentForTesting` transform shim.
final class CodexConfigTomlTests: XCTestCase {
    func test_stripsUnmarkedTermLoopSection_writesManagedBlock() throws {
        let input = """
        codex_hooks = true

        [mcp_servers.termloop]
        command = "/usr/local/bin/old-termloop"
        args = ["mcp"]

        [mcp_servers.other]
        command = "other"
        """
        let output = TermLoopCodexHooks.applyToTomlContentForTesting(input)
        XCTAssertTrue(output.contains("# TermLoop-managed: BEGIN"))
        XCTAssertTrue(output.contains("# TermLoop-managed: END"))
        XCTAssertFalse(output.contains("/usr/local/bin/old-termloop"),
                       "Unmarked termloop section must be stripped — no migration")
        XCTAssertTrue(output.contains("${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}"),
                      "Canonical managed block written")
        XCTAssertTrue(output.contains("[mcp_servers.other]"),
                      "Unrelated sections preserved")
    }

    func test_subsequentRun_rewritesManagedBlockOnly() throws {
        let input = """
        codex_hooks = true

        # TermLoop-managed: BEGIN
        [mcp_servers.termloop]
        command = "OLD"
        args = ["stale"]
        # TermLoop-managed: END

        [mcp_servers.user]
        command = "user"
        """
        let output = TermLoopCodexHooks.applyToTomlContentForTesting(input)
        XCTAssertFalse(output.contains("\"OLD\""))
        XCTAssertFalse(output.contains("stale"))
        XCTAssertTrue(output.contains("${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}"))
        XCTAssertTrue(output.contains("[mcp_servers.user]"),
                      "User section outside managed block preserved")
    }

    func test_emptyFile_addsFeatureFlagAndManagedBlock() throws {
        let output = TermLoopCodexHooks.applyToTomlContentForTesting("")
        XCTAssertTrue(output.contains("codex_hooks = true"))
        XCTAssertTrue(output.contains("# TermLoop-managed: BEGIN"))
        XCTAssertTrue(output.contains("[mcp_servers.termloop]"))
    }

    func test_idempotent_twoRunsProduceSameOutput() {
        let input = ""
        let once = TermLoopCodexHooks.applyToTomlContentForTesting(input)
        let twice = TermLoopCodexHooks.applyToTomlContentForTesting(once)
        XCTAssertEqual(once, twice)
    }
}
