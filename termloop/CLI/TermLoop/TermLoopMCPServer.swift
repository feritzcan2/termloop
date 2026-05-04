// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import Darwin

enum TermLoopMCPServer {
    private static let supportedProtocolVersions = [
        "2025-03-26",
        "2024-11-05",
    ]
    /// Comma-separated names of optional built-in tools the active project's
    /// abilities have opted into. Optional tools (set_jira_ticket, ...) are
    /// only surfaced when listed.
    private static let enabledToolsEnvKey = "TERMLOOP_ENABLED_MCP_TOOLS"

    /// CLI-side copy of the Jira ticket reporter tool name. The app side keeps
    /// a matching `TermLoopBuiltInMCP.setJiraTicketToolName`; the two cannot
    /// share a constant because the CLI target does not link app sources.
    private static let setJiraTicketToolName = "set_jira_ticket"
    private static let getJiraTicketToolName = "get_jira_ticket"
    private static let jiraAbilityId = "working-with-jira"
    private static let jiraBindingId = "ticket"
    private static let askToToolName = "ask_to"
    private static let replyToRequestToolName = "reply_to_request"
    private static let contextBankProposeToolName = "context_bank_propose_suggestion"
    private static let contextBankFinalizeToolName = "context_bank_finalize_run"

    /// CLI-side mirror of the Run Targets tool names. App side keeps its own
    /// copy in `TermLoopBuiltInMCP`; the two cannot share a constant because
    /// the CLI target does not link app sources.
    private static let setRunTargetsToolName = "set_run_targets"
    private static let getRunTargetsToolName = "get_run_targets"
    private static let runningYourApplicationAbilityId = "running-your-application"

    /// Built-in tool descriptor — name, description, JSON schema (as
    /// JSONSerialization-ready dictionary), and a handler closure that runs in
    /// the MCP server process.
    private struct BuiltInTool {
        let name: String
        let description: String
        let inputSchema: [String: Any]
        /// `true` → always present in tools/list, regardless of ability state.
        /// `false` → only present when ability opts in via env var.
        let alwaysOn: Bool
        let handler: (
            _ id: Any,
            _ arguments: [String: Any],
            _ processEnv: [String: String],
            _ socketPath: String
        ) -> [String: Any]
    }

    /// Single source of truth for TermLoop's built-in MCP tools. Add new
    /// entries here; ability bundles only need to opt-in by listing the name.
    private static let builtInTools: [BuiltInTool] = [
        BuiltInTool(
            name: setJiraTicketToolName,
            description: "Tell TermLoop which Jira ticket the current workspace is working on. PURE TELEMETRY — does NOT touch Jira. Updates the sidebar chip and the per-workspace ticket binding. Call when the active ticket changes OR when its status/url changes (e.g. after a transition from In Progress to In Review or Done). Skip duplicate calls when nothing changed.",
            inputSchema: [
                "type": "object",
                "properties": [
                    "key": [
                        "type": "string",
                        "description": "Jira issue key (e.g. \"PROJ-123\"). Required."
                    ],
                    "status": [
                        "type": "string",
                        "description": "Optional Jira status (e.g. \"In Progress\", \"In Review\") appended after \" · \" in the chip."
                    ],
                    "url": [
                        "type": "string",
                        "description": "Optional Jira browse URL so the chip becomes a link."
                    ]
                ],
                "required": ["key"]
            ],
            alwaysOn: false,
            handler: runSetJiraTicket
        ),
        BuiltInTool(
            name: getJiraTicketToolName,
            description: "Read the Jira ticket previously set for this workspace via set_jira_ticket. Returns `set: false` when no ticket is bound. Use this instead of guessing from the branch name when picking up an in-progress workspace.",
            inputSchema: [
                "type": "object",
                "properties": [:],
                "additionalProperties": false
            ],
            alwaysOn: false,
            handler: runGetJiraTicket
        ),
        BuiltInTool(
            name: setRunTargetsToolName,
            description: "Tell TermLoop what's running for this workspace right now (dev server URL, app bundle path, dashboard, log file). PURE TELEMETRY — does NOT start or stop anything. FULL REPLACE: send the complete set on every call; anything dropped from the array disappears from the sidebar chip. Each entry is one chip row in the worktree's Running popover. Call after starting/stopping the app or when status changes; skip duplicate calls when nothing changed.",
            inputSchema: [
                "type": "object",
                "properties": [
                    "targets": [
                        "type": "array",
                        "description": "All currently relevant run targets. Empty array clears the chip.",
                        "items": [
                            "type": "object",
                            "properties": [
                                "label": [
                                    "type": "string",
                                    "description": "Short display name for the chip row (e.g. \"Aspire dashboard\", \"AdminUi\", \"App\"). Used as stable identity across calls."
                                ],
                                "url": [
                                    "type": "string",
                                    "description": "Optional http(s) or file:// URL the row should open when clicked."
                                ],
                                "path": [
                                    "type": "string",
                                    "description": "Optional filesystem path. Converted to file:// for the row's link. Use for app bundles, log files."
                                ],
                                "status": [
                                    "type": "string",
                                    "description": "Optional status string. Recommended values: \"running\" (green), \"stopped\" (gray), \"error\" (red)."
                                ]
                            ],
                            "required": ["label"]
                        ]
                    ]
                ],
                "required": ["targets"]
            ],
            alwaysOn: false,
            handler: runSetRunTargets
        ),
        BuiltInTool(
            name: getRunTargetsToolName,
            description: "Read the current run targets bound to this workspace via set_run_targets. Returns the array as it appears in the sidebar chip. Use on workspace resume so you don't re-derive run state from scratch.",
            inputSchema: [
                "type": "object",
                "properties": [:],
                "additionalProperties": false
            ],
            alwaysOn: false,
            handler: runGetRunTargets
        ),
        BuiltInTool(
            name: askToToolName,
            description: "MCP Ask-To / bridge.ask_to: ask, consult, or hand off to a helper agent (codex / claude / gemini). Use this when the user says to ask Claude/Codex/Gemini, consult another agent, review with another agent, use Ask-To, use ask_to, or says Turkish phrases like \"MCP ile Claude'a sor\" / \"Claude'a danış\". Returns a single-use request_id plus a reusable conversation_id/bridge_id for follow-ups to the same helper.",
            inputSchema: [
                "type": "object",
                "properties": [
                    "target": [
                        "type": "string",
                        "enum": ["codex", "claude", "gemini"],
                        "description": "Which agent should answer. Required for a new conversation; optional when conversation_id is supplied."
                    ],
                    "message": [
                        "type": "string",
                        "description": "The question / handoff verbatim. Sent as the helper's first user turn."
                    ],
                    "target_prompt": [
                        "type": "string",
                        "description": "Optional system-prompt override for the helper (extra persona / scope guidance). Empty for default."
                    ],
                    "conversation_id": [
                        "type": "string",
                        "description": "Optional bridge_id/conversation_id returned by a prior ask_to. Reuses the same helper and creates a fresh request_id."
                    ],
                    "bridge_id": [
                        "type": "string",
                        "description": "Alias for conversation_id."
                    ]
                ],
                "required": ["message"]
            ],
            alwaysOn: true,
            handler: runAskTo
        ),
        BuiltInTool(
            name: replyToRequestToolName,
            description: "Deliver the final answer for a TermLoop ask_to request. Call exactly once, only after all investigation/work for that request is complete; do not use for interim status updates.",
            inputSchema: [
                "type": "object",
                "properties": [
                    "request_id": [
                        "type": "string",
                        "description": "The request_id returned by ask_to. This is single-use."
                    ],
                    "message": [
                        "type": "string",
                        "description": "The final report or completed result to send back to the source agent."
                    ]
                ],
                "required": ["request_id", "message"]
            ],
            alwaysOn: true,
            handler: runReplyToRequest
        ),
        BuiltInTool(
            name: contextBankProposeToolName,
            description: "Propose a single Context Bank suggestion. Call once per suggestion you want the user to review. The applier writes the same `add_text` to `target_path` plus every path in `mirror_paths` (only for `add`).",
            inputSchema: [
                "type": "object",
                "properties": [
                    "action": [
                        "type": "string",
                        "enum": ["add", "replace", "move"],
                        "description": "Mutation kind. `add` appends text; `replace` swaps a verbatim block; `move` migrates a block from one file to another."
                    ],
                    "target_path": [
                        "type": "string",
                        "description": "Absolute path of the primary destination file."
                    ],
                    "mirror_paths": [
                        "type": "array",
                        "items": ["type": "string"],
                        "description": "Additional absolute paths that should receive the identical `add_text` (only for `add`). Use when CLAUDE/AGENTS/GEMINI siblings are kept in lockstep — but verify with Read before grouping."
                    ],
                    "from_path": [
                        "type": "string",
                        "description": "Absolute source path for `move`."
                    ],
                    "add_text": [
                        "type": "string",
                        "description": "Markdown text to insert. Required for `add` and `replace`."
                    ],
                    "replace_old_text": [
                        "type": "string",
                        "description": "Verbatim text of the entry being replaced (required for `replace`)."
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Why this matters and why this path. Shown to the user on the suggestion card."
                    ],
                    "source_quote": [
                        "type": "string",
                        "description": "Short excerpt from the analyzed session that motivated this suggestion."
                    ],
                    "confidence": [
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                        "description": "Calibrated 0–1 confidence in the suggestion."
                    ]
                ],
                "required": ["action", "target_path", "reasoning", "confidence"]
            ],
            alwaysOn: true,
            handler: runContextBankPropose
        ),
        BuiltInTool(
            name: contextBankFinalizeToolName,
            description: "Signal the Context Bank analysis is complete. Call exactly once after all `context_bank_propose_suggestion` calls (including zero — calling this with no prior proposals is the correct way to say 'nothing worth recording').",
            inputSchema: [
                "type": "object",
                "properties": [
                    "summary": [
                        "type": "string",
                        "description": "Optional one-line summary of what was decided. Visible in the analyze run history."
                    ]
                ]
            ],
            alwaysOn: true,
            handler: runContextBankFinalize
        )
    ]

    static func run(processEnv: [String: String], socketPath: String) throws {
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            let payloads = parseMessages(from: trimmed)
            for payload in payloads {
                if let response = handle(
                    payload,
                    processEnv: processEnv,
                    socketPath: socketPath
                ) {
                    try write(response: response)
                }
            }
        }
    }

    private static func parseMessages(from line: String) -> [[String: Any]] {
        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) else {
            return []
        }
        if let one = json as? [String: Any] {
            return [one]
        }
        if let many = json as? [[String: Any]] {
            return many
        }
        return []
    }

    private static func handle(
        _ message: [String: Any],
        processEnv: [String: String],
        socketPath: String
    ) -> [String: Any]? {
        let method = message["method"] as? String
        let id = message["id"]
        let params = message["params"] as? [String: Any] ?? [:]

        switch method {
        case "initialize":
            let requestedVersion = (params["protocolVersion"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let negotiatedVersion = requestedVersion
                .flatMap { supportedProtocolVersions.contains($0) ? $0 : nil }
                ?? supportedProtocolVersions[0]
            return result(
                id: id,
                body: [
                    "protocolVersion": negotiatedVersion,
                    "capabilities": [
                        "tools": [
                            "listChanged": false
                        ]
                    ],
                    "serverInfo": [
                        "name": "TermLoop MCP",
                        "version": "1.0.0"
                    ]
                ]
            )
        case "notifications/initialized":
            return nil
        case "ping":
            return result(id: id, body: [:])
        case "tools/list":
            let enabled = enabledToolNameSet(env: processEnv)
            let visible = builtInTools.filter { tool in
                tool.alwaysOn || enabled.contains(tool.name)
            }
            let toolList: [[String: Any]] = visible.map { tool in
                [
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.inputSchema
                ]
            }
            return result(id: id, body: ["tools": toolList])
        case "tools/call":
            guard let id else {
                return error(
                    id: nil,
                    code: -32600,
                    message: "tools/call requires id"
                )
            }
            let requestedTool = (params["name"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let enabled = enabledToolNameSet(env: processEnv)
            guard let tool = builtInTools.first(where: { $0.name == requestedTool }),
                  tool.alwaysOn || enabled.contains(tool.name) else {
                return error(
                    id: id,
                    code: -32601,
                    message: "Unknown tool: \(requestedTool)"
                )
            }
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            return tool.handler(id, arguments, processEnv, socketPath)
        default:
            guard let id else { return nil }
            return error(
                id: id,
                code: -32601,
                message: "Method not found: \(method ?? "unknown")"
            )
        }
    }

    /// Resolves the opt-in tool set. Prefers a fresh on-disk read of the
    /// active project's `.termloop/abilities/*/ability.json` when that
    /// directory can be found from cwd or any ancestor. The ancestor walk is
    /// important for worktree agents launched from
    /// `<project>/.termloop-worktrees/<branch>`: Codex may sandbox MCP
    /// subprocess env, so relying only on launch-time
    /// `TERMLOOP_ENABLED_MCP_TOOLS` would leave optional tools stale after an
    /// ability toggle. Falls back to env only when no project ability catalog
    /// is locatable.
    private static func enabledToolNameSet(env: [String: String]) -> Set<String> {
        if let disk = enabledToolNamesFromCWDIfAvailable() {
            return disk
        }
        return enabledToolNamesFromEnv(env)
    }

    private static func enabledToolNamesFromEnv(_ env: [String: String]) -> Set<String> {
        guard let raw = env[enabledToolsEnvKey], !raw.isEmpty else { return [] }
        return Set(
            raw.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        )
    }

    /// Mirrors the off-state token of `AbilityActivation` in the app target.
    /// Kept inline because the CLI does not link the app's ability types.
    private static let abilityActivationOffToken = "off"

    /// Walks `<cwd>/.termloop/abilities/` for ability bundles. Returns the
    /// union of `termLoopMCPTools` entries whose binding is enabled and whose
    /// owning ability is not turned off. Tolerant of legacy bare-string
    /// entries. Returns nil (not empty set) when the directory is missing so
    /// the caller can distinguish "no abilities" from "can't see abilities".
    ///
    /// Mirrors `TerminalAgentRunner.enabledAbilityMCPToolNames`: the
    /// `working-with-jira` ability auto-opts into `set_jira_ticket` whenever
    /// it is active, so a bindings-only ability discovered via the disk
    /// fallback (e.g., MCP server invoked outside the runner-launched env)
    /// still sees the tool and the chip pipeline keeps working.
    private static func enabledToolNamesFromCWDIfAvailable() -> Set<String>? {
        guard let abilitiesDir = abilitiesDirectoryFromCWD() else {
            return nil
        }
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: abilitiesDir) else {
            return nil
        }
        var names: Set<String> = []
        for entry in entries {
            let manifestPath = abilitiesDir + "/" + entry + "/ability.json"
            guard let data = FileManager.default.contents(atPath: manifestPath),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            if (json["activation"] as? String) == abilityActivationOffToken { continue }
            if let tools = json["termLoopMCPTools"] as? [Any] {
                for tool in tools {
                    if let name = tool as? String {
                        names.insert(name)
                    } else if let obj = tool as? [String: Any],
                              let name = obj["name"] as? String,
                              (obj["enabled"] as? Bool) ?? true {
                        names.insert(name)
                    }
                }
            }
            if (json["id"] as? String) == jiraAbilityId {
                names.insert(setJiraTicketToolName)
                names.insert(getJiraTicketToolName)
            }
            if (json["id"] as? String) == runningYourApplicationAbilityId {
                names.insert(setRunTargetsToolName)
                names.insert(getRunTargetsToolName)
            }
        }
        return names
    }

    private static func abilitiesDirectoryFromCWD() -> String? {
        let fm = FileManager.default
        var url = URL(fileURLWithPath: fm.currentDirectoryPath, isDirectory: true)
            .standardizedFileURL
        while true {
            let candidate = url
                .appendingPathComponent(".termloop", isDirectory: true)
                .appendingPathComponent("abilities", isDirectory: true)
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: candidate.path, isDirectory: &isDir),
               isDir.boolValue {
                return candidate.path
            }
            let parent = url.deletingLastPathComponent()
            if parent.path == url.path {
                return nil
            }
            url = parent
        }
    }

    // MARK: Built-in tool handlers

    /// Jira ticket telemetry. Maps `(key, status?, url?)` onto the underlying
    /// V2 binding wire format with hardcoded ability/binding ids — keeps the
    /// app-side storage and chip rendering pipeline unchanged.
    private static func runSetJiraTicket(
        id: Any,
        arguments: [String: Any],
        processEnv: [String: String],
        socketPath: String
    ) -> [String: Any] {
        let key = ((arguments["key"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            return toolResult(id: id,
                              text: "Missing required argument: key",
                              isError: true)
        }
        let status = (arguments["status"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let url = (arguments["url"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let workspaceParams = workspaceTargetParams(env: processEnv)
        guard !workspaceParams.isEmpty else {
            return toolResult(id: id,
                              text: "TermLoop daemon target unknown: TERMLOOP_WORKSPACE_ID env var is unset and current working directory is empty.",
                              isError: true)
        }

        var params: [String: Any] = [
            "ability_id": jiraAbilityId,
            "binding_id": jiraBindingId,
            "label": key,
            "status": status as Any? ?? NSNull(),
            "url": url as Any? ?? NSNull()
        ]
        for (k, v) in workspaceParams { params[k] = v }

        let client = SocketClient(path: socketPath)
        do {
            try client.connect()
            defer { client.close() }
            let response = try client.sendV2(
                method: "workspace.report_agent_binding",
                params: params
            )
            if let errorText = extractErrorMessage(response) {
                return toolResult(id: id, text: errorText, isError: true)
            }
            let suffix = (status?.isEmpty == false) ? " · \(status!)" : ""
            return toolResult(id: id,
                              text: "Reported Jira ticket \(key)\(suffix)",
                              isError: false)
        } catch {
            return toolResult(id: id,
                              text: "Could not reach TermLoop daemon (socket=\(socketPath)): \(mcpErrorDescription(error))",
                              isError: true)
        }
    }

    /// Read-side counterpart to `runSetJiraTicket`. Returns the previously
    /// reported Jira ticket for this workspace, or "no ticket set yet".
    private static func runGetJiraTicket(
        id: Any,
        arguments: [String: Any],
        processEnv: [String: String],
        socketPath: String
    ) -> [String: Any] {
        let workspaceParams = workspaceTargetParams(env: processEnv)
        guard !workspaceParams.isEmpty else {
            return toolResult(id: id,
                              text: "TermLoop daemon target unknown: TERMLOOP_WORKSPACE_ID env var is unset and current working directory is empty.",
                              isError: true)
        }
        let client = SocketClient(path: socketPath)
        do {
            try client.connect()
            defer { client.close() }
            let response = try client.sendV2(
                method: "workspace.get_jira_ticket",
                params: workspaceParams
            )
            if let errorText = extractErrorMessage(response) {
                return toolResult(id: id, text: errorText, isError: true)
            }
            guard let result = (response["result"] as? [String: Any]) else {
                return toolResult(id: id,
                                  text: "TermLoop daemon returned no result for workspace.get_jira_ticket — daemon may not be running. Restart TermLoop and try again.",
                                  isError: true)
            }
            let isSet = (result["set"] as? Bool) ?? false
            guard isSet, let key = result["key"] as? String else {
                return toolResult(id: id,
                                  text: "No Jira ticket set for this workspace yet.",
                                  isError: false)
            }
            let status = (result["status"] as? String).map { " · \($0)" } ?? ""
            let url = (result["url"] as? String).map { " (\($0))" } ?? ""
            return toolResult(id: id,
                              text: "\(key)\(status)\(url)",
                              isError: false)
        } catch {
            return toolResult(id: id,
                              text: "Could not reach TermLoop daemon (socket=\(socketPath)): \(mcpErrorDescription(error))",
                              isError: true)
        }
    }

    /// Run targets telemetry. Maps `(targets: [{label, url?, path?, status?}])`
    /// onto the `workspace.set_run_targets` V2 method, which atomically
    /// replaces every binding under the `running-your-application` ability.
    /// Full-replace semantics: anything dropped from `targets` is cleared
    /// from the sidebar.
    private static func runSetRunTargets(
        id: Any,
        arguments: [String: Any],
        processEnv: [String: String],
        socketPath: String
    ) -> [String: Any] {
        guard let targetsRaw = arguments["targets"] as? [[String: Any]] else {
            return toolResult(id: id,
                              text: "Missing required argument: targets (array)",
                              isError: true)
        }
        let workspaceParams = workspaceTargetParams(env: processEnv)
        guard !workspaceParams.isEmpty else {
            return toolResult(id: id,
                              text: "TermLoop daemon target unknown: TERMLOOP_WORKSPACE_ID env var is unset and current working directory is empty.",
                              isError: true)
        }
        var params: [String: Any] = ["targets": targetsRaw]
        for (k, v) in workspaceParams { params[k] = v }
        let client = SocketClient(path: socketPath)
        do {
            try client.connect()
            defer { client.close() }
            let response = try client.sendV2(
                method: "workspace.set_run_targets",
                params: params
            )
            if let errorText = extractErrorMessage(response) {
                return toolResult(id: id, text: errorText, isError: true)
            }
            let count = targetsRaw.count
            let summary = count == 0
                ? "Cleared run targets."
                : "Reported \(count) run target\(count == 1 ? "" : "s")."
            return toolResult(id: id, text: summary, isError: false)
        } catch {
            return toolResult(id: id,
                              text: "Could not reach TermLoop daemon (socket=\(socketPath)): \(mcpErrorDescription(error))",
                              isError: true)
        }
    }

    /// Read-side counterpart. Returns the run targets currently bound to the
    /// workspace's worktree as a one-line-per-target summary so the agent can
    /// reason about what's already up before re-publishing.
    private static func runGetRunTargets(
        id: Any,
        arguments: [String: Any],
        processEnv: [String: String],
        socketPath: String
    ) -> [String: Any] {
        let workspaceParams = workspaceTargetParams(env: processEnv)
        guard !workspaceParams.isEmpty else {
            return toolResult(id: id,
                              text: "TermLoop daemon target unknown: TERMLOOP_WORKSPACE_ID env var is unset and current working directory is empty.",
                              isError: true)
        }
        let client = SocketClient(path: socketPath)
        do {
            try client.connect()
            defer { client.close() }
            let response = try client.sendV2(
                method: "workspace.get_run_targets",
                params: workspaceParams
            )
            if let errorText = extractErrorMessage(response) {
                return toolResult(id: id, text: errorText, isError: true)
            }
            guard let result = response["result"] as? [String: Any],
                  let targets = result["targets"] as? [[String: Any]] else {
                return toolResult(id: id,
                                  text: "TermLoop daemon returned no result for workspace.get_run_targets.",
                                  isError: true)
            }
            if targets.isEmpty {
                return toolResult(id: id,
                                  text: "No run targets set for this workspace yet.",
                                  isError: false)
            }
            let lines: [String] = targets.map { target in
                let label = (target["label"] as? String) ?? "(no label)"
                let status = (target["status"] as? String).map { " · \($0)" } ?? ""
                let url = (target["url"] as? String).map { " (\($0))" } ?? ""
                return "- \(label)\(status)\(url)"
            }
            return toolResult(id: id,
                              text: lines.joined(separator: "\n"),
                              isError: false)
        } catch {
            return toolResult(id: id,
                              text: "Could not reach TermLoop daemon (socket=\(socketPath)): \(mcpErrorDescription(error))",
                              isError: true)
        }
    }

    /// `ask_to` — programmatic Ask-To bridge launcher. Forwards the message,
    /// optional helper target / conversation id, and the resolved workspace
    /// target to the daemon's `bridge.ask_to` v2 method.
    private static func runAskTo(
        id: Any,
        arguments: [String: Any],
        processEnv: [String: String],
        socketPath: String
    ) -> [String: Any] {
        let target = ((arguments["target"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let conversationId = ((arguments["conversation_id"] as? String)
            ?? (arguments["bridge_id"] as? String)
            ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !conversationId.isEmpty, UUID(uuidString: conversationId) == nil {
            return toolResult(id: id,
                              text: "Invalid conversation_id: expected a UUID returned by ask_to.",
                              isError: true)
        }
        guard !target.isEmpty || !conversationId.isEmpty else {
            return toolResult(id: id,
                              text: "Missing required argument: target (unless conversation_id is supplied)",
                              isError: true)
        }
        guard target.isEmpty || ["codex", "claude", "gemini"].contains(target) else {
            return toolResult(id: id,
                              text: "Invalid target: must be codex, claude, or gemini.",
                              isError: true)
        }
        let message = ((arguments["message"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            return toolResult(id: id,
                              text: "Missing required argument: message",
                              isError: true)
        }
        let targetPrompt = (arguments["target_prompt"] as? String) ?? ""

        let workspaceParams = workspaceTargetParams(env: processEnv)
        guard !workspaceParams.isEmpty else {
            return toolResult(id: id,
                              text: "TermLoop daemon target unknown: no workspace env, cwd, or MCP process identity is available. ask_to requires a workspace-bound MCP session.",
                              isError: true)
        }

        var params: [String: Any] = [
            "message": message,
            "target_prompt": targetPrompt
        ]
        if !target.isEmpty {
            params["target"] = target
        }
        if !conversationId.isEmpty {
            params["conversation_id"] = conversationId
        }
        for (key, value) in workspaceParams {
            params[key] = value
        }

        let client = SocketClient(path: socketPath)
        do {
            try client.connect()
            defer { client.close() }
            // sendV2 unwraps the {"ok":true,"result":{...}} envelope and
            // returns the inner result dict; on a v2 error it throws with
            // the daemon's code/message embedded in the CLIError.
            let result = try client.sendV2(method: "bridge.ask_to", params: params)
            let bridgeId = (result["bridge_id"] as? String) ?? "?"
            let requestId = (result["request_id"] as? String) ?? bridgeId
            let helperId = (result["helper_workspace_id"] as? String) ?? "?"
            let helperAgent = (result["helper_agent_id"] as? String)
                ?? (result["target"] as? String)
                ?? target
            let reused = (result["reused_helper"] as? Bool) == true
            return toolResult(
                id: id,
                text: "Sent to \(helperAgent). request_id=\(requestId), bridge_id=\(bridgeId), conversation_id=\(bridgeId), helper_workspace_id=\(helperId), reused_helper=\(reused). The helper must call reply_to_request exactly once with this request_id when the final answer is ready. For follow-up to this same helper, call ask_to again with conversation_id=\(bridgeId).",
                isError: false
            )
        } catch {
            return toolResult(id: id,
                              text: "ask_to failed: \(mcpErrorDescription(error))",
                              isError: true)
        }
    }

    /// `reply_to_request` — final, single-use Ask-To answer delivery. The
    /// daemon enforces that the caller is the helper workspace for the
    /// request and rejects duplicate replies.
    private static func runReplyToRequest(
        id: Any,
        arguments: [String: Any],
        processEnv: [String: String],
        socketPath: String
    ) -> [String: Any] {
        let requestId = ((arguments["request_id"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard UUID(uuidString: requestId) != nil else {
            return toolResult(id: id,
                              text: "Missing or invalid required argument: request_id",
                              isError: true)
        }
        let message = ((arguments["message"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            return toolResult(id: id,
                              text: "Missing required argument: message",
                              isError: true)
        }

        let workspaceParams = workspaceTargetParams(env: processEnv)
        guard !workspaceParams.isEmpty else {
            return toolResult(id: id,
                              text: "TermLoop daemon target unknown: no workspace env, cwd, or MCP process identity is available. reply_to_request must run from the helper workspace.",
                              isError: true)
        }

        var params: [String: Any] = [
            "request_id": requestId,
            "message": message
        ]
        for (key, value) in workspaceParams {
            params[key] = value
        }

        let client = SocketClient(path: socketPath)
        do {
            try client.connect()
            defer { client.close() }
            let result = try client.sendV2(method: "bridge.reply_to_request", params: params)
            let deliveredId = (result["request_id"] as? String) ?? requestId
            let conversationId = (result["conversation_id"] as? String)
                ?? (result["bridge_id"] as? String)
            return toolResult(
                id: id,
                text: "Reply delivered for request_id=\(deliveredId). Do not continue this request; follow-up requires a new ask_to request\(conversationId.map { " with conversation_id=\($0)" } ?? "").",
                isError: false
            )
        } catch {
            return toolResult(id: id,
                              text: "reply_to_request failed: \(mcpErrorDescription(error))",
                              isError: true)
        }
    }

    /// Forwards a curator suggestion to the daemon. Validation of the
    /// action-specific shape (e.g. `.add` requires `add_text`) happens
    /// app-side in `ContextBankAnalyzer.suggestion(from:sessionId:)`.
    private static func runContextBankPropose(
        id: Any,
        arguments: [String: Any],
        processEnv: [String: String],
        socketPath: String
    ) -> [String: Any] {
        let action = ((arguments["action"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard ["add", "replace", "move"].contains(action) else {
            return toolResult(id: id,
                              text: "Invalid action: must be add | replace | move",
                              isError: true)
        }
        let targetPath = ((arguments["target_path"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !targetPath.isEmpty else {
            return toolResult(id: id, text: "target_path is required", isError: true)
        }
        let reasoning = ((arguments["reasoning"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reasoning.isEmpty else {
            return toolResult(id: id, text: "reasoning is required", isError: true)
        }
        let workspaceId = trimmedEnv(processEnv, "TERMLOOP_WORKSPACE_ID")
        let confidence = (arguments["confidence"] as? Double)
            ?? Double(arguments["confidence"] as? Int ?? 0)

        let client = SocketClient(path: socketPath)
        do {
            try client.connect()
            defer { client.close() }
            let response = try client.sendV2(
                method: "workspace.context_bank_propose_suggestion",
                params: [
                    "workspace_id": workspaceId as Any? ?? NSNull(),
                    "cwd": FileManager.default.currentDirectoryPath,
                    "action": action,
                    "target_path": targetPath,
                    "mirror_paths": (arguments["mirror_paths"] as? [String]) ?? [],
                    "from_path": arguments["from_path"] as Any? ?? NSNull(),
                    "add_text": arguments["add_text"] as Any? ?? NSNull(),
                    "replace_old_text": arguments["replace_old_text"] as Any? ?? NSNull(),
                    "reasoning": reasoning,
                    "source_quote": arguments["source_quote"] as Any? ?? NSNull(),
                    "confidence": max(0, min(1, confidence)),
                ]
            )
            if let errorText = extractErrorMessage(response) {
                return toolResult(id: id, text: errorText, isError: true)
            }
            let suggestionId = ((response["result"] as? [String: Any])?["suggestion_id"] as? String) ?? ""
            return toolResult(id: id,
                              text: "Suggestion accepted (\(suggestionId)). Continue with more proposals or call context_bank_finalize_run.",
                              isError: false)
        } catch {
            return toolResult(id: id,
                              text: "Could not reach TermLoop daemon (socket=\(socketPath)): \(mcpErrorDescription(error))",
                              isError: true)
        }
    }

    /// Signals the daemon that the curator analysis is done. Always called
    /// exactly once per fork — even if no proposals were emitted.
    private static func runContextBankFinalize(
        id: Any,
        arguments: [String: Any],
        processEnv: [String: String],
        socketPath: String
    ) -> [String: Any] {
        let workspaceId = trimmedEnv(processEnv, "TERMLOOP_WORKSPACE_ID")
        let summary = (arguments["summary"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let client = SocketClient(path: socketPath)
        do {
            try client.connect()
            defer { client.close() }
            let response = try client.sendV2(
                method: "workspace.context_bank_finalize_run",
                params: [
                    "workspace_id": workspaceId as Any? ?? NSNull(),
                    "cwd": FileManager.default.currentDirectoryPath,
                    "summary": summary as Any? ?? NSNull(),
                ]
            )
            if let errorText = extractErrorMessage(response) {
                return toolResult(id: id, text: errorText, isError: true)
            }
            return toolResult(id: id, text: "Analysis finalized.", isError: false)
        } catch {
            return toolResult(id: id,
                              text: "Could not reach TermLoop daemon (socket=\(socketPath)): \(mcpErrorDescription(error))",
                              isError: true)
        }
    }

    /// Reads a non-empty trimmed env var or returns nil. Tool handlers
    /// rely on `TERMLOOP_WORKSPACE_ID` and `TERMLOOP_AGENT_ID`.
    private static func trimmedEnv(_ env: [String: String], _ key: String) -> String? {
        let trimmed = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: JSON-RPC envelopes

    private static func result(id: Any?, body: [String: Any]) -> [String: Any] {
        [
            "jsonrpc": "2.0",
            "id": id as Any? ?? NSNull(),
            "result": body
        ]
    }

    private static func error(
        id: Any?,
        code: Int,
        message: String
    ) -> [String: Any] {
        [
            "jsonrpc": "2.0",
            "id": id as Any? ?? NSNull(),
            "error": [
                "code": code,
                "message": message
            ]
        ]
    }

    private static func toolResult(
        id: Any,
        text: String,
        isError: Bool
    ) -> [String: Any] {
        result(
            id: id,
            body: [
                "content": [
                    [
                        "type": "text",
                        "text": text
                    ]
                ],
                "isError": isError
            ]
        )
    }

    /// Builds the workspace-targeting params for a daemon call. Prefers the
    /// canonical `TERMLOOP_WORKSPACE_ID` env injected by the runner, and also
    /// sends the MCP subprocess's `cwd` when available. Ask-To helper launches
    /// also carry `TERMLOOP_ASK_TO_REQUEST_ID` and a launch-only reply token;
    /// the daemon can use that pair to authenticate `reply_to_request` when
    /// Codex/Claude hands the MCP server a stale workspace env. The MCP
    /// process identity is still useful when env/cwd are missing, so send it
    /// on its own as a last resort.
    private static func workspaceTargetParams(env: [String: String]) -> [String: Any] {
        let envId = env["TERMLOOP_WORKSPACE_ID"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let cwd = FileManager.default.currentDirectoryPath
        let hasCwd = !cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let agentId = env["TERMLOOP_AGENT_ID"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let askToRequestId = env["TERMLOOP_ASK_TO_REQUEST_ID"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let askToReplyToken = env["TERMLOOP_ASK_TO_REPLY_TOKEN"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let processContext = mcpProcessContextParams()
        func addLaunchContext(to params: inout [String: Any]) {
            if !agentId.isEmpty {
                params["agent_id"] = agentId
            }
            if !askToRequestId.isEmpty {
                params["ask_to_request_id"] = askToRequestId
            }
            if !askToReplyToken.isEmpty {
                params["ask_to_reply_token"] = askToReplyToken
            }
            for (key, value) in processContext {
                params[key] = value
            }
        }
        if !envId.isEmpty {
            var params: [String: Any] = ["workspace_id": envId]
            if hasCwd { params["cwd"] = cwd }
            addLaunchContext(to: &params)
            return params
        }
        if hasCwd {
            var params: [String: Any] = ["cwd": cwd]
            addLaunchContext(to: &params)
            return params
        }
        var params: [String: Any] = [:]
        addLaunchContext(to: &params)
        return params
    }

    /// Carries the MCP server process ancestry to the daemon. Some providers
    /// (notably after session compaction/reload) spawn the stdio MCP server
    /// without the per-workspace env from the original agent launch. The parent
    /// process is still usually the agent CLI itself, so the daemon can match
    /// this ancestry against its tracked agent PIDs and avoid cwd guessing.
    private static func mcpProcessContextParams() -> [String: Any] {
        let ancestry = processAncestorPIDs()
        var params: [String: Any] = [:]
        if let first = ancestry.first {
            params["mcp_pid"] = first
        }
        let directParent = Int(getppid())
        if directParent > 1 {
            params["mcp_parent_pid"] = directParent
        }
        if !ancestry.isEmpty {
            params["process_ancestor_pids"] = ancestry
        }
        return params
    }

    private static func processAncestorPIDs(limit: Int = 32) -> [Int] {
        var result: [Int] = []
        var seen = Set<pid_t>()
        var current = getpid()
        for _ in 0..<limit {
            guard current > 1, !seen.contains(current) else { break }
            seen.insert(current)
            result.append(Int(current))

            let parent = parentPID(of: current)
            guard parent > 1, parent != current else { break }
            current = parent
        }
        return result
    }

    private static func parentPID(of pid: pid_t) -> pid_t {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.size
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else {
            return -1
        }
        return info.kp_eproc.e_ppid
    }

    /// Pulls a human-readable error message out of a v2 socket response when
    /// the daemon answered with `{"error": {"code": ..., "message": ...}}`
    /// instead of `{"result": ...}`. Returns nil if the response shape is OK.
    private static func extractErrorMessage(_ response: [String: Any]) -> String? {
        guard let error = response["error"] as? [String: Any] else { return nil }
        let code = (error["code"] as? String) ?? "unknown"
        let message = (error["message"] as? String) ?? "TermLoop daemon returned an error."
        return "TermLoop daemon: \(message) (code: \(code))"
    }

    private static func mcpErrorDescription(_ error: Error) -> String {
        let localized = error.localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !localized.isEmpty {
            return localized
        }
        return String(describing: error)
    }

    private static func write(response: [String: Any]) throws {
        guard JSONSerialization.isValidJSONObject(response) else {
            return
        }
        let data = try JSONSerialization.data(withJSONObject: response, options: [])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
