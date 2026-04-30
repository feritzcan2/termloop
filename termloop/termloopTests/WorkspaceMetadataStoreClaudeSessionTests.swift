import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class WorkspaceMetadataStoreClaudeSessionTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        let store = WorkspaceMetadataStore.shared
        for key in Array(store.ephemeralClaudeSessions.keys) {
            store.clearClaudeSession(workspaceId: key)
        }
    }

    func testSetAndGetClaudeSession() throws {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID().uuidString
        store.setClaudeSession(workspaceId: workspaceId, sessionId: "abc-123", cwd: "/tmp/x")

        let session = store.claudeSession(workspaceId: workspaceId)
        XCTAssertEqual(session?.sessionId, "abc-123")
        XCTAssertEqual(session?.cwd, "/tmp/x")
    }

    func testSetClaudeSessionOverwritesExisting() throws {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID().uuidString
        store.setClaudeSession(workspaceId: workspaceId, sessionId: "first", cwd: nil)
        store.setClaudeSession(workspaceId: workspaceId, sessionId: "second", cwd: "/x")

        let session = store.claudeSession(workspaceId: workspaceId)
        XCTAssertEqual(session?.sessionId, "second")
        XCTAssertEqual(session?.cwd, "/x")
    }

    func testClearClaudeSessionRemovesEntry() throws {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID().uuidString
        store.setClaudeSession(workspaceId: workspaceId, sessionId: "abc", cwd: nil)
        store.clearClaudeSession(workspaceId: workspaceId)

        XCTAssertNil(store.claudeSession(workspaceId: workspaceId))
    }

    func testClearMissingWorkspaceIsNoOp() throws {
        WorkspaceMetadataStore.shared.clearClaudeSession(workspaceId: UUID().uuidString)
    }

    func testClaudeSessionMissingWorkspaceReturnsNil() throws {
        XCTAssertNil(WorkspaceMetadataStore.shared.claudeSession(workspaceId: UUID().uuidString))
    }

    func testEmptyWorkspaceIdRejected() throws {
        let store = WorkspaceMetadataStore.shared
        store.setClaudeSession(workspaceId: "  ", sessionId: "x", cwd: nil)
        XCTAssertTrue(store.ephemeralClaudeSessions.isEmpty)
    }

    func testSetPersistedAgentSessionStoresCodexSession() throws {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()

        let changed = store.setPersistedAgentSession(
            agentId: "codex",
            sessionId: "codex-session-1",
            cwd: "/tmp/codex",
            for: workspaceId
        )

        let session = store.persistedAgentSession(for: workspaceId)
        XCTAssertTrue(changed)
        XCTAssertEqual(session?.agentId, "codex")
        XCTAssertEqual(session?.sessionId, "codex-session-1")
        XCTAssertEqual(session?.cwd, "/tmp/codex")
    }

    func testClearPersistedAgentSessionRemovesStoredSession() throws {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()

        store.setPersistedAgentSession(
            agentId: "claude",
            sessionId: "dead-sid",
            cwd: "/tmp/worktree",
            for: workspaceId
        )

        let changed = store.clearPersistedAgentSession(for: workspaceId)

        XCTAssertTrue(changed)
        XCTAssertNil(store.persistedAgentSession(for: workspaceId))
    }

    func testRestoreClearsEphemeralClaudeReverseIndex() throws {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID().uuidString
        store.setClaudeSession(workspaceId: workspaceId, sessionId: "claude-sid", cwd: "/tmp/x")

        XCTAssertNotNil(store.workspaceIdForClaudeSession(sessionId: "claude-sid"))

        store.restore([:])

        XCTAssertTrue(store.ephemeralClaudeSessions.isEmpty)
        XCTAssertNil(store.workspaceIdForClaudeSession(sessionId: "claude-sid"))
    }

    func testPendingNativeForkIgnoresParentSessionUntilChildArrives() throws {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()

        store.beginPendingNativeFork(
            agentId: "codex",
            parentSessionId: "parent-session",
            forWorkspaceId: workspaceId
        )

        XCTAssertNil(
            store.acceptedObservedSessionId(
                agentId: "codex",
                sessionId: "parent-session",
                forWorkspaceId: workspaceId
            )
        )
        XCTAssertEqual(
            store.pendingNativeFork(forWorkspaceId: workspaceId)?.parentSessionId,
            "parent-session"
        )
        XCTAssertEqual(
            store.acceptedObservedSessionId(
                agentId: "codex",
                sessionId: "child-session",
                forWorkspaceId: workspaceId
            ),
            "child-session"
        )
        XCTAssertNil(store.pendingNativeFork(forWorkspaceId: workspaceId))
    }

    func testRestoreClearsPendingNativeForkState() throws {
        let store = WorkspaceMetadataStore.shared
        let workspaceId = UUID()

        store.beginPendingNativeFork(
            agentId: "claude",
            parentSessionId: "parent-session",
            forWorkspaceId: workspaceId
        )
        XCTAssertNotNil(store.pendingNativeFork(forWorkspaceId: workspaceId))

        store.restore([:])

        XCTAssertNil(store.pendingNativeFork(forWorkspaceId: workspaceId))
    }
}
