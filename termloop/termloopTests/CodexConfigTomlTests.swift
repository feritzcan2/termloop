import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

/// Tests for TermLoop-owned Codex config transforms. Codex trust state and
/// user-owned TOML tables must remain outside TermLoop's mutation surface.
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

        let mutation = CodexConfigToml.installTransform(input)
        XCTAssertTrue(mutation.changed)
        XCTAssertTrue(mutation.content.contains("# TermLoop-managed: BEGIN"))
        XCTAssertTrue(mutation.content.contains("# TermLoop-managed: END"))
        XCTAssertFalse(mutation.content.contains("/usr/local/bin/old-termloop"))
        XCTAssertTrue(mutation.content.contains("${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}"))
        XCTAssertTrue(mutation.content.contains("[mcp_servers.other]"))
    }

    func test_healthyConfigProducesNoWrite() {
        let input = """
        codex_hooks = true

        \(CodexConfigToml.canonicalMCPBlock())
        [hooks.state]
        """

        let mutation = CodexConfigToml.installTransform(input)
        XCTAssertFalse(mutation.changed)
        XCTAssertEqual(mutation.content, input)
    }

    func test_emptyFile_addsFeatureFlagAndManagedBlock() throws {
        let mutation = CodexConfigToml.installTransform("")
        XCTAssertTrue(mutation.changed)
        XCTAssertTrue(mutation.content.contains("codex_hooks = true"))
        XCTAssertTrue(mutation.content.contains("# TermLoop-managed: BEGIN"))
        XCTAssertTrue(mutation.content.contains("[mcp_servers.termloop]"))
    }

    func test_idempotent_twoRunsProduceSameOutput() {
        let once = CodexConfigToml.installTransform("").content
        let twice = CodexConfigToml.installTransform(once)
        XCTAssertFalse(twice.changed)
        XCTAssertEqual(once, twice.content)
    }

    func test_rootCodexHooksFalseBecomesSingleRootTrue() {
        let input = """
        codex_hooks = false # user disabled before TermLoop launch

        [projects."/tmp/demo"]
        trust_level = "trusted"
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertEqual(output.components(separatedBy: "codex_hooks = true").count - 1, 1)
        XCTAssertFalse(output.contains("codex_hooks = false"))
        XCTAssertTrue(output.contains("[projects.\"/tmp/demo\"]"))
    }

    func test_nonRootCodexHooksDoesNotSatisfyRootInstall() {
        let input = """
        [features]
        codex_hooks = true
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertTrue(output.hasPrefix("codex_hooks = true\n\n"))
        XCTAssertTrue(output.contains("[features]\ncodex_hooks = true"))
    }

    func test_arrayTableStopsRootScope() {
        let input = """
        [[profiles]]
        codex_hooks = true
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertTrue(output.hasPrefix("codex_hooks = true\n\n"))
        XCTAssertTrue(output.contains("[[profiles]]\ncodex_hooks = true"))
    }

    func test_headersAllowIndentationAndTrailingCommentsButIgnoreCommentedHeaders() {
        let input = """
        codex_hooks = true

           [mcp_servers.termloop] # old managed table
        command = "OLD"

        # [mcp_servers.termloop]
        [mcp_servers.other]
        command = "other"
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertFalse(output.contains("command = \"OLD\""))
        XCTAssertTrue(output.contains("# [mcp_servers.termloop]"))
        XCTAssertTrue(output.contains("[mcp_servers.other]"))
    }

    func test_preservesSimilarAndQuotedMCPNames() {
        let input = """
        codex_hooks = true

        [mcp_servers.termloop-local]
        command = "local"

        [mcp_servers."termloop-other"]
        command = "other"
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertTrue(output.contains("[mcp_servers.termloop-local]"))
        XCTAssertTrue(output.contains("[mcp_servers.\"termloop-other\"]"))
        XCTAssertTrue(output.contains("[mcp_servers.termloop]"))
    }

    func test_quotedTermLoopMCPNameIsReplacedAsOwnedTable() {
        let input = """
        codex_hooks = true

        [mcp_servers."termloop"]
        command = "OLD"
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertFalse(output.contains("command = \"OLD\""))
        XCTAssertTrue(output.contains("[mcp_servers.termloop]"))
    }

    func test_arrayTableAfterTermLoopMCPIsPreserved() {
        let input = """
        codex_hooks = true

        [mcp_servers.termloop]
        command = "OLD"

        [[profiles]]
        name = "default"
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertFalse(output.contains("command = \"OLD\""))
        XCTAssertTrue(output.contains("[[profiles]]"))
        XCTAssertTrue(output.contains("name = \"default\""))
    }

    func test_termLoopMCPChildTablesAreRemovedAsOwnedSubtree() {
        let input = """
        codex_hooks = true

        [mcp_servers.termloop]
        command = "OLD"

        [mcp_servers.termloop.env]
        TERMLOOP_SOCKET_PATH = "/tmp/stale.sock"

        [mcp_servers.other]
        command = "other"
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertFalse(output.contains("[mcp_servers.termloop.env]"))
        XCTAssertFalse(output.contains("TERMLOOP_SOCKET_PATH"))
        XCTAssertTrue(output.contains("[mcp_servers.other]"))
    }

    func test_orphanTermLoopMCPChildTableIsRemovedAsOwnedSubtree() {
        let input = """
        codex_hooks = true

        [mcp_servers.termloop.env]
        TERMLOOP_SOCKET_PATH = "/tmp/stale.sock"

        [mcp_servers.other]
        command = "other"
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertFalse(output.contains("[mcp_servers.termloop.env]"))
        XCTAssertFalse(output.contains("TERMLOOP_SOCKET_PATH"))
        XCTAssertTrue(output.contains("[mcp_servers.termloop]"))
        XCTAssertTrue(output.contains("[mcp_servers.other]"))
    }

    func test_missingEndMarkerWithFollowingHookStatePreservesTrustText() throws {
        let trustText = """
        [hooks.state]

        [hooks.state."/Users/example/.codex/hooks.json:stop:0:0"]
        trusted_hash = "sha256:keep-me"
        """
        let input = """
        codex_hooks = true

        # TermLoop-managed: BEGIN
        [mcp_servers.termloop]
        command = "/bin/sh"
        args = ["-lc", "exec \\"${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}\\" termloop-mcp"]

        \(trustText)
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertTrue(output.contains(trustText))
        XCTAssertEqual(output.components(separatedBy: "trusted_hash").count - 1, 1)

        let managedEnd = try XCTUnwrap(output.range(of: "# TermLoop-managed: END")?.upperBound)
        let hookState = try XCTUnwrap(output.range(of: "[hooks.state]")?.lowerBound)
        XCTAssertLessThan(managedEnd, hookState)
    }

    func test_attachedEndMarkerIsSplitBeforeTrustTable() throws {
        let input = """
        codex_hooks = true

        # TermLoop-managed: BEGIN
        [mcp_servers.termloop]
        command = "/bin/sh"
        args = ["-lc", "exec \\"${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}\\" termloop-mcp"]
        # TermLoop-managed: END[hooks.state."/Users/example/.codex/hooks.json:permission_request:0:0"]
        trusted_hash = "sha256:keep-attached"
        """

        let output = CodexConfigToml.installTransform(input).content
        XCTAssertTrue(output.contains("[hooks.state.\"/Users/example/.codex/hooks.json:permission_request:0:0\"]"))
        XCTAssertTrue(output.contains("trusted_hash = \"sha256:keep-attached\""))

        let managedEnd = try XCTUnwrap(output.range(of: "# TermLoop-managed: END")?.upperBound)
        let hookState = try XCTUnwrap(output.range(of: "[hooks.state.")?.lowerBound)
        XCTAssertLessThan(managedEnd, hookState)
    }

    func test_trustTablesRemainByteIdenticalAfterRefresh() {
        let trustText = """
        [hooks.state]

        [hooks.state."/Users/example/.codex/hooks.json:permission_request:0:0"]
        trusted_hash = "sha256:one"

        [hooks.state."/Users/example/.codex/hooks.json:stop:0:0"]
        trusted_hash = "sha256:two"
        """
        let input = """
        codex_hooks = true

        \(CodexConfigToml.canonicalMCPBlock())
        \(trustText)
        """

        let mutation = CodexConfigToml.installTransform(input)
        XCTAssertFalse(mutation.changed)
        XCTAssertTrue(mutation.content.contains(trustText))
        XCTAssertEqual(mutation.content.components(separatedBy: "[hooks.state").count - 1, 3)
        XCTAssertEqual(mutation.content.components(separatedBy: "trusted_hash").count - 1, 2)
    }

    func test_uninstallRemovesOnlyTermLoopMCPAndLeavesCodexHooksFlag() {
        let input = """
        codex_hooks = true

        \(CodexConfigToml.canonicalMCPBlock())
        [mcp_servers.other]
        command = "other"
        """

        let output = CodexConfigToml.uninstallTransform(input).content
        XCTAssertTrue(output.contains("codex_hooks = true"))
        XCTAssertFalse(output.contains("[mcp_servers.termloop]"))
        XCTAssertTrue(output.contains("[mcp_servers.other]"))
    }
}
