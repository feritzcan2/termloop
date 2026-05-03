import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

/// Regression coverage for the "workspaces come back blank after relaunch"
/// bug: `SessionWorkspaceSnapshot` does not persist workspace UUIDs, so the
/// v1 UUID-keyed `WorkspaceMetadataStore.restore(_:)` could never rehydrate.
/// The sidecar now persists metadata positionally and
/// `TermLoopHooks.didRestoreWorkspaces(workspaces:)` stamps each restored
/// workspace by its index within the window.
@MainActor
final class TermLoopSidecarPositionalRestoreTests: XCTestCase {
    private var originalRestoredTerminalLauncher:
        ((Workspace, TerminalAgent, String?, [String: String]) -> Void)?

    override func setUp() async throws {
        try await super.setUp()
        let store = WorkspaceMetadataStore.shared
        store.restore([:])
        for key in Array(store.ephemeralClaudeSessions.keys) {
            store.clearClaudeSession(workspaceId: key)
        }
        originalRestoredTerminalLauncher = TermLoopHooks.restoredTerminalLauncher
        TermLoopHooks.restoredTerminalLauncher = { workspace, agent, cwd, env in
            _ = TerminalAgentLifecycle.launchInExistingWorkspace(
                in: workspace,
                agent: agent,
                cwd: cwd,
                env: env
            )
        }
    }

    override func tearDown() async throws {
        if let originalRestoredTerminalLauncher {
            TermLoopHooks.restoredTerminalLauncher = originalRestoredTerminalLauncher
        }
        try await super.tearDown()
    }

    func testSnapshotV2PositionalMetadataRoundTripsThroughJSON() throws {
        let projectA = UUID()
        let snapshot = TermLoopSessionSnapshot(
            version: 2,
            projects: [],
            activeProjectId: nil,
            openProjectIds: [],
            workspaceMetadataByPosition: [
                [
                    WorkspaceMetadataStore.Metadata(projectId: projectA, branch: "feature/a"),
                    WorkspaceMetadataStore.Metadata(projectId: projectA, branch: nil)
                ],
                [
                    WorkspaceMetadataStore.Metadata(projectId: projectA, branch: "feature/b")
                ]
            ]
        )

        let data = try JSONEncoder().encode(snapshot)
        let decoded = try JSONDecoder().decode(TermLoopSessionSnapshot.self, from: data)

        XCTAssertEqual(decoded.version, 2)
        XCTAssertEqual(decoded.workspaceMetadataByPosition?.count, 2)
        XCTAssertEqual(decoded.workspaceMetadataByPosition?[0].count, 2)
        XCTAssertEqual(decoded.workspaceMetadataByPosition?[0][0].projectId, projectA)
        XCTAssertEqual(decoded.workspaceMetadataByPosition?[0][0].branch, "feature/a")
        XCTAssertEqual(decoded.workspaceMetadataByPosition?[0][1].branch, nil)
        XCTAssertEqual(decoded.workspaceMetadataByPosition?[1][0].branch, "feature/b")
    }

    func testHiddenWorkspaceMetadataRoundTripsThroughJSON() throws {
        let hiddenId = UUID()
        let projectId = UUID()
        let metadata = WorkspaceMetadataStore.Metadata(
            projectId: projectId,
            branch: "feature/collapsed",
            terminalAgentId: "codex",
            persistedAgentSession: PersistedAgentSession(
                agentId: "codex",
                sessionId: "hidden-session",
                cwd: "/tmp/collapsed",
                updatedAt: nil
            ),
            collapsedDisplayTitle: "Collapsed Codex",
            isHidden: true
        )
        let snapshot = TermLoopSessionSnapshot(
            workspaceMetadataByPosition: [],
            hiddenWorkspaceMetadataById: [hiddenId.uuidString: metadata]
        )

        let data = try JSONEncoder().encode(snapshot)
        let decoded = try JSONDecoder().decode(TermLoopSessionSnapshot.self, from: data)

        let restored = decoded.hiddenWorkspaceMetadataById?[hiddenId.uuidString]
        XCTAssertEqual(restored?.projectId, projectId)
        XCTAssertEqual(restored?.branch, "feature/collapsed")
        XCTAssertEqual(restored?.terminalAgentId, "codex")
        XCTAssertEqual(restored?.persistedAgentSession?.sessionId, "hidden-session")
        XCTAssertEqual(restored?.collapsedDisplayTitle, "Collapsed Codex")
        XCTAssertEqual(restored?.isHidden, true)
    }

    func testLegacyV1SidecarWithoutPositionalDecodesAsEmpty() throws {
        let legacyJSON = """
        {
          "version": 1,
          "projects": [],
          "openProjectIds": [],
          "features": [],
          "workspaceMetadata": {
            "DEADBEEF-DEAD-BEEF-DEAD-BEEFDEADBEEF": {
              "projectId": "CAFECAFE-CAFE-CAFE-CAFE-CAFECAFECAFE"
            }
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(TermLoopSessionSnapshot.self, from: legacyJSON)

        XCTAssertEqual(decoded.version, 1)
        XCTAssertNil(decoded.workspaceMetadataByPosition)
    }

    func testLegacySidecarWithoutFoldersKeyDecodesWithEmptyFolders() throws {
        let legacyJSON = """
        {
          "version": 3,
          "projects": [],
          "openProjectIds": [],
          "workspaceMetadata": {},
          "workspaceMetadataByPosition": []
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(TermLoopSessionSnapshot.self, from: legacyJSON)

        XCTAssertEqual(decoded.version, 3)
        XCTAssertEqual(decoded.openProjectIds, [])
        XCTAssertEqual(decoded.workspaceMetadataByPosition, [])
    }

    func testLoadSidecarStampsRestoredWorkspacesByPosition() throws {
        let projectA = UUID()

        let sessionURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-sidecar-test-\(UUID().uuidString).json")
        defer {
            let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
            try? FileManager.default.removeItem(at: sidecarURL)
        }

        let snapshot = TermLoopSessionSnapshot(
            version: 2,
            projects: [],
            activeProjectId: nil,
            openProjectIds: [],
            workspaceMetadataByPosition: [
                [
                    WorkspaceMetadataStore.Metadata(projectId: projectA),
                    WorkspaceMetadataStore.Metadata(projectId: projectA)
                ]
            ]
        )

        let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
        let data = try JSONEncoder().encode(snapshot)
        try data.write(to: sidecarURL, options: .atomic)

        TermLoopHooks.loadSidecarSnapshot(alongside: sessionURL, onStoreMutation: {})
        let ws0 = Workspace(title: "restored-0")
        let ws1 = Workspace(title: "restored-1")

        XCTAssertNil(ws0.projectId, "workspace should start without metadata stamp")
        XCTAssertNil(ws1.projectId)

        TermLoopHooks.didRestoreWorkspaces(workspaces: [ws0, ws1])

        XCTAssertEqual(ws0.projectId, projectA)
        XCTAssertEqual(ws1.projectId, projectA)
    }

    func testLoadSidecarRestoresHiddenWorkspaceMetadataWithoutOpenTab() throws {
        let hiddenId = UUID()
        let projectId = UUID()
        let sessionURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-sidecar-test-\(UUID().uuidString).json")
        defer {
            let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
            try? FileManager.default.removeItem(at: sidecarURL)
        }

        let snapshot = TermLoopSessionSnapshot(
            workspaceMetadataByPosition: [],
            hiddenWorkspaceMetadataById: [
                hiddenId.uuidString: WorkspaceMetadataStore.Metadata(
                    projectId: projectId,
                    branch: "feature/collapsed-worktree",
                    terminalAgentId: "codex",
                    persistedAgentSession: PersistedAgentSession(
                        agentId: "codex",
                        sessionId: "collapsed-session",
                        cwd: "/tmp/collapsed-worktree",
                        updatedAt: nil
                    ),
                    collapsedDisplayTitle: "Collapsed Worktree",
                    isHidden: true
                )
            ]
        )

        let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
        try JSONEncoder().encode(snapshot).write(to: sidecarURL, options: .atomic)

        TermLoopHooks.loadSidecarSnapshot(alongside: sessionURL, onStoreMutation: {})

        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: hiddenId)
        XCTAssertEqual(metadata.isHidden, true)
        XCTAssertEqual(metadata.projectId, projectId)
        XCTAssertEqual(metadata.branch, "feature/collapsed-worktree")
        XCTAssertEqual(metadata.persistedAgentSession?.sessionId, "collapsed-session")
        XCTAssertEqual(metadata.collapsedDisplayTitle, "Collapsed Worktree")

        let summaries = WorkspaceHideCoordinator.hiddenSummaries()
        XCTAssertTrue(summaries.contains { $0.id == hiddenId })
    }

    func testDidRestoreWorkspacesRestoresFullMetadataPayload() throws {
        let workspace = Workspace(title: "restored")
        let sessionURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-sidecar-test-\(UUID().uuidString).json")
        defer {
            let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
            try? FileManager.default.removeItem(at: sidecarURL)
        }

        let snapshot = TermLoopSessionSnapshot(
            version: 4,
            projects: [],
            activeProjectId: nil,
            openProjectIds: [],
            workspaceMetadataByPosition: [[
                WorkspaceMetadataStore.Metadata(
                    projectId: UUID(),
                    branch: "feature/test",
                    worktreeBaselineHead: "abc123",
                    suppressAgentsOnClose: true,
                    terminalAgentId: "claude",
                    permissionMode: "plan",
                    persistedAgentSession: PersistedAgentSession(
                        agentId: "claude",
                        sessionId: "claude-session-1",
                        cwd: "/tmp/test",
                        updatedAt: nil
                    ),
                    awaitingInputSince: 1_712_345_678,
                    lastMessagePreview: "Need a reply",
                    lastAttentionKindRaw: TerminalAgentAttentionKind.completion.rawValue
                )
            ]]
        )

        let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
        try JSONEncoder().encode(snapshot).write(to: sidecarURL, options: .atomic)
        TermLoopHooks.loadSidecarSnapshot(alongside: sessionURL, onStoreMutation: {})
        TermLoopHooks.didRestoreWorkspaces(workspaces: [workspace])

        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspace.id)
        XCTAssertEqual(metadata.branch, "feature/test")
        XCTAssertEqual(metadata.worktreeBaselineHead, "abc123")
        XCTAssertEqual(metadata.suppressAgentsOnClose, true)
        XCTAssertEqual(metadata.permissionMode, "plan")
        XCTAssertEqual(metadata.awaitingInputSince, 1_712_345_678)
        XCTAssertEqual(metadata.lastMessagePreview, "Need a reply")
        XCTAssertEqual(metadata.lastAttentionKindRaw, TerminalAgentAttentionKind.completion.rawValue)
        XCTAssertEqual(metadata.persistedAgentSession?.sessionId, "claude-session-1")
    }

    func testDidRestoreWorkspacesMatchesSameNamedAgentsByCurrentDirectoryBeforePosition() throws {
        let cwdA = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-restore-a-\(UUID().uuidString)").path
        let cwdB = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-restore-b-\(UUID().uuidString)").path
        let sessionURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-sidecar-test-\(UUID().uuidString).json")
        defer {
            let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
            try? FileManager.default.removeItem(at: sidecarURL)
        }

        let metadataA = WorkspaceMetadataStore.Metadata(
            terminalAgentId: "codex",
            persistedAgentSession: PersistedAgentSession(
                agentId: "codex",
                sessionId: "sess-a",
                cwd: cwdA,
                updatedAt: nil
            )
        )
        let metadataB = WorkspaceMetadataStore.Metadata(
            terminalAgentId: "codex",
            persistedAgentSession: PersistedAgentSession(
                agentId: "codex",
                sessionId: "sess-b",
                cwd: cwdB,
                updatedAt: nil
            )
        )

        let snapshot = TermLoopSessionSnapshot(
            version: 5,
            projects: [],
            activeProjectId: nil,
            openProjectIds: [],
            workspaceMetadataByPosition: [[metadataA, metadataB]],
            workspaceRestoreStampsByPosition: [[
                WorkspaceRestoreStamp(
                    metadata: metadataA,
                    processTitle: "Prompt Refactor",
                    customTitle: "Prompt Refactor",
                    currentDirectory: cwdA
                ),
                WorkspaceRestoreStamp(
                    metadata: metadataB,
                    processTitle: "Prompt Refactor",
                    customTitle: "Prompt Refactor",
                    currentDirectory: cwdB
                ),
            ]]
        )

        let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
        try JSONEncoder().encode(snapshot).write(to: sidecarURL, options: .atomic)
        TermLoopHooks.loadSidecarSnapshot(alongside: sessionURL, onStoreMutation: {})

        let restoredB = Workspace(title: "Prompt Refactor", workingDirectory: cwdB, portOrdinal: 0)
        let restoredA = Workspace(title: "Prompt Refactor", workingDirectory: cwdA, portOrdinal: 0)

        TermLoopHooks.didRestoreWorkspaces(workspaces: [restoredB, restoredA])

        XCTAssertEqual(
            WorkspaceMetadataStore.shared.persistedAgentSession(for: restoredB.id)?.sessionId,
            "sess-b"
        )
        XCTAssertEqual(
            WorkspaceMetadataStore.shared.persistedAgentSession(for: restoredA.id)?.sessionId,
            "sess-a"
        )
    }

    func testDidRestoreWorkspacesIsNoOpAfterQueueDrains() throws {
        let projectA = UUID()
        let sessionURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-sidecar-test-\(UUID().uuidString).json")
        defer {
            let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
            try? FileManager.default.removeItem(at: sidecarURL)
        }

        let snapshot = TermLoopSessionSnapshot(
            version: 2,
            projects: [],
            activeProjectId: nil,
            openProjectIds: [],
            workspaceMetadataByPosition: [
                [WorkspaceMetadataStore.Metadata(projectId: projectA)]
            ]
        )
        let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
        try JSONEncoder().encode(snapshot).write(to: sidecarURL, options: .atomic)
        TermLoopHooks.loadSidecarSnapshot(alongside: sessionURL, onStoreMutation: {})

        let first = Workspace(title: "first")
        TermLoopHooks.didRestoreWorkspaces(workspaces: [first])
        XCTAssertEqual(first.projectId, projectA)

        let second = Workspace(title: "second")
        TermLoopHooks.didRestoreWorkspaces(workspaces: [second])
        XCTAssertNil(second.projectId, "second call should no-op — queue is empty")
    }

    func testDidRestoreWorkspacesRelaunchesBoundTerminalAgent() throws {
        let cwd = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-restore-\(UUID().uuidString)").path
        let sessionURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-sidecar-test-\(UUID().uuidString).json")
        defer {
            let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
            try? FileManager.default.removeItem(at: sidecarURL)
        }

        let persistedSession = PersistedAgentSession(
            agentId: "codex",
            sessionId: "sess-123",
            cwd: cwd,
            updatedAt: nil
        )
        let snapshot = TermLoopSessionSnapshot(
            version: 4,
            projects: [],
            activeProjectId: nil,
            openProjectIds: [],
            workspaceMetadataByPosition: [[
                WorkspaceMetadataStore.Metadata(
                    projectId: nil,
                    branch: nil,
                    worktreeBaselineHead: nil,
                    suppressAgentsOnClose: nil,
                    terminalAgentId: "codex",
                    persistedAgentSession: persistedSession
                )
            ]]
        )
        let sidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
        try JSONEncoder().encode(snapshot).write(to: sidecarURL, options: .atomic)
        TermLoopHooks.loadSidecarSnapshot(alongside: sessionURL, onStoreMutation: {})

        var launches: [(agentId: String, cwd: String?, env: [String: String])] = []
        TermLoopHooks.restoredTerminalLauncher = { _, agent, cwd, env in
            launches.append((agent.id, cwd, env))
        }

        let workspace = Workspace(title: "codex", workingDirectory: cwd, portOrdinal: 0)
        TermLoopHooks.didRestoreWorkspaces(workspaces: [workspace])

        XCTAssertEqual(launches.count, 1)
        XCTAssertEqual(launches.first?.agentId, "codex")
        XCTAssertEqual(launches.first?.cwd, cwd)
        XCTAssertTrue(launches.first?.env.isEmpty == true)
        XCTAssertEqual(
            WorkspaceMetadataStore.shared.persistedAgentSession(for: workspace.id)?.sessionId,
            "sess-123"
        )
    }

    func testShouldLaunchRestoredTerminalAgentSkipsClaudeAutoRestore() {
        XCTAssertFalse(
            TermLoopHooks.shouldLaunchRestoredTerminalAgent(
                agentId: "claude",
                persistedSession: PersistedAgentSession(
                    agentId: "claude",
                    sessionId: "claude-sess",
                    cwd: "/tmp/claude",
                    updatedAt: nil
                )
            )
        )
        XCTAssertFalse(
            TermLoopHooks.shouldLaunchRestoredTerminalAgent(
                agentId: "claude",
                persistedSession: PersistedAgentSession(
                    agentId: "claude",
                    sessionId: "claude-sess",
                    cwd: "/tmp/claude",
                    updatedAt: nil
                )
            )
        )
        XCTAssertFalse(
            TermLoopHooks.shouldLaunchRestoredTerminalAgent(
                agentId: "codex",
                persistedSession: nil
            )
        )
        XCTAssertTrue(
            TermLoopHooks.shouldLaunchRestoredTerminalAgent(
                agentId: "codex",
                persistedSession: PersistedAgentSession(
                    agentId: "codex",
                    sessionId: "codex-sess",
                    cwd: "/tmp/codex",
                    updatedAt: nil
                )
            )
        )
        XCTAssertFalse(
            TermLoopHooks.shouldLaunchRestoredTerminalAgent(
                agentId: "codex",
                persistedSession: PersistedAgentSession(
                    agentId: "claude",
                    sessionId: "claude-sess",
                    cwd: "/tmp/claude",
                    updatedAt: nil
                )
            )
        )
    }
}
