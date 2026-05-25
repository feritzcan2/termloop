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
                command.contains(ClaudeSettingsJSON.ownershipMarker),
                "Command missing stable ownership marker: \(command)"
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
            XCTAssertFalse(
                command.contains("exec "),
                "Hook command must not exec because failures need to fall back to '{}': \(command)"
            )
            XCTAssertTrue(
                command.contains(">/dev/null 2>/dev/null"),
                "Hook command must keep hook failures out of agent stderr/stdout: \(command)"
            )
        }
    }

    func test_hookTestRunner_treatsTermLoopInlineShellHooksAsShellWrapped() async {
        let command = ClaudeHookInstaller.requiredHooks["Stop"]
        let result = await HookTestRunner().run(IntegrationItem(
            id: "test",
            kind: .claudeHook,
            displayName: "Stop",
            summary: command ?? "",
            source: .userScope,
            status: .idle,
            lastTestedAt: nil,
            lastTestDurationMs: nil,
            capabilities: [],
            configRef: nil,
            attachedToActiveSpawn: false,
            binaryPath: nil,
            version: nil,
            authSubject: nil
        ))
        XCTAssertTrue(result.success, result.message)
        XCTAssertEqual(result.message, "shell-wrapped hook")
    }

    func test_requiredHooks_noDeprecatedBundlePaths() {
        for (_, command) in ClaudeHookInstaller.requiredHooks {
            XCTAssertFalse(
                command.contains("/TermLoopHooks/"),
                "Command still references deprecated bundle path: \(command)"
            )
            XCTAssertFalse(
                command.contains(".sh"),
                "Command still references .sh script: \(command)"
            )
            for token in ["c" + "mux", "agent" + "loop", "agent" + "mux"] {
                XCTAssertFalse(
                    command.localizedCaseInsensitiveContains(token),
                    "Command still references deprecated token \(token): \(command)"
                )
            }
        }
    }

    func test_requiredHooks_coversAllSixClaudeEvents() {
        let events = Set(ClaudeHookInstaller.requiredHooks.keys)
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
            let installerCommand = ClaudeHookInstaller.requiredHooks[event]
            XCTAssertNotNil(installerCommand, "Status expects event \(event) but installer does not write it")
            XCTAssertTrue(
                installerCommand?.contains(suffix) ?? false,
                "Status probe suffix '\(suffix)' not found in installer command for event \(event)"
            )
        }
    }

    func test_probeSuffixes_matchRequiredHooks() {
        for (event, suffix) in ClaudeHookInstaller.probeSuffixes {
            let matching = ClaudeHookInstaller.requiredHooks[event]
            XCTAssertNotNil(matching, "probeSuffixes event \(event) has no requiredHooks entry")
            XCTAssertTrue(
                matching?.contains(suffix) ?? false,
                "probeSuffixes suffix '\(suffix)' not found in requiredHooks command for \(event)"
            )
        }
    }

    func test_settingsTransform_healthyConfigProducesNoWrite() throws {
        let root: [String: Any] = [
            "permissions": ["allow": ["Read"]],
            "hooks": ClaudeSettingsJSON.requiredHooks.reduce(into: [String: Any]()) { result, pair in
                result[pair.key] = [
                    [
                        "matcher": "",
                        "hooks": [
                            ["type": "command", "command": pair.value]
                        ]
                    ] as [String: Any]
                ]
            }
        ]
        let content = try ClaudeSettingsJSON.serialize(root)
        let mutation = try ClaudeSettingsJSON.installTransform(content)
        XCTAssertFalse(mutation.changed)
        XCTAssertTrue(mutation.unsupportedEvents.isEmpty)
    }

    func test_settingsTransform_preservesUserHookInsideMixedGroup() throws {
        let staleCommand = "TERMLOOP_BIN=\"${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}\"; termloop claude-hook stop"
        let root: [String: Any] = [
            "hooks": [
                "Stop": [
                    [
                        "matcher": "Bash",
                        "hooks": [
                            ["type": "command", "command": staleCommand],
                            ["type": "command", "command": "user-hook.sh"]
                        ]
                    ] as [String: Any]
                ]
            ]
        ]
        let content = try ClaudeSettingsJSON.serialize(root)
        let mutation = try ClaudeSettingsJSON.installTransform(content)
        XCTAssertTrue(mutation.changed)
        XCTAssertEqual(mutation.repairedEvents, ["Stop"])

        let parsed = try ClaudeSettingsJSON.parseRoot(mutation.content)
        let hooks = parsed["hooks"] as! [String: Any]
        let stopGroups = hooks["Stop"] as! [[String: Any]]
        let userGroupHooks = stopGroups[0]["hooks"] as! [[String: Any]]
        XCTAssertEqual(userGroupHooks.map { $0["command"] as? String }, ["user-hook.sh"])
        XCTAssertTrue(stopGroups.contains { group in
            guard let nested = group["hooks"] as? [[String: Any]] else { return false }
            return nested.contains {
                ClaudeSettingsJSON.isCanonicalHookEntry(event: "Stop", entry: $0)
            }
        })
    }

    func test_settingsTransform_preservesUnsupportedHookEventShape() throws {
        let input = """
        {
          "hooks": {
            "Stop": "future-schema"
          },
          "model": "sonnet"
        }
        """

        let mutation = try ClaudeSettingsJSON.installTransform(input)
        XCTAssertTrue(mutation.unsupportedEvents.contains("Stop"))
        let parsed = try ClaudeSettingsJSON.parseRoot(mutation.content)
        let hooks = parsed["hooks"] as! [String: Any]
        XCTAssertEqual(hooks["Stop"] as? String, "future-schema")
        XCTAssertEqual(parsed["model"] as? String, "sonnet")
    }

    func test_claudeJSONMCPTransform_touchesOnlyActiveProject() throws {
        let termloopServer: [String: Any] = [
            "command": "/bin/sh",
            "args": [
                "-lc",
                "exec \"${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}\" termloop-mcp"
            ]
        ]
        let inputRoot: [String: Any] = [
            "projects": [
                "/active": [
                    "mcpServers": [
                        "termloop": termloopServer
                    ]
                ],
                "/other": [
                    "mcpServers": [
                        "termloop": [
                            "command": "keep",
                            "env": ["TERMLOOP_SOCKET_PATH": "/tmp/stale"]
                        ]
                    ]
                ]
            ]
        ]
        let input = try ClaudeJSONMCPInstaller.serialize(inputRoot)
        let healthy = try ClaudeJSONMCPInstaller.installTransform(
            input,
            workspaceCwd: "/active",
            mcpServers: ["termloop": termloopServer]
        )
        XCTAssertFalse(healthy.changed)

        let mutation = try ClaudeJSONMCPInstaller.installTransform(
            input,
            workspaceCwd: "/active",
            mcpServers: [
                "termloop": [
                    "command": "old",
                    "env": ["TERMLOOP_SOCKET_PATH": "/tmp/current"]
                ]
            ]
        )
        let parsed = try ClaudeJSONMCPInstaller.parseRoot(mutation.content)
        let projects = parsed["projects"] as! [String: Any]
        let other = projects["/other"] as! [String: Any]
        let otherServers = other["mcpServers"] as! [String: Any]
        let otherTermLoop = otherServers["termloop"] as! [String: Any]
        XCTAssertEqual(otherTermLoop["command"] as? String, "keep")
    }

    @MainActor
    func test_codexHookReviewOutputDetector_matchesCodexReviewWarning() {
        XCTAssertTrue(CodexHooksStatus.outputIndicatesReviewRequired(
            "4 hooks need review before they can run. Open /hooks to review them."
        ))
        XCTAssertFalse(CodexHooksStatus.outputIndicatesReviewRequired(
            "Codex is ready for the next task."
        ))
    }
}
