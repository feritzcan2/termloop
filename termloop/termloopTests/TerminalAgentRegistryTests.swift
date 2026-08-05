import XCTest
import Foundation

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TerminalAgentRegistryTests: XCTestCase {
    private let testWorkspaceId = UUID(uuidString: "00000000-0000-0000-0000-00000000C0DE")!

    private func embeddedShellScriptPath(in command: String) throws -> String {
        let pattern = try NSRegularExpression(pattern: #"sh '([^']+)'"#)
        let searchRange = NSRange(command.startIndex..., in: command)
        let match = try XCTUnwrap(pattern.firstMatch(in: command, range: searchRange))
        let pathRange = try XCTUnwrap(Range(match.range(at: 1), in: command))
        return String(command[pathRange])
    }

    private func assertCommand(
        _ command: String,
        invokesExecutableNamed executableName: String,
        containsAll fragments: [String],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(command.contains(executableName), command, file: file, line: line)
        for fragment in fragments {
            XCTAssertTrue(command.contains(fragment), command, file: file, line: line)
        }
    }

    private func repoResourceURL(path: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(path)
    }

    func testBuiltInsPresent() {
        let reg = TerminalAgentRegistry.shared
        XCTAssertNotNil(reg.agent(id: "claude"))
        XCTAssertNotNil(reg.agent(id: "codex"))
        XCTAssertNotNil(reg.agent(id: "gemini"))
        XCTAssertNotNil(reg.agent(id: "opencode"))
        XCTAssertNil(reg.agent(id: "aider"))
    }

    func testClaudeAndCodexBuiltInsDefaultToDangerousMode() {
        let reg = TerminalAgentRegistry.shared
        XCTAssertEqual(
            reg.agent(id: "claude")?.commandLine(),
            "claude --dangerously-skip-permissions"
        )
        XCTAssertEqual(
            reg.agent(id: "codex")?.commandLine(),
            "codex --dangerously-bypass-approvals-and-sandbox"
        )
    }

    func testDefaultLaunchCommandWrapsCwdAndEnvironment() throws {
        let reg = TerminalAgentRegistry.shared
        let codex = try XCTUnwrap(reg.agent(id: "codex"))

        let command = TerminalAgentRunner.defaultLaunchCommand(
            for: codex,
            cwd: "/tmp/my repo",
            env: [
                "B_VAR": "two words",
                "A_VAR": "alpha"
            ],
            workspaceId: testWorkspaceId
        )

        XCTAssertTrue(
            command.hasPrefix("cd '/tmp/my repo' && A_VAR='alpha' B_VAR='two words' "),
            command
        )
        let scriptPath = try embeddedShellScriptPath(in: command)
        let script = try String(contentsOfFile: scriptPath, encoding: .utf8)
        assertCommand(
            script,
            invokesExecutableNamed: "codex",
            containsAll: ["--dangerously-bypass-approvals-and-sandbox"]
        )
    }

    func testDefaultLaunchCommandFallsBackToBareAgentCommandForUnwrappedAgent() throws {
        let reg = TerminalAgentRegistry.shared
        let gemini = try XCTUnwrap(reg.agent(id: "gemini"))

        let command = TerminalAgentRunner.defaultLaunchCommand(
            for: gemini,
            cwd: nil,
            workspaceId: testWorkspaceId
        )

        assertCommand(
            command,
            invokesExecutableNamed: "gemini",
            containsAll: []
        )
    }

    func testDefaultLaunchCommandSynthesizesCodexReadyWhenWorkspaceIdExists() throws {
        let reg = TerminalAgentRegistry.shared
        let codex = try XCTUnwrap(reg.agent(id: "codex"))
        let workspaceId = testWorkspaceId.uuidString

        let command = TerminalAgentRunner.defaultLaunchCommand(
            for: codex,
            cwd: nil,
            env: ["TERMLOOP_WORKSPACE_ID": "stale-ws"],
            workspaceId: testWorkspaceId
        )

        XCTAssertTrue(command.contains("TERMLOOP_CODEX_READY_MARKER="))
        XCTAssertTrue(command.contains("TERMLOOP_WORKSPACE_ID='\(workspaceId)'"))
        XCTAssertFalse(command.contains("TERMLOOP_WORKSPACE_ID='stale-ws'"))
        XCTAssertTrue(command.contains("sh "))
        XCTAssertTrue(command.contains("termloop-codex-launch"))

        let scriptPath = try embeddedShellScriptPath(in: command)
        let script = try String(contentsOfFile: scriptPath, encoding: .utf8)
        XCTAssertTrue(script.contains("workspace.report_agent_activity"))
        XCTAssertTrue(script.contains("\"workspace_id\":\"\(workspaceId)\""))
        XCTAssertTrue(script.contains("\"phase\":\"ready\""))
        XCTAssertTrue(script.contains("def fresh_lifecycle_activity(path):"))
        XCTAssertTrue(script.contains("def fresh_activity_payload(session_id, session_cwd, activity):"))
        XCTAssertTrue(script.contains("payload[\"phase\"] = \"running\""))
        XCTAssertTrue(script.contains("payload[\"attention_kind\"] = \"completion\""))
        XCTAssertTrue(script.contains("workspace.clear_agent_activity"))
        XCTAssertTrue(script.contains("TERMLOOP_SHELL_INTEGRATION_DIR"))
        XCTAssertTrue(script.contains("cmux_termloop_bundle_bin"))
        XCTAssertTrue(script.contains("export PATH"))
        assertCommand(
            script,
            invokesExecutableNamed: "codex",
            containsAll: ["--dangerously-bypass-approvals-and-sandbox"]
        )
        XCTAssertTrue(script.contains("\"message_preview\":\"Codex launch failed\""))
    }

    func testCodexLaunchScriptRestoresBundledWrapperPathBeforeRunningCodex() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("termloop-codex-launch-\(UUID().uuidString)")
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: root) }

        let bundleResources = root
            .appendingPathComponent("bundle")
            .appendingPathComponent("Resources", isDirectory: true)
        let shellIntegrationDir = bundleResources
            .appendingPathComponent("shell-integration", isDirectory: true)
        let binDir = bundleResources.appendingPathComponent("bin", isDirectory: true)
        try fileManager.createDirectory(at: shellIntegrationDir, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: binDir, withIntermediateDirectories: true)
        try fileManager.copyItem(
            at: repoResourceURL(path: "Resources/bin/codex"),
            to: binDir.appendingPathComponent("codex")
        )

        let fakeCodex = root.appendingPathComponent("real-codex")
        try """
        #!/bin/sh
        printf '%s\\n' "resolved:$*"
        """.write(to: fakeCodex, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: fakeCodex.path
        )

        let codex = try XCTUnwrap(TerminalAgentRegistry.shared.agent(id: "codex"))
        let command = TerminalAgentRunner.defaultLaunchCommand(
            for: codex,
            cwd: nil,
            env: ["TERMLOOP_WORKSPACE_ID": testWorkspaceId.uuidString],
            workspaceId: testWorkspaceId
        )
        let scriptPath = try embeddedShellScriptPath(in: command)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [scriptPath]
        process.environment = [
            "HOME": root.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "TERMLOOP_SHELL_INTEGRATION_DIR": shellIntegrationDir.path,
            "TERMLOOP_REAL_CODEX_PATH": fakeCodex.path,
            "TERMLOOP_CODEX_READY_MARKER": root.appendingPathComponent("ready.flag").path,
            "TERMLOOP_WORKSPACE_ID": testWorkspaceId.uuidString,
        ]

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        try process.run()
        process.waitUntilExit()

        let output = String(
            data: stdout.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        let error = String(
            data: stderr.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""

        XCTAssertEqual(process.terminationStatus, 0, error)
        XCTAssertEqual(
            output.trimmingCharacters(in: .whitespacesAndNewlines),
            "resolved:--dangerously-bypass-approvals-and-sandbox"
        )
        XCTAssertEqual(error.trimmingCharacters(in: .whitespacesAndNewlines), "")
    }

    func testRestoreLaunchCommandResumesCodexSessionWhenAvailable() throws {
        let reg = TerminalAgentRegistry.shared
        let codex = try XCTUnwrap(reg.agent(id: "codex"))
        let workspaceId = testWorkspaceId.uuidString
        WorkspaceMetadataStore.shared.setTerminalAgentModel(.gpt56Terra, for: testWorkspaceId)
        defer {
            WorkspaceMetadataStore.shared.setTerminalAgentModel(nil, for: testWorkspaceId)
        }
        let command = TerminalAgentRunner.restoreLaunchCommand(
            for: codex,
            cwd: "/tmp/fallback",
            env: ["TERMLOOP_WORKSPACE_ID": "stale-ws"],
            workspaceId: testWorkspaceId,
            persistedSession: .init(
                agentId: "codex",
                sessionId: "sess-123",
                cwd: "/tmp/resume-dir",
                updatedAt: nil
            )
        )

        XCTAssertTrue(command.hasPrefix("cd '/tmp/fallback' && "))
        let scriptPath = try embeddedShellScriptPath(in: command)
        let script = try String(contentsOfFile: scriptPath, encoding: .utf8)
        XCTAssertTrue(command.contains("TERMLOOP_WORKSPACE_ID='\(workspaceId)'"))
        XCTAssertFalse(command.contains("TERMLOOP_WORKSPACE_ID='stale-ws'"))
        XCTAssertTrue(script.contains("TERMLOOP_TERMLOOP_WORKSPACE_ID=\"\(workspaceId)\""))
        assertCommand(
            script,
            invokesExecutableNamed: "codex",
            containsAll: [
                "resume",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5.6-terra",
                "sess-123",
            ]
        )
        XCTAssertTrue(script.contains("\"message_preview\":\"Codex resume failed\""))
        XCTAssertFalse(script.contains("\"phase\":\"ready\""))
    }

    func testNativeForkLaunchCommandUsesClaudeForkSession() throws {
        let claude = try XCTUnwrap(TerminalAgentRegistry.shared.agent(id: "claude"))

        let command = try TerminalAgentRunner.nativeForkLaunchCommand(
            for: claude,
            parentSessionId: "claude-session-123",
            initialPrompt: "Continue from here",
            cwd: "/tmp/forked",
            permission: .bypassPermissions,
            systemPrompt: nil
        )

        assertCommand(
            command,
            invokesExecutableNamed: "claude",
            containsAll: ["--resume", "claude-session-123", "--fork-session", "--dangerously-skip-permissions"]
        )
        XCTAssertTrue(command.contains("'Continue from here'"), command)
    }

    func testNativeForkLaunchCommandUsesCodexForkSubcommand() throws {
        let codex = try XCTUnwrap(TerminalAgentRegistry.shared.agent(id: "codex"))

        let command = try TerminalAgentRunner.nativeForkLaunchCommand(
            for: codex,
            parentSessionId: "codex-session-123",
            initialPrompt: "Continue from here",
            cwd: "/tmp/forked worktree",
            permission: .bypassPermissions,
            systemPrompt: nil
        )

        assertCommand(
            command,
            invokesExecutableNamed: "codex",
            containsAll: [
                "fork",
                "--dangerously-bypass-approvals-and-sandbox",
                "--cd",
                "'/tmp/forked worktree'",
                "codex-session-123"
            ]
        )
        XCTAssertTrue(command.contains("'Continue from here'"), command)
    }

    func testUnknownIdReturnsNil() {
        XCTAssertNil(TerminalAgentRegistry.shared.agent(id: "bogus-xyz"))
    }
}
