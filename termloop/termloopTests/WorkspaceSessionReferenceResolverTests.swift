import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class WorkspaceSessionReferenceResolverTests: XCTestCase {
    private var tempProjectsDir: URL!

    override func setUpWithError() throws {
        tempProjectsDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-session-reference-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempProjectsDir,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        let metadata = WorkspaceMetadataStore.shared
        for key in Array(metadata.ephemeralClaudeSessions.keys) {
            metadata.clearClaudeSession(workspaceId: key)
        }
        TerminalAgentActivityStore.shared.replaceForTesting([:])
        try? FileManager.default.removeItem(at: tempProjectsDir)
    }

    func testResolvePrefersLiveAgentActivitySession() throws {
        let workspace = Workspace(title: "Codex")

        TerminalAgentActivityStore.shared.upsert(
            workspaceId: workspace.id,
            agentId: "codex",
            phase: .running,
            attentionKind: nil,
            preview: nil,
            waitingSince: nil,
            sessionId: "codex-123",
            cwd: "/tmp/codex",
            pid: nil
        )

        let reference = WorkspaceSessionReferenceResolver.resolve(for: workspace)

        XCTAssertEqual(reference?.agentId, "codex")
        XCTAssertEqual(reference?.agentDisplayName, "Codex CLI")
        XCTAssertEqual(reference?.sessionId, "codex-123")
        XCTAssertEqual(reference?.cwd, "/tmp/codex")
    }

    func testResolveClaudeSessionReferenceUsesExactSessionIdAndTranscript() throws {
        let cwd = "/tmp/repo/.termloop-worktrees/feature"
        let workspace = Workspace(title: "Claude", workingDirectory: cwd, portOrdinal: 0)
        let slugDir = tempProjectsDir.appendingPathComponent(ClaudeSessionScanner.slug(forCwd: cwd))
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)

        let wrong = slugDir.appendingPathComponent("wrong.jsonl")
        try "{}\n".write(to: wrong, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 500)],
            ofItemAtPath: wrong.path
        )

        let target = slugDir.appendingPathComponent("target.jsonl")
        try "{}\n".write(to: target, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 100)],
            ofItemAtPath: target.path
        )

        WorkspaceMetadataStore.shared.setClaudeSession(
            workspaceId: workspace.id.uuidString,
            sessionId: "target",
            cwd: cwd
        )

        let reference = WorkspaceSessionReferenceResolver.resolve(for: workspace)

        XCTAssertEqual(reference?.agentId, "claude")
        XCTAssertEqual(reference?.sessionId, "target")
        XCTAssertEqual(reference?.cwd, cwd)

        let transcriptURL = WorkspaceTranscriptResolver.resolve(
            for: reference!,
            scanner: ClaudeSessionScanner(projectsDir: tempProjectsDir)
        )
        XCTAssertEqual(transcriptURL, target)
    }

    func testResolveFallsBackToStoredCompletedCodexSession() throws {
        let workspace = Workspace(title: "Codex Done")
        WorkspaceMetadataStore.shared.setPersistedAgentSession(
            agentId: "codex",
            sessionId: "codex-finished",
            cwd: "/tmp/codex-finished",
            for: workspace.id
        )

        let reference = WorkspaceSessionReferenceResolver.resolve(for: workspace)

        XCTAssertEqual(reference?.agentId, "codex")
        XCTAssertEqual(reference?.sessionId, "codex-finished")
    }

    func testResolveTranscriptForWorkspaceUsesClaudeSessionFile() throws {
        let cwd = "/tmp/repo/.termloop-worktrees/feature"
        let workspace = Workspace(title: "Claude", workingDirectory: cwd, portOrdinal: 0)
        let slugDir = tempProjectsDir.appendingPathComponent(ClaudeSessionScanner.slug(forCwd: cwd))
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)

        let target = slugDir.appendingPathComponent("target.jsonl")
        try "{}\n".write(to: target, atomically: true, encoding: .utf8)

        WorkspaceMetadataStore.shared.setClaudeSession(
            workspaceId: workspace.id.uuidString,
            sessionId: "target",
            cwd: cwd
        )

        let transcriptURL = WorkspaceTranscriptResolver.resolve(
            for: workspace,
            scanner: ClaudeSessionScanner(projectsDir: tempProjectsDir)
        )

        XCTAssertEqual(transcriptURL, target)
    }

    func testConversationWorktreeRequestUsesTrackedConversationAgent() {
        let metadata = WorkspaceMetadataStore.shared
        let snapshot = metadata.snapshot()
        defer {
            metadata.restore(snapshot)
            TerminalAgentActivityStore.shared.replaceForTesting([:])
        }

        let workspace = Workspace(title: "Codex")
        let projectId = UUID()
        metadata.setProjectId(projectId, forWorkspaceId: workspace.id)
        metadata.setPersistedAgentSession(
            agentId: "codex",
            sessionId: "codex-session-1",
            cwd: "/tmp/codex",
            for: workspace.id
        )

        let request = ConversationWorktreeMigrationResolver.request(for: workspace)

        XCTAssertEqual(request?.projectId, projectId)
        XCTAssertEqual(request?.terminalAgentId, "codex")
        XCTAssertEqual(request?.sourceWorkspaceId, workspace.id)
        XCTAssertTrue(request?.isConversationMigration == true)
    }

    func testConversationWorktreeRequestHiddenForWorktreeBackedWorkspace() {
        let metadata = WorkspaceMetadataStore.shared
        let snapshot = metadata.snapshot()
        defer {
            metadata.restore(snapshot)
            TerminalAgentActivityStore.shared.replaceForTesting([:])
        }

        let workspace = Workspace(title: "Claude")
        metadata.setProjectId(UUID(), forWorkspaceId: workspace.id)
        metadata.setPersistedAgentSession(
            agentId: "claude",
            sessionId: "claude-session-1",
            cwd: "/tmp/repo",
            for: workspace.id
        )
        metadata.setBranch("feature/already-worktree", forWorkspaceId: workspace.id)

        XCTAssertNil(ConversationWorktreeMigrationResolver.request(for: workspace))
    }

    func testConversationWorktreeRequestHiddenWhileAgentRunning() {
        let metadata = WorkspaceMetadataStore.shared
        let snapshot = metadata.snapshot()
        defer {
            metadata.restore(snapshot)
            TerminalAgentActivityStore.shared.replaceForTesting([:])
        }

        let workspace = Workspace(title: "Running Codex")
        metadata.setProjectId(UUID(), forWorkspaceId: workspace.id)
        metadata.setPersistedAgentSession(
            agentId: "codex",
            sessionId: "codex-session-1",
            cwd: "/tmp/codex",
            for: workspace.id
        )
        TerminalAgentActivityStore.shared.upsert(
            workspaceId: workspace.id,
            agentId: "codex",
            phase: .running,
            attentionKind: nil,
            preview: nil,
            waitingSince: nil,
            sessionId: "codex-session-1",
            cwd: "/tmp/codex",
            pid: nil
        )

        XCTAssertNil(ConversationWorktreeMigrationResolver.request(for: workspace))
    }

    func testConversationWorktreeRequestHiddenForUnsupportedResumeAgent() {
        let metadata = WorkspaceMetadataStore.shared
        let snapshot = metadata.snapshot()
        defer {
            metadata.restore(snapshot)
            TerminalAgentActivityStore.shared.replaceForTesting([:])
        }

        let workspace = Workspace(title: "Gemini")
        metadata.setProjectId(UUID(), forWorkspaceId: workspace.id)
        metadata.setPersistedAgentSession(
            agentId: "gemini",
            sessionId: "gemini-session-1",
            cwd: "/tmp/gemini",
            for: workspace.id
        )

        XCTAssertNil(ConversationWorktreeMigrationResolver.request(for: workspace))
    }
}
