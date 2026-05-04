// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum TermLoopBuiltInMCP {
    static let serverName = "termloop"
    static let askToToolName = "ask_to"
    static let replyToRequestToolName = "reply_to_request"

    /// Tool names that other modules need to spell. Keep them as named
    /// constants so refactors and grep stay aligned across the runner, the
    /// auto-include rules, and the in-app tool registration. The CLI's
    /// `TermLoopMCPServer` owns its own copy because the CLI target does
    /// not link app sources.
    static let setJiraTicketToolName = "set_jira_ticket"
    static let getJiraTicketToolName = "get_jira_ticket"
    /// Owning ability for the Jira ticket binding. Used by the runner to
    /// auto-include the Jira ticket tools whenever the jira ability is active.
    static let jiraAbilityId = "working-with-jira"

    static let setRunTargetsToolName = "set_run_targets"
    static let getRunTargetsToolName = "get_run_targets"
    /// Owning ability for the Run Targets bindings. Used by the runner to
    /// auto-include the run-target tools whenever the running-your-application
    /// ability is active.
    static let runningYourApplicationAbilityId = "running-your-application"

    static func item() -> IntegrationItem {
        IntegrationItem(
            id: IntegrationItem.makeId(kind: .mcp, name: serverName),
            kind: .mcp,
            displayName: serverName,
            summary: "stdio · termloop termloop-mcp",
            source: .termLoop,
            status: .idle,
            lastTestedAt: nil,
            lastTestDurationMs: nil,
            capabilities: [
                "ask_to",
                "reply_to_request",
                "set_jira_ticket",
                "get_jira_ticket",
                "set_run_targets",
                "get_run_targets",
                "context_bank_propose_suggestion",
                "context_bank_finalize_run",
            ],
            configRef: nil,
            attachedToActiveSpawn: true,
            binaryPath: "termloop",
            version: nil,
            authSubject: nil
        )
    }

    static func configEntry(
        workspaceId: String? = nil,
        launchEnvironment: [String: String] = [:]
    ) -> [String: Any] {
        let socketPath = SocketControlSettings.socketPath()
        let bundledCLIPath = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/bin/termloop", isDirectory: false)
            .path
        var env: [String: String] = [
            "TERMLOOP_SOCKET_PATH": socketPath,
            "TERMLOOP_SOCKET": socketPath,
            "TERMLOOP_BUNDLED_CLI_PATH": bundledCLIPath
        ]
        for key in ["TERMLOOP_ASK_TO_REQUEST_ID", "TERMLOOP_ASK_TO_REPLY_TOKEN"] {
            if let value = launchEnvironment[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty {
                env[key] = value
            }
        }
        if let workspaceId = workspaceId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !workspaceId.isEmpty {
            env["TERMLOOP_WORKSPACE_ID"] = workspaceId
        }

        let entry: [String: Any] = [
            "command": "/bin/sh",
            "args": [
                "-lc",
                "exec \"${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}\" termloop-mcp"
            ],
            "env": env
        ]
        return entry
    }
}

/// App-side mirror of the CLI's `TermLoopMCPServer.builtInTools` registry.
/// Used by the abilities UI to show what an agent actually sees in
/// `tools/list` for a given built-in tool.
///
/// CLI and app live in separate Xcode targets and cannot share Swift types,
/// so this is duplicated by design. The CLI is the runtime source of truth;
/// when adding or editing a tool, update both files in the same commit.
/// Mirror lives at `termloop/CLI/TermLoop/TermLoopMCPServer.swift`.
struct TermLoopBuiltInToolMeta {
    let name: String
    let description: String
    let inputSchemaJSON: String
    /// `true` → tool is always in `tools/list` regardless of ability state.
    let alwaysOn: Bool

    static func meta(for name: String) -> TermLoopBuiltInToolMeta? {
        all.first(where: { $0.name == name })
    }

    static let all: [TermLoopBuiltInToolMeta] = [
        TermLoopBuiltInToolMeta(
            name: TermLoopBuiltInMCP.askToToolName,
            description: "MCP Ask-To / bridge.ask_to: ask, consult, or hand off to a helper agent (codex / claude / gemini). Use this when the user says to ask Claude/Codex/Gemini, consult another agent, review with another agent, use Ask-To, use ask_to, or says Turkish phrases like \"MCP ile Claude'a sor\" / \"Claude'a danış\". Returns a single-use request_id plus a reusable conversation_id/bridge_id for follow-ups to the same helper.",
            inputSchemaJSON: """
            {
              "type": "object",
              "properties": {
                "target": {
                  "type": "string",
                  "enum": ["codex", "claude", "gemini"]
                },
                "message": {
                  "type": "string"
                },
                "target_prompt": {
                  "type": "string"
                },
                "conversation_id": {
                  "type": "string",
                  "description": "Optional bridge_id/conversation_id returned by a prior ask_to. Reuses the same helper and creates a fresh request_id."
                },
                "bridge_id": {
                  "type": "string",
                  "description": "Alias for conversation_id."
                }
              },
              "required": ["message"]
            }
            """,
            alwaysOn: true
        ),
        TermLoopBuiltInToolMeta(
            name: TermLoopBuiltInMCP.replyToRequestToolName,
            description: "Deliver the final answer for a TermLoop ask_to request. Call exactly once, only after all investigation/work for that request is complete.",
            inputSchemaJSON: """
            {
              "type": "object",
              "properties": {
                "request_id": {
                  "type": "string"
                },
                "message": {
                  "type": "string"
                }
              },
              "required": ["request_id", "message"]
            }
            """,
            alwaysOn: true
        ),
        TermLoopBuiltInToolMeta(
            name: TermLoopBuiltInMCP.getJiraTicketToolName,
            description: "Read the Jira ticket previously set for this workspace via set_jira_ticket. Returns `set: false` when no ticket is bound. Use this instead of guessing from the branch name when picking up an in-progress workspace.",
            inputSchemaJSON: """
            {
              "type": "object",
              "properties": {},
              "additionalProperties": false
            }
            """,
            alwaysOn: false
        ),
        TermLoopBuiltInToolMeta(
            name: TermLoopBuiltInMCP.setJiraTicketToolName,
            description: "Tell TermLoop which Jira ticket the current workspace is working on. PURE TELEMETRY — does NOT touch Jira. Updates the sidebar chip and the per-workspace ticket binding. Call when the active ticket changes OR when its status/url changes (e.g. after a transition from In Progress to In Review or Done). Skip duplicate calls when nothing changed.",
            inputSchemaJSON: """
            {
              "type": "object",
              "properties": {
                "key": {
                  "type": "string",
                  "description": "Jira issue key (e.g. \\"PROJ-123\\"). Required."
                },
                "status": {
                  "type": "string",
                  "description": "Optional Jira status (e.g. \\"In Progress\\", \\"In Review\\") appended after \\" · \\" in the chip."
                },
                "url": {
                  "type": "string",
                  "description": "Optional Jira browse URL so the chip becomes a link."
                }
              },
              "required": ["key"]
            }
            """,
            alwaysOn: false
        ),
        TermLoopBuiltInToolMeta(
            name: TermLoopBuiltInMCP.getRunTargetsToolName,
            description: "Read the current run targets bound to this workspace via set_run_targets. Returns the array as it appears in the sidebar chip. Use on workspace resume so you don't re-derive run state from scratch.",
            inputSchemaJSON: """
            {
              "type": "object",
              "properties": {},
              "additionalProperties": false
            }
            """,
            alwaysOn: false
        ),
        TermLoopBuiltInToolMeta(
            name: TermLoopBuiltInMCP.setRunTargetsToolName,
            description: "Tell TermLoop what's running for this workspace right now (dev server URL, app bundle path, dashboard, log file). PURE TELEMETRY — does NOT start or stop anything. FULL REPLACE: send the complete set on every call; anything dropped from the array disappears from the sidebar chip. Each entry is one chip row in the worktree's Running popover. Call after starting/stopping the app or when status changes; skip duplicate calls when nothing changed.",
            inputSchemaJSON: """
            {
              "type": "object",
              "properties": {
                "targets": {
                  "type": "array",
                  "description": "All currently relevant run targets. Empty array clears the chip.",
                  "items": {
                    "type": "object",
                    "properties": {
                      "label": {
                        "type": "string",
                        "description": "Short display name for the chip row (e.g. \\"Aspire dashboard\\", \\"AdminUi\\", \\"App\\"). Used as stable identity across calls."
                      },
                      "url": {
                        "type": "string",
                        "description": "Optional http(s) or file:// URL the row should open when clicked."
                      },
                      "path": {
                        "type": "string",
                        "description": "Optional filesystem path. Converted to file:// for the row's link. Use for app bundles, log files."
                      },
                      "status": {
                        "type": "string",
                        "description": "Optional status string. Recommended values: \\"running\\" (green), \\"stopped\\" (gray), \\"error\\" (red)."
                      }
                    },
                    "required": ["label"]
                  }
                }
              },
              "required": ["targets"]
            }
            """,
            alwaysOn: false
        )
    ]
}
