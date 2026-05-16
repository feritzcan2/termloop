import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

/// Tests for the `internal.hook_event` and `workspace.clear_attention` RPCs.
@MainActor
final class InternalHookEventTests: XCTestCase {
    private func drainAgentPresentation() {
        TerminalAgentActivityStore.shared.drainPresentationFlushForTesting()
    }

    override func setUp() async throws {
        try await super.setUp()
        WorkspaceMetadataStore.shared.restore([:])
        TerminalAgentActivityStore.shared.replaceForTesting([:])
        drainAgentPresentation()
    }

    // MARK: - B2: internal.hook_event

    func testHookEventPublishesWorkspaceAttention() {
        let store = WorkspaceMetadataStore.shared
        let activityStore = TerminalAgentActivityStore.shared
        let wsId = UUID()
        let sessionId = "test-session-\(wsId.uuidString.prefix(8))"

        // Seed a claude session so the reverse-lookup works.
        store.setClaudeSession(
            workspaceId: wsId.uuidString,
            sessionId: sessionId,
            cwd: "/tmp",
            pid: nil
        )
        defer {
            store.clearClaudeSession(workspaceId: wsId.uuidString)
            activityStore.clear(workspaceId: wsId)
        }

        // Subscribe to events so we can verify the publish.
        var receivedEvent: EventBus.Event?
        let handle = EventBus.shared.subscribe(
            types: ["workspace.attention"],
            workspaceIds: [wsId]
        ) { event in
            receivedEvent = event
        }
        defer { EventBus.shared.unsubscribe(handle) }

        // Call the handler Unix-side (isTcp = false).
        let result = TermLoopSocketCommands.v2InternalHookEvent(
            params: [
                "session_id": sessionId,
                "kind": "stop",
                "message_preview": "What should I do next?"
            ],
            isTcp: false
        )

        // Result must be ok.
        guard case .ok(let raw) = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }
        let payload = raw as? [String: Any]
        XCTAssertEqual(payload?["workspace_id"] as? String, wsId.uuidString)

        // Metadata must be written.
        let md = store.metadata(forWorkspaceId: wsId)
        XCTAssertEqual(md.lastAttentionKindRaw, TerminalAgentAttentionKind.completion.rawValue)
        XCTAssertEqual(md.lastMessagePreview, "What should I do next?")
        XCTAssertNotNil(md.awaitingInputSince)
        XCTAssertEqual(activityStore.state(forWorkspaceId: wsId)?.agentId, "claude")
        XCTAssertEqual(activityStore.state(forWorkspaceId: wsId)?.phase, .waiting)
        XCTAssertEqual(activityStore.state(forWorkspaceId: wsId)?.attentionKind, .completion)

        // Event must have been published synchronously.
        XCTAssertNotNil(receivedEvent)
        XCTAssertEqual(receivedEvent?.type, "workspace.attention")
        XCTAssertEqual(receivedEvent?.workspaceId, wsId)
        XCTAssertEqual(
            receivedEvent?.payload["attention_kind"] as? String,
            TerminalAgentAttentionKind.completion.rawValue
        )
        XCTAssertEqual(
            receivedEvent?.payload["message_preview"] as? String,
            "What should I do next?"
        )
    }

    func testHookEventRejectedOnTCP() {
        let result = TermLoopSocketCommands.v2InternalHookEvent(
            params: [
                "session_id": "any-session",
                "kind": "stop",
                "message_preview": "hi"
            ],
            isTcp: true
        )
        guard case .err(let code, _, _) = result else {
            XCTFail("Expected .err result for TCP call")
            return
        }
        XCTAssertEqual(code, "forbidden")
    }

    func testHookEventTruncatesPreviewAt1000Chars() {
        let store = WorkspaceMetadataStore.shared
        let activityStore = TerminalAgentActivityStore.shared
        let wsId = UUID()
        let sessionId = "trunc-session-\(wsId.uuidString.prefix(8))"
        store.setClaudeSession(
            workspaceId: wsId.uuidString,
            sessionId: sessionId,
            cwd: nil,
            pid: nil
        )
        defer {
            store.clearClaudeSession(workspaceId: wsId.uuidString)
            activityStore.clear(workspaceId: wsId)
        }

        let longPreview = String(repeating: "x", count: 2000)

        let result = TermLoopSocketCommands.v2InternalHookEvent(
            params: [
                "session_id": sessionId,
                "kind": "notification",
                "message_preview": longPreview
            ],
            isTcp: false
        )
        guard case .ok = result else {
            XCTFail("Expected ok")
            return
        }
        let md = store.metadata(forWorkspaceId: wsId)
        XCTAssertEqual(md.lastMessagePreview?.count, 1000)
        XCTAssertEqual(activityStore.state(forWorkspaceId: wsId)?.preview?.count, 1000)
    }

    // MARK: - B3: workspace.clear_attention

    func testClearAttentionResetsMetadata() {
        let store = WorkspaceMetadataStore.shared
        let activityStore = TerminalAgentActivityStore.shared
        let wsId = UUID()

        // Seed all three keys.
        store.setAwaitingInputSince(1712345678, forWorkspaceId: wsId)
        store.setLastMessagePreview("Some preview", forWorkspaceId: wsId)
        store.setLastAttentionKindRaw(TerminalAgentAttentionKind.completion.rawValue, forWorkspaceId: wsId)
        activityStore.upsert(
            workspaceId: wsId,
            agentId: "codex",
            phase: .waiting,
            attentionKind: .completion,
            preview: "Some preview",
            waitingSince: 1712345678,
            sessionId: "session-1",
            cwd: nil,
            pid: nil
        )
        defer { activityStore.clear(workspaceId: wsId) }

        let result = TermLoopSocketCommands.v2WorkspaceClearAttention(
            params: ["workspace_id": wsId.uuidString]
        )

        guard case .ok(let raw) = result else {
            XCTFail("Expected ok, got \(result)")
            return
        }
        let payload = raw as? [String: Any]
        XCTAssertEqual(payload?["workspace_id"] as? String, wsId.uuidString)

        let md = store.metadata(forWorkspaceId: wsId)
        XCTAssertNil(md.awaitingInputSince)
        XCTAssertNil(md.lastMessagePreview)
        XCTAssertNil(md.lastAttentionKindRaw)
        XCTAssertNil(activityStore.state(forWorkspaceId: wsId))
    }

    func testClearAttentionMissingWorkspaceId() {
        let result = TermLoopSocketCommands.v2WorkspaceClearAttention(params: [:])
        guard case .err(let code, _, _) = result else {
            XCTFail("Expected err for missing workspace_id")
            return
        }
        XCTAssertEqual(code, "invalid_params")
    }

    func testReportAgentActivityWaitingWritesStoreAndPublishesAttention() {
        let store = WorkspaceMetadataStore.shared
        let activityStore = TerminalAgentActivityStore.shared
        let wsId = UUID()
        defer {
            store.clearAttentionState(forWorkspaceId: wsId)
            activityStore.clear(workspaceId: wsId)
        }

        var receivedEvent: EventBus.Event?
        let handle = EventBus.shared.subscribe(
            types: ["workspace.attention"],
            workspaceIds: [wsId]
        ) { event in
            receivedEvent = event
        }
        defer { EventBus.shared.unsubscribe(handle) }

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "codex",
            "phase": "waiting",
            "attention_kind": "completion",
            "message_preview": "Review needed",
            "session_id": "codex-session",
            "pid": 4242
        ])

        guard case .ok = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }
        let state = activityStore.state(forWorkspaceId: wsId)
        XCTAssertEqual(state?.agentId, "codex")
        XCTAssertEqual(state?.phase, .waiting)
        XCTAssertEqual(state?.attentionKind, .completion)
        XCTAssertEqual(state?.preview, "Review needed")
        XCTAssertEqual(state?.pid, 4242)
        XCTAssertEqual(TerminalAgentPresentationReducer.mapDisplayState(state), .completed)
        XCTAssertNotNil(store.metadata(forWorkspaceId: wsId).awaitingInputSince)
        XCTAssertEqual(receivedEvent?.payload["agent_id"] as? String, "codex")
        XCTAssertEqual(receivedEvent?.payload["attention_kind"] as? String, "completion")
    }

    func testReportAgentActivityWithTrustedSessionAdoptsWorkspaceAgent() {
        let store = WorkspaceMetadataStore.shared
        let wsId = UUID()
        defer {
            store.setTerminalAgentId(nil, for: wsId)
            store.clearPersistedAgentSession(for: wsId)
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
        }

        store.setTerminalAgentId("claude", for: wsId)

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "codex",
            "phase": "ready",
            "session_id": "codex-session-manual",
            "cwd": "/tmp/manual-codex"
        ])

        guard case .ok = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }

        XCTAssertEqual(store.terminalAgentId(for: wsId), "codex")
        XCTAssertEqual(
            store.persistedAgentSession(for: wsId)?.sessionId,
            "codex-session-manual"
        )
    }

    func testReportAgentActivityDoesNotReplaceDifferentPersistedAgent() {
        let store = WorkspaceMetadataStore.shared
        let activityStore = TerminalAgentActivityStore.shared
        let wsId = UUID()
        let cwd = "/tmp/termloop-hermes"
        defer {
            store.setTerminalAgentId(nil, for: wsId)
            store.clearPersistedAgentSession(for: wsId)
            activityStore.clear(workspaceId: wsId)
        }

        store.setTerminalAgentId("codex", for: wsId)
        store.setPersistedAgentSession(
            agentId: "codex",
            sessionId: "codex-session",
            cwd: cwd,
            for: wsId
        )
        activityStore.upsert(
            workspaceId: wsId,
            agentId: "codex",
            phase: .waiting,
            attentionKind: .completion,
            preview: "Codex completed",
            waitingSince: 1,
            sessionId: "codex-session",
            cwd: cwd,
            pid: nil
        )

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "claude",
            "phase": "ready",
            "session_id": "claude-helper-session",
            "cwd": cwd
        ])

        guard case .ok(let payload) = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }

        XCTAssertEqual(payload["ignored"] as? Bool, true)
        XCTAssertEqual(payload["reason"] as? String, "persisted_agent_mismatch")
        XCTAssertEqual(store.terminalAgentId(for: wsId), "codex")
        XCTAssertEqual(store.persistedAgentSession(for: wsId)?.agentId, "codex")
        XCTAssertEqual(store.persistedAgentSession(for: wsId)?.sessionId, "codex-session")
        XCTAssertEqual(activityStore.state(forWorkspaceId: wsId)?.agentId, "codex")
        XCTAssertEqual(activityStore.state(forWorkspaceId: wsId)?.sessionId, "codex-session")
    }

    func testReportAgentActivityDoesNotReplaceDifferentLiveAgent() {
        let store = WorkspaceMetadataStore.shared
        let activityStore = TerminalAgentActivityStore.shared
        let wsId = UUID()
        let cwd = "/tmp/termloop-hermes"
        defer {
            store.setTerminalAgentId(nil, for: wsId)
            store.clearPersistedAgentSession(for: wsId)
            activityStore.clear(workspaceId: wsId)
        }

        store.setTerminalAgentId("codex", for: wsId)
        activityStore.upsert(
            workspaceId: wsId,
            agentId: "codex",
            phase: .running,
            attentionKind: nil,
            preview: nil,
            waitingSince: nil,
            sessionId: "codex-live-session",
            cwd: cwd,
            pid: nil
        )

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "claude",
            "phase": "ready",
            "session_id": "claude-helper-session",
            "cwd": cwd
        ])

        guard case .ok(let payload) = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }

        XCTAssertEqual(payload["ignored"] as? Bool, true)
        XCTAssertEqual(payload["reason"] as? String, "live_agent_mismatch")
        XCTAssertEqual(store.terminalAgentId(for: wsId), "codex")
        XCTAssertNil(store.persistedAgentSession(for: wsId))
        XCTAssertEqual(activityStore.state(forWorkspaceId: wsId)?.agentId, "codex")
        XCTAssertEqual(activityStore.state(forWorkspaceId: wsId)?.sessionId, "codex-live-session")
    }

    func testDeferredClaudeReadyActivityDoesNotPersistMissingTranscriptSession() {
        let store = WorkspaceMetadataStore.shared
        let wsId = UUID()
        let sessionId = "termloop-test-missing-\(UUID().uuidString)"
        defer {
            store.setTerminalAgentId(nil, for: wsId)
            store.clearPersistedAgentSession(for: wsId)
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
        }

        store.setTerminalAgentId("claude", for: wsId)
        store.setDeferObservedAgentSessionPersistenceUntilPrompt(true, forWorkspaceId: wsId)

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "claude",
            "phase": "ready",
            "session_id": sessionId,
            "cwd": "/tmp/termloop-missing-transcript"
        ])

        guard case .ok = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }

        XCTAssertNil(store.persistedAgentSession(for: wsId))
        XCTAssertTrue(store.shouldDeferObservedAgentSessionPersistenceUntilPrompt(forWorkspaceId: wsId))
        XCTAssertEqual(TerminalAgentActivityStore.shared.state(forWorkspaceId: wsId)?.sessionId, sessionId)
    }

    func testDeferredClaudePromptActivityPersistsSession() {
        let store = WorkspaceMetadataStore.shared
        let wsId = UUID()
        let sessionId = "termloop-test-prompt-\(UUID().uuidString)"
        defer {
            store.setTerminalAgentId(nil, for: wsId)
            store.clearPersistedAgentSession(for: wsId)
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
        }

        store.setTerminalAgentId("claude", for: wsId)
        store.setDeferObservedAgentSessionPersistenceUntilPrompt(true, forWorkspaceId: wsId)

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "claude",
            "phase": "running",
            "user_prompt_submitted": true,
            "session_id": sessionId,
            "cwd": "/tmp/termloop-prompt-transcript"
        ])

        guard case .ok = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }

        XCTAssertEqual(store.persistedAgentSession(for: wsId)?.sessionId, sessionId)
        XCTAssertFalse(store.shouldDeferObservedAgentSessionPersistenceUntilPrompt(forWorkspaceId: wsId))
        XCTAssertEqual(TerminalAgentActivityStore.shared.state(forWorkspaceId: wsId)?.sessionId, sessionId)
    }

    func testReportAgentActivityWithoutTrustedSessionDoesNotAdoptWorkspaceAgent() {
        let store = WorkspaceMetadataStore.shared
        let wsId = UUID()
        defer {
            store.setTerminalAgentId(nil, for: wsId)
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
        }

        store.setTerminalAgentId("claude", for: wsId)

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "codex",
            "phase": "failed",
            "message_preview": "Codex restore failed"
        ])

        guard case .ok = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }

        XCTAssertEqual(store.terminalAgentId(for: wsId), "claude")
        XCTAssertNil(store.persistedAgentSession(for: wsId))
    }

    func testReportAgentActivityRunningClearsWaitingAndPublishesResumed() {
        let store = WorkspaceMetadataStore.shared
        let activityStore = TerminalAgentActivityStore.shared
        let wsId = UUID()
        defer {
            store.clearAttentionState(forWorkspaceId: wsId)
            activityStore.clear(workspaceId: wsId)
        }

        _ = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "codex",
            "phase": "waiting",
            "attention_kind": "completion",
            "message_preview": "Done"
        ])

        var receivedEvent: EventBus.Event?
        let handle = EventBus.shared.subscribe(
            types: ["workspace.resumed"],
            workspaceIds: [wsId]
        ) { event in
            receivedEvent = event
        }
        defer { EventBus.shared.unsubscribe(handle) }

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "codex",
            "phase": "running",
            "pid": 5151
        ])

        guard case .ok = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }
        XCTAssertEqual(activityStore.state(forWorkspaceId: wsId)?.phase, .running)
        XCTAssertNil(store.metadata(forWorkspaceId: wsId).awaitingInputSince)
        XCTAssertEqual(receivedEvent?.payload["agent_id"] as? String, "codex")
        XCTAssertNotNil(receivedEvent?.payload["at"] as? Int)
    }

    func testDisplayStateMapsWaitingKindsConsistently() {
        XCTAssertEqual(
            TerminalAgentPresentationReducer.mapDisplayState(phase: .waiting, attentionKind: .completion),
            .completed
        )
        XCTAssertEqual(
            TerminalAgentPresentationReducer.mapDisplayState(phase: .waiting, attentionKind: .notification),
            .needsInput
        )
        XCTAssertEqual(
            TerminalAgentPresentationReducer.mapDisplayState(phase: .waiting, attentionKind: .permission),
            .needsInput
        )
        XCTAssertEqual(
            TerminalAgentPresentationReducer.mapDisplayState(phase: .waiting, attentionKind: .error),
            .error
        )
    }

    func testDisplayStateFallsBackFromWorkspaceMetadataAndStatusEntry() {
        let store = WorkspaceMetadataStore.shared
        let workspace = Workspace(title: "Resolver")
        let wsId = workspace.id

        defer {
            store.clearAttentionState(forWorkspaceId: wsId)
            WorkspaceMetadataStore.shared.setTerminalAgentId(nil, for: wsId)
            workspace.statusEntries.removeAll()
        }

        store.setAwaitingInputSince(1712345678, forWorkspaceId: wsId)
        XCTAssertEqual(TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id), .needsInput)

        store.clearAttentionState(forWorkspaceId: wsId)
        WorkspaceMetadataStore.shared.setTerminalAgentId("codex", for: wsId)
        workspace.statusEntries["codex"] = SidebarStatusEntry(
            key: "codex",
            value: "Completed",
            icon: "checkmark.circle.fill",
            color: "#2FBF71"
        )
        XCTAssertEqual(TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id), .completed)
    }

    func testDisplayStateIgnoresRunningStatusEntryWithoutLiveActivity() {
        let workspace = Workspace(title: "Running fallback")
        let wsId = workspace.id

        defer {
            WorkspaceMetadataStore.shared.setTerminalAgentId(nil, for: wsId)
            workspace.statusEntries.removeAll()
        }

        WorkspaceMetadataStore.shared.setTerminalAgentId("claude", for: wsId)
        workspace.statusEntries["claude"] = SidebarStatusEntry(
            key: "claude",
            value: "Running",
            icon: "bolt.fill",
            color: "#4C8DFF"
        )

        XCTAssertEqual(TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id), .idle)
        XCTAssertFalse(TerminalAgentActivityStore.shared.isAgentRunning(forWorkspace: workspace, agentId: "claude"))
    }

    func testMetadataOnlyCompletedDoesNotCountAsLiveVisibleActivity() {
        let workspace = Workspace(title: "Stale completed")
        let wsId = workspace.id

        defer {
            WorkspaceMetadataStore.shared.clearAttentionState(forWorkspaceId: wsId)
            WorkspaceMetadataStore.shared.setTerminalAgentId(nil, for: wsId)
            workspace.statusEntries.removeAll()
        }

        WorkspaceMetadataStore.shared.setTerminalAgentId("codex", for: wsId)
        WorkspaceMetadataStore.shared.setAttentionState(
            since: 1_712_345_678,
            preview: "Completed before restart",
            attentionKind: .completion,
            forWorkspaceId: wsId
        )
        workspace.statusEntries["codex"] = SidebarStatusEntry(
            key: "codex",
            value: "Completed",
            icon: "checkmark.circle.fill",
            color: "#2FBF71"
        )

        drainAgentPresentation()
        XCTAssertEqual(TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id), .completed)
        XCTAssertFalse(TerminalAgentActivityStore.shared.hasLiveVisibleActivity(forWorkspace: workspace))
        XCTAssertFalse(TerminalAgentActivityStore.shared.shouldAppearInActiveAgentsPanel(forWorkspace: workspace))
    }

    func testPendingRestoreAppearsInActiveAgentsPanelBeforeLiveActivityArrives() {
        let workspace = Workspace(title: "Pending restore")
        let wsId = workspace.id

        defer {
            WorkspaceMetadataStore.shared.clearAttentionState(forWorkspaceId: wsId)
            WorkspaceMetadataStore.shared.clearPersistedAgentSession(for: wsId)
            WorkspaceMetadataStore.shared.setTerminalAgentId(nil, for: wsId)
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
            workspace.statusEntries.removeAll()
        }

        WorkspaceMetadataStore.shared.setTerminalAgentId("codex", for: wsId)
        WorkspaceMetadataStore.shared.setPersistedAgentSession(
            agentId: "codex",
            sessionId: "codex-session-restore",
            cwd: "/tmp/restored",
            for: wsId
        )
        WorkspaceMetadataStore.shared.setAttentionState(
            since: 1_712_345_678,
            preview: "Completed before restart",
            attentionKind: .completion,
            forWorkspaceId: wsId
        )
        workspace.statusEntries["codex"] = SidebarStatusEntry(
            key: "codex",
            value: "Completed",
            icon: "checkmark.circle.fill",
            color: "#2FBF71"
        )

        TerminalAgentActivityStore.shared.markPendingRestore(workspaceId: wsId)

        drainAgentPresentation()
        XCTAssertFalse(TerminalAgentActivityStore.shared.hasLiveVisibleActivity(forWorkspace: workspace))
        XCTAssertTrue(TerminalAgentActivityStore.shared.shouldAppearInActiveAgentsPanel(forWorkspace: workspace))
    }

    func testReadyRestorePreservesPersistedCompletedStateUntilNewActivityArrives() {
        let store = WorkspaceMetadataStore.shared
        let workspace = Workspace(title: "Restored")
        let wsId = workspace.id

        defer {
            store.clearAttentionState(forWorkspaceId: wsId)
            store.clearPersistedAgentSession(for: wsId)
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
        }

        store.setPersistedAgentSession(
            agentId: "codex",
            sessionId: "codex-session-1",
            cwd: "/tmp/restored",
            for: wsId
        )
        store.setAttentionState(
            since: 1_712_345_678,
            preview: "Review needed",
            attentionKind: .completion,
            forWorkspaceId: wsId
        )

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "codex",
            "phase": "ready",
            "session_id": "codex-session-1",
            "cwd": "/tmp/restored",
            "pid": 7373
        ])

        guard case .ok = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }

        drainAgentPresentation()
        XCTAssertEqual(
            TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id),
            .completed
        )
        XCTAssertEqual(
            Int(TerminalAgentActivityStore.shared.latestActivityDate(forWorkspaceId: workspace.id)?
                .timeIntervalSince1970 ?? 0),
            1_712_345_678
        )
    }

    func testPendingNativeCodexForkIgnoresParentSessionActivityUntilChildArrives() {
        let store = WorkspaceMetadataStore.shared
        let workspace = Workspace(title: "Forking")
        let wsId = workspace.id

        defer {
            store.clearPendingNativeFork(forWorkspaceId: wsId)
            store.clearPersistedAgentSession(for: wsId)
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
        }

        store.beginPendingNativeFork(
            agentId: "codex",
            parentSessionId: "parent-session",
            forWorkspaceId: wsId
        )

        let parentResult = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "codex",
            "phase": "running",
            "session_id": "parent-session",
            "cwd": "/tmp/forked"
        ])

        guard case .ok = parentResult else {
            XCTFail("Expected .ok result, got \(parentResult)")
            return
        }

        XCTAssertNil(store.persistedAgentSession(for: wsId))
        XCTAssertNil(TerminalAgentActivityStore.shared.state(forWorkspaceId: wsId)?.sessionId)
        XCTAssertNotNil(store.pendingNativeFork(forWorkspaceId: wsId))

        let childResult = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "codex",
            "phase": "running",
            "session_id": "child-session",
            "cwd": "/tmp/forked"
        ])

        guard case .ok = childResult else {
            XCTFail("Expected .ok result, got \(childResult)")
            return
        }

        drainAgentPresentation()
        XCTAssertEqual(store.persistedAgentSession(for: wsId)?.sessionId, "child-session")
        XCTAssertEqual(TerminalAgentActivityStore.shared.state(forWorkspaceId: wsId)?.sessionId, "child-session")
        XCTAssertNil(store.pendingNativeFork(forWorkspaceId: wsId))
    }

    func testLivePreferredDisplayStateUsesReadyOverStickyCompletedFallback() {
        let store = WorkspaceMetadataStore.shared
        let workspace = Workspace(title: "Worktree restored")
        let wsId = workspace.id

        defer {
            store.clearAttentionState(forWorkspaceId: wsId)
            store.clearPersistedAgentSession(for: wsId)
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
        }

        store.setPersistedAgentSession(
            agentId: "codex",
            sessionId: "codex-session-1",
            cwd: "/tmp/restored",
            for: wsId
        )
        store.setAttentionState(
            since: 1_712_345_678,
            preview: "Completed before restart",
            attentionKind: .completion,
            forWorkspaceId: wsId
        )
        TerminalAgentActivityStore.shared.upsert(
            workspaceId: wsId,
            agentId: "codex",
            phase: .ready,
            attentionKind: nil,
            preview: nil,
            waitingSince: nil,
            sessionId: "codex-session-1",
            cwd: "/tmp/restored",
            pid: nil
        )

        drainAgentPresentation()
        XCTAssertEqual(TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id), .completed)
        XCTAssertEqual(TerminalAgentActivityStore.shared.livePreferredDisplayState(forWorkspace: workspace), .ready)
    }

    func testLivePreferredDisplayStateUsesTrackedAgentPidOverStickyCompletedFallback() {
        let store = WorkspaceMetadataStore.shared
        let workspace = Workspace(title: "Tracked worktree agent")
        let wsId = workspace.id

        defer {
            store.clearAttentionState(forWorkspaceId: wsId)
            store.setTerminalAgentId(nil, for: wsId)
            workspace.statusEntries.removeAll()
            workspace.agentPIDs.removeAll()
        }

        store.setTerminalAgentId("codex", for: wsId)
        store.setAttentionState(
            since: 1_712_345_678,
            preview: "Completed before restart",
            attentionKind: .completion,
            forWorkspaceId: wsId
        )
        workspace.statusEntries["codex"] = SidebarStatusEntry(
            key: "codex",
            value: "Completed",
            icon: "checkmark.circle.fill",
            color: "#2FBF71"
        )
        workspace.agentPIDs["codex"] = getpid()

        drainAgentPresentation()
        XCTAssertEqual(TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id), .completed)
        XCTAssertEqual(TerminalAgentActivityStore.shared.livePreferredDisplayState(forWorkspace: workspace), .ready)
    }

    func testDisplayStateDowngradesStaleRunningActivityWhenPidStillAlive() {
        let workspace = Workspace(title: "Stale running")
        let wsId = workspace.id

        defer {
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
        }

        TerminalAgentActivityStore.shared.replaceForTesting([
            wsId: TerminalAgentActivityState(
                workspaceId: wsId,
                agentId: "claude",
                phase: .running,
                attentionKind: nil,
                preview: nil,
                waitingSince: nil,
                sessionId: "claude-session-1",
                cwd: "/tmp/claude",
                pid: getpid(),
                startedAt: Date().addingTimeInterval(-180),
                updatedAt: Date().addingTimeInterval(-180)
            )
        ])

        drainAgentPresentation()
        XCTAssertEqual(TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id), .ready)
        XCTAssertFalse(TerminalAgentActivityStore.shared.isAgentRunning(forWorkspace: workspace, agentId: "claude"))
    }

    func testPendingLaunchShowsReadyUntilFirstAgentActivity() {
        let store = WorkspaceMetadataStore.shared
        let workspace = Workspace(title: "Pending launch")
        let wsId = workspace.id

        defer {
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
            store.setTerminalAgentId(nil, for: wsId)
        }

        store.setTerminalAgentId("codex", for: wsId)
        TerminalAgentActivityStore.shared.markPendingRestore(workspaceId: wsId)

        drainAgentPresentation()
        XCTAssertEqual(TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id), .ready)
        XCTAssertEqual(TerminalAgentActivityStore.shared.livePreferredDisplayState(forWorkspace: workspace), .ready)
    }

    func testPendingPromptLaunchShowsRunningUntilFirstAgentActivity() {
        let store = WorkspaceMetadataStore.shared
        let workspace = Workspace(title: "Pending prompt launch")
        let wsId = workspace.id

        defer {
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
            store.setTerminalAgentId(nil, for: wsId)
        }

        store.setTerminalAgentId("codex", for: wsId)
        TerminalAgentActivityStore.shared.markPendingRestore(
            workspaceId: wsId,
            state: .running
        )

        drainAgentPresentation()
        XCTAssertEqual(TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id), .running)
        XCTAssertEqual(TerminalAgentActivityStore.shared.livePreferredDisplayState(forWorkspace: workspace), .running)
    }

    func testFailedAgentActivitySurfacesErrorState() {
        let workspace = Workspace(title: "Restore failure")
        let wsId = workspace.id

        defer {
            WorkspaceMetadataStore.shared.clearPersistedAgentSession(for: wsId)
            TerminalAgentActivityStore.shared.clear(workspaceId: wsId)
        }

        let result = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "claude",
            "phase": "failed",
            "message_preview": "Claude resume failed: session file missing",
            "session_id": "claude-session-1",
            "cwd": "/tmp/claude"
        ])

        guard case .ok = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }

        drainAgentPresentation()
        XCTAssertEqual(
            TerminalAgentActivityStore.shared.displayState(forWorkspaceId: workspace.id),
            .error
        )
        XCTAssertEqual(
            TerminalAgentActivityStore.shared.state(forWorkspaceId: wsId)?.preview,
            "Claude resume failed: session file missing"
        )
    }

    func testActiveAgentIdFallsBackFromStatusEntry() {
        let workspace = Workspace(title: "Resolver")
        let wsId = workspace.id

        defer {
            WorkspaceMetadataStore.shared.setTerminalAgentId(nil, for: wsId)
            workspace.statusEntries.removeAll()
        }

        workspace.statusEntries["codex"] = SidebarStatusEntry(
            key: "codex",
            value: "Completed",
            icon: "checkmark.circle.fill",
            color: "#2FBF71"
        )

        XCTAssertEqual(TerminalAgentActivityStore.shared.activeAgentId(forWorkspace: workspace), "codex")
    }

    func testClearAgentActivityClearsStore() {
        let store = WorkspaceMetadataStore.shared
        let activityStore = TerminalAgentActivityStore.shared
        let wsId = UUID()
        defer {
            store.clearAttentionState(forWorkspaceId: wsId)
            activityStore.clear(workspaceId: wsId)
        }

        _ = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": wsId.uuidString,
            "agent_id": "codex",
            "phase": "waiting",
            "attention_kind": "completion",
            "message_preview": "Done"
        ])

        let result = TermLoopSocketCommands.workspaceClearAgentActivity([
            "workspace_id": wsId.uuidString
        ])

        guard case .ok = result else {
            XCTFail("Expected .ok result, got \(result)")
            return
        }
        XCTAssertNil(activityStore.state(forWorkspaceId: wsId))
        XCTAssertNil(store.metadata(forWorkspaceId: wsId).awaitingInputSince)
    }

}

@MainActor
final class PushDispatcherTests: XCTestCase {
    private let awayIdle: TimeInterval = 120  // > 60s threshold = "away"
    private let activeIdle: TimeInterval = 5  // < 60s threshold = "at Mac"

    func testPushSuppressedForFocusedWorkspace() {
        let workspaceId = UUID()

        XCTAssertTrue(
            PushDispatcher.shouldSuppressPushDelivery(
                workspaceId: workspaceId,
                isAppFocused: true,
                selectedWorkspaceId: workspaceId,
                userIdleSeconds: awayIdle,
                isScreenLocked: false,
                attentionKind: .completion
            )
        )
        XCTAssertFalse(
            PushDispatcher.shouldSuppressPushDelivery(
                workspaceId: workspaceId,
                isAppFocused: false,
                selectedWorkspaceId: workspaceId,
                userIdleSeconds: awayIdle,
                isScreenLocked: false,
                attentionKind: .completion
            )
        )
        XCTAssertFalse(
            PushDispatcher.shouldSuppressPushDelivery(
                workspaceId: workspaceId,
                isAppFocused: true,
                selectedWorkspaceId: UUID(),
                userIdleSeconds: awayIdle,
                isScreenLocked: false,
                attentionKind: .completion
            )
        )
    }

    func testPushSuppressedWhenUserActiveAtMac() {
        let workspaceId = UUID()

        XCTAssertTrue(
            PushDispatcher.shouldSuppressPushDelivery(
                workspaceId: workspaceId,
                isAppFocused: false,
                selectedWorkspaceId: nil,
                userIdleSeconds: activeIdle,
                isScreenLocked: false,
                attentionKind: .completion
            )
        )
        XCTAssertTrue(
            PushDispatcher.shouldSuppressPushDelivery(
                workspaceId: workspaceId,
                isAppFocused: false,
                selectedWorkspaceId: nil,
                userIdleSeconds: activeIdle,
                isScreenLocked: false,
                attentionKind: .notification
            )
        )
    }

    func testPushDeliveredWhenUserActiveButAttentionUrgent() {
        let workspaceId = UUID()

        XCTAssertFalse(
            PushDispatcher.shouldSuppressPushDelivery(
                workspaceId: workspaceId,
                isAppFocused: false,
                selectedWorkspaceId: nil,
                userIdleSeconds: activeIdle,
                isScreenLocked: false,
                attentionKind: .permission
            )
        )
        XCTAssertFalse(
            PushDispatcher.shouldSuppressPushDelivery(
                workspaceId: workspaceId,
                isAppFocused: false,
                selectedWorkspaceId: nil,
                userIdleSeconds: activeIdle,
                isScreenLocked: false,
                attentionKind: .error
            )
        )
    }

    func testPushDeliveredWhenScreenLockedRegardlessOfIdle() {
        let workspaceId = UUID()

        XCTAssertFalse(
            PushDispatcher.shouldSuppressPushDelivery(
                workspaceId: workspaceId,
                isAppFocused: true,
                selectedWorkspaceId: workspaceId,
                userIdleSeconds: activeIdle,
                isScreenLocked: true,
                attentionKind: .completion
            )
        )
    }

    func testPushDeliveredWhenUserIdleBeyondThreshold() {
        let workspaceId = UUID()

        XCTAssertFalse(
            PushDispatcher.shouldSuppressPushDelivery(
                workspaceId: workspaceId,
                isAppFocused: false,
                selectedWorkspaceId: nil,
                userIdleSeconds: awayIdle,
                isScreenLocked: false,
                attentionKind: .completion
            )
        )
    }

    func testPushCooldownAppliesToCompletionStyleAttention() {
        XCTAssertTrue(PushDispatcher.shouldApplyCooldown(attentionKind: .completion))
        XCTAssertTrue(PushDispatcher.shouldApplyCooldown(attentionKind: .notification))
        XCTAssertTrue(PushDispatcher.shouldApplyCooldown(attentionKind: nil))
    }

    func testPushCooldownBypassesUrgentAttention() {
        XCTAssertFalse(PushDispatcher.shouldApplyCooldown(attentionKind: .permission))
        XCTAssertFalse(PushDispatcher.shouldApplyCooldown(attentionKind: .error))
    }
}
