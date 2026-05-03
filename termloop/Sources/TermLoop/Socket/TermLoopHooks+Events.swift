// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// TermLoop socket RPC handlers for the event-driven quick-reply protocol.
/// Kept in a separate file so upstream `TermLoopHooks` stays focused on
/// UI/lifecycle concerns.
extension TermLoopSocketCommands {
    private static let lifecycleLogger = Logger(
        subsystem: "com.termloop.fork",
        category: "agent-lifecycle.socket"
    )

    private static func lifecycleLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        let rendered = message()
        lifecycleLogger.debug("\(rendered, privacy: .public)")
        #endif
    }

    // MARK: - B2: internal.hook_event (Unix-only)

    /// Writes workspace attention metadata and publishes a `workspace.attention`
    /// event on the EventBus. Must be called from a Unix-socket thread only —
    /// rejects TCP clients.
    ///
    /// Params:
    ///   `session_id`       String  – Claude session ID (resolved to workspace)
    ///   `kind`             String  – "stop" | "notification"
    ///   `message_preview`  String  – agent message preview (truncated to 1000 chars)
    ///   `cwd`              String? – optional working directory (informational)
    ///
    /// Returns `{"ok": true, "workspace_id": "<uuid>"}`.
    static func v2InternalHookEvent(
        params: [String: Any],
        isTcp: Bool
    ) -> TerminalController.V2CallResult {
        guard !isTcp else {
            return .err(
                code: "forbidden",
                message: "internal.hook_event is only available over the Unix socket",
                data: nil
            )
        }

        guard let sessionId = rawString(params, "session_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty else {
            return .err(code: "invalid_params", message: "Missing session_id", data: nil)
        }
        guard let kind = rawString(params, "kind")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              kind == "stop" || kind == "notification" else {
            return .err(
                code: "invalid_params",
                message: "kind must be \"stop\" or \"notification\"",
                data: nil
            )
        }
        guard let rawPreview = rawString(params, "message_preview") else {
            return .err(code: "invalid_params", message: "Missing message_preview", data: nil)
        }

        let store = WorkspaceMetadataStore.shared
        guard let wsId = store.workspaceIdForClaudeSession(sessionId: sessionId) else {
            return .err(
                code: "not_found",
                message: "No workspace found for session_id \(sessionId)",
                data: nil
            )
        }

        let preview = String(rawPreview.prefix(1000))
        let attentionKind: TerminalAgentAttentionKind = {
            if kind == "stop" {
                return .completion
            }
            let lower = preview.lowercased()
            if lower.contains("permission") || lower.contains("approve") || lower.contains("approval") {
                return .permission
            }
            if lower.contains("error") || lower.contains("failed") || lower.contains("exception") {
                return .error
            }
            return .notification
        }()
        let result = reportAgentActivityCommon(
            workspaceId: wsId,
            agentId: "claude",
            phase: .waiting,
            attentionKind: attentionKind,
            preview: preview,
            sessionId: sessionId,
            cwd: rawString(params, "cwd"),
            pid: nil
        )
        guard case .ok(let raw) = result else { return result }

        return .ok(raw)
    }

    // MARK: - B3: workspace.clear_attention

    /// Clears all three attention-metadata keys for the given workspace.
    /// Callable from TCP (mobile clears after replying).
    ///
    /// Params:
    ///   `workspace_id`  String – UUID of the workspace to clear.
    ///
    /// Returns `{"ok": true, "workspace_id": "<uuid>"}`.
    static func v2WorkspaceClearAttention(
        params: [String: Any]
    ) -> TerminalController.V2CallResult {
        guard let wsIdStr = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !wsIdStr.isEmpty,
              let wsId = UUID(uuidString: wsIdStr) else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }

        WorkspaceMetadataStore.shared.clearAttentionState(forWorkspaceId: wsId)
        if let state = TerminalAgentActivityStore.shared.state(forWorkspaceId: wsId),
           state.phase == .waiting {
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
            if let workspace = AppDelegate.shared?.workspaceFor(tabId: wsId) {
                let statusKey = TerminalAgentStatusKeys.key(forAgentId: state.agentId)
                workspace.statusEntries.removeValue(forKey: statusKey)
            }
        }
        return .ok(["workspace_id": wsIdStr])
    }

    // MARK: - Generic agent activity

    static func workspaceReportAgentActivity(
        _ params: [String: Any]
    ) -> TerminalController.V2CallResult {
        guard let wsIdStr = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              let wsId = UUID(uuidString: wsIdStr) else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }
        guard let agentId = rawString(params, "agent_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !agentId.isEmpty else {
            return .err(code: "invalid_params", message: "Missing agent_id", data: nil)
        }
        guard let rawPhase = rawString(params, "phase")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              let phase = TerminalAgentActivityPhase(rawValue: rawPhase) else {
            return .err(code: "invalid_params", message: "Missing or invalid phase", data: nil)
        }
        let attentionKind = rawString(params, "attention_kind")
            .flatMap { TerminalAgentAttentionKind(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        let preview = rawString(params, "message_preview").map { String($0.prefix(1000)) }
        let userPromptSubmitted: Bool = {
            if let boolValue = params["user_prompt_submitted"] as? Bool {
                return boolValue
            }
            if let intValue = params["user_prompt_submitted"] as? Int {
                return intValue != 0
            }
            if let raw = rawString(params, "user_prompt_submitted")?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased() {
                return raw == "1" || raw == "true" || raw == "yes"
            }
            return false
        }()
        let sessionId = rawString(params, "session_id")
        let cwd = rawString(params, "cwd")
        let pid: pid_t? = {
            if let n = params["pid"] as? Int, n > 0 { return pid_t(n) }
            if let n = params["pid"] as? Int32, n > 0 { return n }
            return nil
        }()
        lifecycleLog(
            "rpc.reportAgentActivity.enter workspace=\(wsId.uuidString) agent=\(agentId) phase=\(phase.rawValue) attention=\(attentionKind?.rawValue ?? "nil") userPrompt=\(userPromptSubmitted ? 1 : 0) session=\(sessionId ?? "nil") cwd=\(cwd ?? "nil") pid=\(pid.map(String.init) ?? "nil") preview=\(preview ?? "nil")"
        )
        return reportAgentActivityCommon(
            workspaceId: wsId,
            agentId: agentId,
            phase: phase,
            attentionKind: attentionKind,
            preview: preview,
            userPromptSubmitted: userPromptSubmitted,
            sessionId: sessionId,
            cwd: cwd,
            pid: pid
        )
    }

    static func workspaceClearAgentActivity(
        _ params: [String: Any]
    ) -> TerminalController.V2CallResult {
        guard let wsIdStr = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              let wsId = UUID(uuidString: wsIdStr) else {
            return .err(code: "invalid_params", message: "Missing or invalid workspace_id", data: nil)
        }
        clearAgentActivityCommon(workspaceId: wsId)
        return .ok(["workspace_id": wsIdStr])
    }

    /// Two-arm result for `resolveWorkspaceId`. We can't use `Swift.Result`
    /// here because `V2CallResult` doesn't (and shouldn't) conform to
    /// `Error` — it's a return value, not a thrown failure.
    enum WorkspaceLookup {
        case found(id: UUID, idString: String)
        case missing(TerminalController.V2CallResult)
    }

    /// Resolves a workspace UUID from the standard `workspace_id` param,
    /// or falls back to `cwd` for callers that don't have the env var set
    /// (e.g. MCP server spawned outside the TermLoop runner). Returns
    /// `.missing(...)` with an appropriate v2 error when neither route
    /// resolves a known workspace.
    static func resolveWorkspaceId(from params: [String: Any]) -> WorkspaceLookup {
        if let wsIdStr = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !wsIdStr.isEmpty {
            guard let wsId = UUID(uuidString: wsIdStr) else {
                return .missing(.err(code: "invalid_params",
                                     message: "Invalid workspace_id",
                                     data: nil))
            }
            return .found(id: wsId, idString: wsIdStr)
        }
        if let cwd = rawString(params, "cwd")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !cwd.isEmpty {
            if let wsId = WorkspaceMetadataStore.shared.workspaceId(forCwd: cwd) {
                return .found(id: wsId, idString: wsId.uuidString)
            }
            if let liveLookup = resolveLiveWorkspaceId(forCwd: cwd) {
                return liveLookup
            }
            return .missing(.err(code: "no_workspace_for_cwd",
                                 message: "No open workspace owns the cwd \(cwd)",
                                 data: ["cwd": cwd]))
        }
        return .missing(.err(code: "invalid_params",
                             message: "Missing workspace_id (or cwd for env-less callers)",
                             data: nil))
    }

    /// Fallback for env-less MCP callers launched from a normal project root
    /// rather than a TermLoop-managed worktree. Worktree roots are handled by
    /// `WorkspaceMetadataStore.workspaceId(forCwd:)`; this live scan covers
    /// generic root workspaces and uses the selected/recently-prompted
    /// workspace to avoid guessing when several tabs share the same cwd.
    private static func resolveLiveWorkspaceId(forCwd cwd: String) -> WorkspaceLookup? {
        guard let tabManager = AppDelegate.shared?.tabManager else { return nil }
        let normalizedCwd = canonicalPath(cwd)
        guard !normalizedCwd.isEmpty else { return nil }
        let matches = tabManager.tabs.filter { workspace in
            liveWorkspace(workspace, ownsCanonicalCwd: normalizedCwd)
        }
        guard !matches.isEmpty else { return nil }
        if matches.count == 1, let only = matches.first {
            return .found(id: only.id, idString: only.id.uuidString)
        }
        if let selected = tabManager.selectedWorkspace,
           matches.contains(where: { $0.id == selected.id }) {
            return .found(id: selected.id, idString: selected.id.uuidString)
        }

        let ranked = matches.sorted { lhs, rhs in
            let lhsDate = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: lhs.id).lastUserPromptAt
            let rhsDate = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: rhs.id).lastUserPromptAt
            return (lhsDate ?? .distantPast) > (rhsDate ?? .distantPast)
        }
        if let first = ranked.first {
            let firstDate = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: first.id).lastUserPromptAt
            let secondDate = ranked.dropFirst().first.map {
                WorkspaceMetadataStore.shared.metadata(forWorkspaceId: $0.id).lastUserPromptAt
            } ?? nil
            if firstDate != nil, firstDate != secondDate {
                return .found(id: first.id, idString: first.id.uuidString)
            }
        }

        return .missing(.err(
            code: "ambiguous_workspace_for_cwd",
            message: "Multiple open workspaces match cwd \(cwd); TERMLOOP_WORKSPACE_ID is required.",
            data: [
                "cwd": cwd,
                "workspace_ids": matches.map { $0.id.uuidString }
            ]
        ))
    }

    private static func liveWorkspace(_ workspace: Workspace, ownsCanonicalCwd cwd: String) -> Bool {
        let candidates = [workspace.currentDirectory] + Array(workspace.panelDirectories.values)
        return candidates.contains { raw in
            let candidate = canonicalPath(raw)
            guard !candidate.isEmpty else { return false }
            return cwd == candidate || cwd.hasPrefix(candidate + "/")
        }
    }

    private static func canonicalPath(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return URL(fileURLWithPath: trimmed).resolvingSymlinksInPath().path
    }

    private static func reportedStateFallbackPath(
        workspaceId: UUID,
        params: [String: Any]
    ) -> String? {
        let cwd = rawString(params, "cwd")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !cwd.isEmpty { return cwd }

        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
            return nil
        }
        let presentationPath = workspace.termLoopPresentationCwd()?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !presentationPath.isEmpty { return presentationPath }

        let currentDirectory = workspace.currentDirectory
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return currentDirectory.isEmpty ? nil : currentDirectory
    }

    /// Generic ability binding telemetry. Stores the opaque payload
    /// keyed by `<abilityId>.<bindingId>` in the worktree-scoped reported
    /// state store. Dedupes idempotent reports so observers don't churn.
    static func workspaceReportAgentBinding(
        _ params: [String: Any]
    ) -> TerminalController.V2CallResult {
        let wsId: UUID
        let wsIdStr: String
        switch resolveWorkspaceId(from: params) {
        case .found(let id, let idString):
            wsId = id
            wsIdStr = idString
        case .missing(let err):
            return err
        }
        guard let abilityId = rawString(params, "ability_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !abilityId.isEmpty else {
            return .err(code: "invalid_params", message: "Missing or invalid ability_id", data: nil)
        }
        guard let bindingId = rawString(params, "binding_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !bindingId.isEmpty else {
            return .err(code: "invalid_params", message: "Missing or invalid binding_id", data: nil)
        }
        guard let label = rawString(params, "label")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !label.isEmpty else {
            return .err(code: "invalid_params", message: "Missing or invalid label", data: nil)
        }
        let normalizedStatus: String? = {
            let trimmed = rawString(params, "status")?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }()
        let normalizedURL: String? = {
            guard let urlRaw = rawString(params, "url")?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                  !urlRaw.isEmpty,
                  let parsed = URL(string: urlRaw),
                  let scheme = parsed.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" else { return nil }
            return parsed.absoluteString
        }()

        let value = AgentReportedStateStore.AgentReportedBinding(
            abilityId: abilityId,
            bindingId: bindingId,
            label: label,
            status: normalizedStatus,
            url: normalizedURL,
            reportedAt: Date()
        )
        switch WorkspaceMetadataStore.shared.setReportedBinding(
            value,
            abilityId: abilityId,
            bindingId: bindingId,
            forWorkspaceId: wsId,
            fallbackPath: reportedStateFallbackPath(workspaceId: wsId, params: params)
        ) {
        case .noWorktree:
            return .err(code: "no_worktree",
                        message: "Workspace has no canonical worktree root",
                        data: nil)
        case .noChange:
            return .ok([
                "workspace_id": wsIdStr,
                "ability_id": abilityId,
                "binding_id": bindingId,
                "deduped": true
            ])
        case .wrote:
            return .ok([
                "workspace_id": wsIdStr,
                "ability_id": abilityId,
                "binding_id": bindingId,
                "label": label,
                "status": normalizedStatus as Any? ?? NSNull(),
                "url": normalizedURL as Any? ?? NSNull()
            ])
        }
    }

    /// Read the Jira ticket binding for a workspace. Counterpart to the
    /// `set_jira_ticket` MCP tool — agent calls this to ask "what ticket am I
    /// working on?" instead of re-deriving from the branch name.
    static func workspaceGetJiraTicket(
        _ params: [String: Any]
    ) -> TerminalController.V2CallResult {
        let wsId: UUID
        let wsIdStr: String
        switch resolveWorkspaceId(from: params) {
        case .found(let id, let idString):
            wsId = id
            wsIdStr = idString
        case .missing(let err):
            return err
        }
        guard let path = WorkspaceMetadataStore.shared
            .reportedStatePath(
                forWorkspaceId: wsId,
                fallbackPath: reportedStateFallbackPath(workspaceId: wsId, params: params)
            ) else {
            return .err(code: "no_worktree",
                        message: "Workspace has no canonical worktree root",
                        data: nil)
        }
        guard let binding = AgentReportedStateStore.shared
            .binding(abilityId: "working-with-jira",
                     bindingId: "ticket",
                     forPath: path) else {
            return .ok(["workspace_id": wsIdStr, "set": false])
        }
        return .ok([
            "workspace_id": wsIdStr,
            "set": true,
            "key": binding.label,
            "status": binding.status as Any? ?? NSNull(),
            "url": binding.url as Any? ?? NSNull(),
            "reported_at": ISO8601DateFormatter().string(from: binding.reportedAt)
        ])
    }


    /// Full-replace semantics: anything dropped from `targets` clears.
    /// `path` arrives as filesystem; we hand it back as `file://` so the
    /// chip's existing URL opener handles it.
    static func workspaceSetRunTargets(
        _ params: [String: Any]
    ) -> TerminalController.V2CallResult {
        let abilityId = TermLoopBuiltInMCP.runningYourApplicationAbilityId
        let wsId: UUID
        let wsIdStr: String
        switch resolveWorkspaceId(from: params) {
        case .found(let id, let idString):
            wsId = id
            wsIdStr = idString
        case .missing(let err):
            return err
        }
        let fallbackPath = reportedStateFallbackPath(workspaceId: wsId, params: params)
        guard let workspaceRootPath = WorkspaceMetadataStore.shared
            .reportedStatePath(forWorkspaceId: wsId, fallbackPath: fallbackPath) else {
            return .err(code: "no_worktree",
                        message: "Workspace has no canonical worktree root",
                        data: nil)
        }
        guard let rawTargets = params["targets"] as? [[String: Any]] else {
            return .err(code: "invalid_params",
                        message: "Missing or invalid `targets` array",
                        data: nil)
        }
        var bindings: [AgentReportedStateStore.AgentReportedBinding] = []
        var seenIds = Set<String>()
        let now = Date()
        for (index, raw) in rawTargets.enumerated() {
            guard let label = (raw["label"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                  !label.isEmpty else {
                return .err(code: "invalid_params",
                            message: "targets[\(index)].label is required",
                            data: nil)
            }
            let normalizedStatus: String? = {
                let s = (raw["status"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return s.isEmpty ? nil : s
            }()
            let normalizedURL: String? = normalizeRunTargetURL(
                url: raw["url"] as? String,
                path: raw["path"] as? String,
                relativeTo: workspaceRootPath
            )
            var bindingId = slugifyRunTargetLabel(label)
            // De-collide labels that slug to the same string within one call.
            if seenIds.contains(bindingId) {
                var suffix = 2
                while seenIds.contains("\(bindingId)-\(suffix)") { suffix += 1 }
                bindingId = "\(bindingId)-\(suffix)"
            }
            seenIds.insert(bindingId)
            bindings.append(
                AgentReportedStateStore.AgentReportedBinding(
                    abilityId: abilityId,
                    bindingId: bindingId,
                    label: label,
                    status: normalizedStatus,
                    url: normalizedURL,
                    reportedAt: now
                )
            )
        }
        let outcome = WorkspaceMetadataStore.shared.replaceReportedBindings(
            underAbilityId: abilityId,
            with: bindings,
            forWorkspaceId: wsId,
            fallbackPath: fallbackPath
        )
        let labels = bindings.map { $0.bindingId }.joined(separator: ",")
        lifecycleLog(
            "rpc.set_run_targets workspace=\(wsIdStr) outcome=\(outcome) count=\(bindings.count) bindings=[\(labels)]"
        )
        switch outcome {
        case .noWorktree:
            return .err(code: "no_worktree",
                        message: "Workspace has no canonical worktree root",
                        data: nil)
        case .noChange:
            return .ok([
                "workspace_id": wsIdStr,
                "ability_id": abilityId,
                "deduped": true,
                "count": bindings.count
            ])
        case .wrote:
            return .ok([
                "workspace_id": wsIdStr,
                "ability_id": abilityId,
                "count": bindings.count
            ])
        }
    }

    static func workspaceGetRunTargets(
        _ params: [String: Any]
    ) -> TerminalController.V2CallResult {
        let abilityId = TermLoopBuiltInMCP.runningYourApplicationAbilityId
        let wsId: UUID
        let wsIdStr: String
        switch resolveWorkspaceId(from: params) {
        case .found(let id, let idString):
            wsId = id
            wsIdStr = idString
        case .missing(let err):
            return err
        }
        guard let path = WorkspaceMetadataStore.shared
            .reportedStatePath(
                forWorkspaceId: wsId,
                fallbackPath: reportedStateFallbackPath(workspaceId: wsId, params: params)
            ) else {
            return .err(code: "no_worktree",
                        message: "Workspace has no canonical worktree root",
                        data: nil)
        }
        let bindings = AgentReportedStateStore.shared
            .bindings(forPath: path)
            .filter { $0.abilityId == abilityId }
        let formatter = ISO8601DateFormatter()
        let payload: [[String: Any]] = bindings.map { binding in
            [
                "label": binding.label,
                "status": binding.status as Any? ?? NSNull(),
                "url": binding.url as Any? ?? NSNull(),
                "reported_at": formatter.string(from: binding.reportedAt)
            ]
        }
        return .ok([
            "workspace_id": wsIdStr,
            "ability_id": abilityId,
            "targets": payload
        ])
    }

    /// Slug helper: lowercase, ascii alphanumerics + dashes, collapsed
    /// runs, trimmed. Falls back to "target" so an empty slug never
    /// produces an empty bindingId.
    private static func slugifyRunTargetLabel(_ raw: String) -> String {
        var result = ""
        var pendingDash = false
        for scalar in raw.lowercased().unicodeScalars {
            let ch = Character(scalar)
            let isAllowed = ch.isASCII
                && (ch.isLetter || ch.isNumber || ch == "-")
            if isAllowed {
                if pendingDash, !result.isEmpty { result.append("-") }
                pendingDash = false
                result.append(ch)
            } else {
                pendingDash = !result.isEmpty
            }
        }
        while result.hasSuffix("-") { result.removeLast() }
        return result.isEmpty ? "target" : result
    }

    /// Accepts either an `url` (http/https) or a `path` (filesystem).
    /// Filesystem paths are returned as `file://...` so the chip's existing
    /// `destinationURL` opener handles them. Returns nil for unusable
    /// input rather than failing — a target with no URL still renders.
    private static func normalizeRunTargetURL(
        url: String?,
        path: String?,
        relativeTo workspaceRootPath: String
    ) -> String? {
        if let urlRaw = url?.trimmingCharacters(in: .whitespacesAndNewlines),
           !urlRaw.isEmpty,
           let parsed = URL(string: urlRaw),
           let scheme = parsed.scheme?.lowercased(),
           scheme == "http" || scheme == "https" || scheme == "file" {
            return parsed.absoluteString
        }
        if let pathRaw = path?.trimmingCharacters(in: .whitespacesAndNewlines),
           !pathRaw.isEmpty {
            let absolute = (pathRaw as NSString).expandingTildeInPath
            let resolvedPath = (absolute as NSString).isAbsolutePath
                ? absolute
                : (workspaceRootPath as NSString).appendingPathComponent(absolute)
            return URL(fileURLWithPath: resolvedPath).absoluteString
        }
        return nil
    }

    static func workspaceContextBankProposeSuggestion(
        _ params: [String: Any]
    ) -> TerminalController.V2CallResult {
        let wsIdRaw = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let explicitWsId: UUID?
        if wsIdRaw.isEmpty {
            explicitWsId = nil
        } else if let parsed = UUID(uuidString: wsIdRaw) {
            explicitWsId = parsed
        } else {
            return .err(code: "invalid_params", message: "Invalid workspace_id", data: nil)
        }
        guard let actionRaw = rawString(params, "action")?.trimmingCharacters(in: .whitespacesAndNewlines),
              let action = ContextBankSuggestion.Action(rawValue: actionRaw) else {
            return .err(code: "invalid_params", message: "Missing or invalid action", data: nil)
        }
        guard let targetPath = rawString(params, "target_path")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !targetPath.isEmpty else {
            return .err(code: "invalid_params", message: "Missing target_path", data: nil)
        }
        guard let reasoning = rawString(params, "reasoning")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !reasoning.isEmpty else {
            return .err(code: "invalid_params", message: "Missing reasoning", data: nil)
        }
        let mirrorPaths = (params["mirror_paths"] as? [String]) ?? []
        let addText = rawString(params, "add_text")
        let replaceOldText = rawString(params, "replace_old_text")
        let fromPath = rawString(params, "from_path")
        let sourceQuote = rawString(params, "source_quote")
        let confidence = (params["confidence"] as? Double)
            ?? Double(params["confidence"] as? Int ?? 0)
        let wsId: UUID
        do {
            wsId = try ContextBankAnalysisCoordinator.shared.resolveForkWorkspaceId(
                explicitWorkspaceId: explicitWsId,
                cwd: rawString(params, "cwd")
            )
        } catch {
            return .err(
                code: "not_context_bank_run",
                message: error.localizedDescription,
                data: nil
            )
        }
        guard let sourceSessionId = ContextBankAnalysisCoordinator.shared
            .sourceSessionId(forForkWorkspaceId: wsId) else {
            return .err(
                code: "not_context_bank_run",
                message: "No active Context Bank analysis run owns workspace \(wsId.uuidString)",
                data: nil
            )
        }

        // Reuse the analyzer's per-item validator so MCP-supplied payloads
        // get the same action-specific shape checks as the legacy JSON
        // path (e.g. .add requires add_text, .move requires from_path).
        let item: [String: Any] = [
            "action": actionRaw,
            "target_path": targetPath,
            "mirror_paths": mirrorPaths,
            "from_path": fromPath as Any? ?? NSNull(),
            "add_text": addText as Any? ?? NSNull(),
            "replace_old_text": replaceOldText as Any? ?? NSNull(),
            "reasoning": reasoning,
            "source_quote": sourceQuote as Any? ?? NSNull(),
            "confidence": confidence,
        ]
        guard let suggestion = ContextBankAnalyzer.suggestion(
            from: item,
            sessionId: sourceSessionId
        ) else {
            return .err(
                code: "invalid_params",
                message: "Suggestion failed action-shape validation (e.g. add requires add_text)",
                data: nil
            )
        }
        _ = action  // satisfy unused-warning

        do {
            try ContextBankAnalysisCoordinator.shared.receiveProposal(
                suggestion,
                forForkWorkspaceId: wsId
            )
        } catch {
            return .err(
                code: "invalid_context_bank_suggestion",
                message: error.localizedDescription,
                data: nil
            )
        }
        return .ok([
            "suggestion_id": suggestion.id.uuidString,
            "workspace_id": wsId.uuidString,
        ])
    }

    static func workspaceContextBankFinalizeRun(
        _ params: [String: Any]
    ) -> TerminalController.V2CallResult {
        let wsIdRaw = rawString(params, "workspace_id")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let explicitWsId: UUID?
        if wsIdRaw.isEmpty {
            explicitWsId = nil
        } else if let parsed = UUID(uuidString: wsIdRaw) {
            explicitWsId = parsed
        } else {
            return .err(code: "invalid_params", message: "Invalid workspace_id", data: nil)
        }
        let summary = rawString(params, "summary")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let wsId: UUID
        do {
            wsId = try ContextBankAnalysisCoordinator.shared.resolveForkWorkspaceId(
                explicitWorkspaceId: explicitWsId,
                cwd: rawString(params, "cwd")
            )
        } catch {
            return .err(
                code: "not_context_bank_run",
                message: error.localizedDescription,
                data: nil
            )
        }
        guard ContextBankAnalysisCoordinator.shared.finalizeRun(
            forForkWorkspaceId: wsId,
            summary: summary?.isEmpty == true ? nil : summary
        ) else {
            return .err(
                code: "not_context_bank_run",
                message: "No active Context Bank analysis run owns workspace \(wsId.uuidString)",
                data: nil
            )
        }
        return .ok([
            "workspace_id": wsId.uuidString,
            "finalized": true,
        ])

    }

    @discardableResult
    private static func reportAgentActivityCommon(
        workspaceId: UUID,
        agentId: String,
        phase: TerminalAgentActivityPhase,
        attentionKind: TerminalAgentAttentionKind?,
        preview: String?,
        userPromptSubmitted: Bool = false,
        sessionId: String?,
        cwd: String?,
        pid: pid_t?
    ) -> TerminalController.V2CallResult {
        let now = Int(Date().timeIntervalSince1970)
        let waitingSince = phase == .waiting ? now : nil
        let metadata = WorkspaceMetadataStore.shared
        let priorWaiting = metadata.metadata(forWorkspaceId: workspaceId).awaitingInputSince != nil
        let priorPersistedSession = metadata.persistedAgentSession(for: workspaceId)
        let normalizedSessionId = metadata.acceptedObservedSessionId(
            agentId: agentId,
            sessionId: sessionId,
            forWorkspaceId: workspaceId
        )
        let didAdoptObservedAgent = adoptObservedTerminalAgentIfNeeded(
            workspaceId: workspaceId,
            agentId: agentId,
            sessionId: normalizedSessionId
        )
        let preserveStickyRestoreState = shouldPreserveStickyRestoreState(
            workspaceId: workspaceId,
            agentId: agentId,
            phase: phase,
            sessionId: normalizedSessionId
        )
        lifecycleLog(
            "rpc.reportAgentActivity.normalize workspace=\(workspaceId.uuidString) agent=\(agentId) phase=\(phase.rawValue) attention=\(attentionKind?.rawValue ?? "nil") priorWaiting=\(priorWaiting ? 1 : 0) sessionIn=\(sessionId ?? "nil") sessionAccepted=\(normalizedSessionId ?? "nil") priorPersistedAgent=\(priorPersistedSession?.agentId ?? "nil") priorPersistedSession=\(priorPersistedSession?.sessionId ?? "nil") preserveSticky=\(preserveStickyRestoreState ? 1 : 0)"
        )
        var shouldSaveCriticalRestoreState = didAdoptObservedAgent
        var didUpdatePersistedSession = false
        if let sessionId = normalizedSessionId,
           !sessionId.isEmpty {
            let didUpdate = metadata.setPersistedAgentSession(
                agentId: agentId,
                sessionId: sessionId,
                cwd: cwd,
                for: workspaceId
            )
            didUpdatePersistedSession = didUpdate
            shouldSaveCriticalRestoreState = shouldSaveCriticalRestoreState || didUpdate
        }
        lifecycleLog(
            "rpc.reportAgentActivity.persist workspace=\(workspaceId.uuidString) agent=\(agentId) didAdopt=\(didAdoptObservedAgent ? 1 : 0) didUpdatePersisted=\(didUpdatePersistedSession ? 1 : 0) shouldSave=\(shouldSaveCriticalRestoreState ? 1 : 0)"
        )
        if shouldSaveCriticalRestoreState {
            TermLoopHooks.saveCriticalAgentRestoreStateSync()
        }
        if phase == .inactive || phase == .failed {
            metadata.clearPendingNativeFork(forWorkspaceId: workspaceId)
        }
        if userPromptSubmitted {
            metadata.setLastUserPromptAt(Date(), forWorkspaceId: workspaceId)
        } else if phase == .ready,
                  didUpdatePersistedSession,
                  let sessionId = normalizedSessionId,
                  priorPersistedSession?.agentId != agentId
                    || priorPersistedSession?.sessionId != sessionId {
            metadata.setLastUserPromptAt(nil, forWorkspaceId: workspaceId)
        } else if phase == .inactive || phase == .failed {
            metadata.setLastUserPromptAt(nil, forWorkspaceId: workspaceId)
        }
        TerminalAgentActivityStore.shared.upsert(
            workspaceId: workspaceId,
            agentId: agentId,
            phase: phase,
            attentionKind: attentionKind,
            preview: preview,
            waitingSince: waitingSince,
            sessionId: normalizedSessionId,
            cwd: cwd,
            pid: pid
        )
        syncCompatibilityAttentionState(
            workspaceId: workspaceId,
            preserveStickyRestoreState: preserveStickyRestoreState,
            phase: phase,
            attentionKind: attentionKind,
            preview: preview,
            waitingSince: waitingSince
        )
        updateWorkspaceSidebarStatus(
            workspaceId: workspaceId,
            agentId: agentId,
            preserveStickyRestoreState: preserveStickyRestoreState,
            phase: phase,
            attentionKind: attentionKind,
            pid: pid
        )

        if phase == .waiting {
            publishWorkspaceAttentionEvent(
                workspaceId: workspaceId,
                attentionKind: attentionKind,
                preview: preview,
                awaitingSince: waitingSince ?? now,
                agentId: agentId
            )
        } else if phase == .running, priorWaiting {
            EventBus.shared.publish(.init(
                type: "workspace.resumed",
                workspaceId: workspaceId,
                payload: [
                    "at": now,
                    "agent_id": agentId
                ]
            ))
        }
        lifecycleLog(
            "rpc.reportAgentActivity.done workspace=\(workspaceId.uuidString) agent=\(agentId) phase=\(phase.rawValue) attention=\(attentionKind?.rawValue ?? "nil") priorWaiting=\(priorWaiting ? 1 : 0) userPrompt=\(userPromptSubmitted ? 1 : 0) waitingSince=\(waitingSince.map(String.init) ?? "nil")"
        )

        return .ok([
            "workspace_id": workspaceId.uuidString,
            "agent_id": agentId,
            "phase": phase.rawValue,
            "awaiting_since": waitingSince as Any? ?? NSNull()
        ])
    }

    private static func adoptObservedTerminalAgentIfNeeded(
        workspaceId: UUID,
        agentId: String,
        sessionId: String?
    ) -> Bool {
        guard let normalizedSessionId = sessionId?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !normalizedSessionId.isEmpty else {
            return false
        }
        let normalizedAgentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedAgentId.isEmpty,
              TerminalAgentRegistry.shared.agent(id: normalizedAgentId) != nil else {
            return false
        }
        return WorkspaceMetadataStore.shared.setTerminalAgentId(
            normalizedAgentId,
            for: workspaceId
        )
    }

    private static func clearAgentActivityCommon(workspaceId: UUID) {
        let priorAgentId = TerminalAgentActivityStore.shared.state(forWorkspaceId: workspaceId)?.agentId
        lifecycleLog(
            "rpc.clearAgentActivity workspace=\(workspaceId.uuidString) priorAgent=\(priorAgentId ?? "nil")"
        )
        TerminalAgentActivityStore.shared.clear(workspaceId: workspaceId)
        WorkspaceMetadataStore.shared.clearAttentionState(forWorkspaceId: workspaceId)
        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else { return }
        let key = priorAgentId.map(TerminalAgentStatusKeys.key(forAgentId:))
            ?? TerminalAgentStatusKeys.key(forWorkspaceId: workspaceId)
        if let key {
            workspace.statusEntries.removeValue(forKey: key)
            if workspace.agentPIDs.removeValue(forKey: key) != nil {
                refreshTrackedAgentPorts(for: workspace)
            }
        }
    }

    private static func syncCompatibilityAttentionState(
        workspaceId: UUID,
        preserveStickyRestoreState: Bool,
        phase: TerminalAgentActivityPhase,
        attentionKind: TerminalAgentAttentionKind?,
        preview: String?,
        waitingSince: Int?
    ) {
        let store = WorkspaceMetadataStore.shared
        switch phase {
        case .waiting:
            store.setAttentionState(
                since: waitingSince ?? Int(Date().timeIntervalSince1970),
                preview: preview ?? "",
                attentionKind: attentionKind,
                forWorkspaceId: workspaceId
            )
        case .ready:
            if !preserveStickyRestoreState {
                store.setAwaitingInputSince(nil, forWorkspaceId: workspaceId)
            }
        case .running:
            store.setAwaitingInputSince(nil, forWorkspaceId: workspaceId)
        case .inactive, .failed:
            store.clearAttentionState(forWorkspaceId: workspaceId)
        }
    }

    private static func publishWorkspaceAttentionEvent(
        workspaceId: UUID,
        attentionKind: TerminalAgentAttentionKind?,
        preview: String?,
        awaitingSince: Int,
        agentId: String
    ) {
        EventBus.shared.publish(.init(
            type: "workspace.attention",
            workspaceId: workspaceId,
            payload: [
                "attention_kind": attentionKind?.rawValue as Any? ?? NSNull(),
                "message_preview": preview ?? "",
                "awaiting_since": awaitingSince,
                "agent_id": agentId
            ]
        ))
    }

    private static func updateWorkspaceSidebarStatus(
        workspaceId: UUID,
        agentId: String,
        preserveStickyRestoreState: Bool,
        phase: TerminalAgentActivityPhase,
        attentionKind: TerminalAgentAttentionKind?,
        pid: pid_t?
    ) {
        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else { return }
        let statusKey = TerminalAgentStatusKeys.key(forAgentId: agentId)
        let presentation = TerminalAgentDisplayFormatter.presentation(
            forPhase: phase,
            attentionKind: attentionKind
        )
        lifecycleLog(
            "rpc.sidebarStatus workspace=\(workspaceId.uuidString) agent=\(agentId) phase=\(phase.rawValue) attention=\(attentionKind?.rawValue ?? "nil") display=\(presentation.state.rawValue) preserveSticky=\(preserveStickyRestoreState ? 1 : 0) pid=\(pid.map(String.init) ?? "nil")"
        )
        switch presentation.state {
        case .idle:
            workspace.statusEntries.removeValue(forKey: statusKey)
        case .ready where preserveStickyRestoreState:
            break
        case .ready, .running, .needsInput, .completed, .error:
            workspace.statusEntries[statusKey] = SidebarStatusEntry(
                key: statusKey,
                value: presentation.label ?? "",
                icon: presentation.icon,
                color: presentation.colorHex
            )
        }
        if let pid, pid > 0 {
            workspace.agentPIDs[statusKey] = pid
        } else if presentation.state == .idle {
            workspace.agentPIDs.removeValue(forKey: statusKey)
        }
        refreshTrackedAgentPorts(for: workspace)
    }

    private static func shouldPreserveStickyRestoreState(
        workspaceId: UUID,
        agentId: String,
        phase: TerminalAgentActivityPhase,
        sessionId: String?
    ) -> Bool {
        guard phase == .ready,
              let normalizedSessionId = sessionId,
              !normalizedSessionId.isEmpty,
              let persisted = WorkspaceMetadataStore.shared.persistedAgentSession(for: workspaceId),
              persisted.agentId == agentId,
              persisted.sessionId == normalizedSessionId else {
            return false
        }
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
        if metadata.awaitingInputSince != nil {
            return true
        }
        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
            return false
        }
        let statusKey = TerminalAgentStatusKeys.key(forAgentId: agentId)
        guard
              let value = workspace.statusEntries[statusKey]?.value
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return false
        }
        return value == "Completed" || value == "Needs input" || value == "Error"
    }

    private static func refreshTrackedAgentPorts(for workspace: Workspace) {
        let agentPIDs = Set(workspace.agentPIDs.values.compactMap { $0 > 0 ? Int($0) : nil })
        PortScanner.shared.refreshAgentPorts(workspaceId: workspace.id, agentPIDs: agentPIDs)
    }
}
