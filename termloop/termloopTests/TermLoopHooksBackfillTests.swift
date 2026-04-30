import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TermLoopHooksBackfillTests: XCTestCase {
    private var tempDir: URL!
    private var sessionsDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("TermLoopHooksBackfillTests-\(UUID().uuidString)", isDirectory: true)
        sessionsDir = tempDir.appendingPathComponent("sessions/2026/04/19", isDirectory: true)
        try FileManager.default.createDirectory(at: sessionsDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempDir {
            try? FileManager.default.removeItem(at: tempDir)
        }
        tempDir = nil
        sessionsDir = nil
    }

    func testCodexBackfillDoesNotUseStaleSessionForSingleCandidate() throws {
        let cwd = "/tmp/ticket"
        try writeSession(id: "sid-old", cwd: cwd, ageSeconds: 3_600)

        let sessions = TermLoopHooks.persistedAgentSessionsForBackfill(
            agentId: "codex",
            cwd: cwd,
            cutoff: Date().addingTimeInterval(-60),
            codexScanner: CodexSessionScanner(codexHome: tempDir)
        )

        XCTAssertTrue(sessions.isEmpty)
    }

    func testCodexBackfillDoesNotUseStaleSessionWhenMultipleCandidatesShareCwd() throws {
        let cwd = "/tmp/shared"
        try writeSession(id: "sid-old", cwd: cwd, ageSeconds: 3_600)

        let sessions = TermLoopHooks.persistedAgentSessionsForBackfill(
            agentId: "codex",
            cwd: cwd,
            cutoff: Date().addingTimeInterval(-60),
            codexScanner: CodexSessionScanner(codexHome: tempDir)
        )

        XCTAssertTrue(sessions.isEmpty)
    }

    func testBackfillSingleCandidateStillFallsBackToNewestSessionWithoutSignal() {
        let older = makeBackfillSessionCandidate(
            sessionId: "sid-old",
            updatedAt: Date(timeIntervalSince1970: 10)
        )
        let newer = makeBackfillSessionCandidate(
            sessionId: "sid-new",
            updatedAt: Date(timeIntervalSince1970: 20)
        )

        let resolved = TermLoopHooks.bestBackfillSession(
            for: makeBackfillCandidate(),
            sessions: [older, newer],
            usedSessionIds: [],
            candidateCountInGroup: 1
        )

        XCTAssertEqual(resolved?.session.sessionId, "sid-new")
    }

    func testBackfillSkipsAmbiguousClaudeMatchWhenMultipleCandidatesShareCwdWithoutSignal() {
        let older = makeBackfillSessionCandidate(
            sessionId: "sid-old",
            updatedAt: Date(timeIntervalSince1970: 10)
        )
        let newer = makeBackfillSessionCandidate(
            sessionId: "sid-new",
            updatedAt: Date(timeIntervalSince1970: 20)
        )

        let resolved = TermLoopHooks.bestBackfillSession(
            for: makeBackfillCandidate(),
            sessions: [older, newer],
            usedSessionIds: [],
            candidateCountInGroup: 2
        )

        XCTAssertNil(
            resolved,
            "multiple same-cwd Claude candidates should not arbitrarily grab the newest session"
        )
    }

    func testBackfillPrefersClaudePreviewMatchOverNewerSameCwdSession() {
        let matching = makeBackfillSessionCandidate(
            sessionId: "sid-match",
            updatedAt: Date(timeIntervalSince1970: 10),
            assistantPreview: "Need a reply from the API owner before proceeding."
        )
        let newer = makeBackfillSessionCandidate(
            sessionId: "sid-newer",
            updatedAt: Date(timeIntervalSince1970: 20),
            assistantPreview: "Refactored the sidebar diff rendering."
        )

        let resolved = TermLoopHooks.bestBackfillSession(
            for: makeBackfillCandidate(lastMessagePreview: "Need a reply from the API owner"),
            sessions: [matching, newer],
            usedSessionIds: [],
            candidateCountInGroup: 2
        )

        XCTAssertEqual(resolved?.session.sessionId, "sid-match")
    }

    private func writeSession(id: String, cwd: String, ageSeconds: TimeInterval) throws {
        let url = sessionsDir.appendingPathComponent("rollout-\(id).jsonl")
        let firstLine = """
        {"timestamp":"2026-04-19T10:00:00Z","type":"session_meta","payload":{"id":"\(id)","timestamp":"2026-04-19T10:00:00Z","cwd":"\(cwd)"}}
        """
        try (firstLine + "\n").write(to: url, atomically: true, encoding: .utf8)
        let mtime = Date().addingTimeInterval(-ageSeconds)
        try FileManager.default.setAttributes([.modificationDate: mtime], ofItemAtPath: url.path)
    }

    private func makeBackfillCandidate(
        lastMessagePreview: String? = nil
    ) -> TermLoopHooks.BackfillCandidate {
        TermLoopHooks.BackfillCandidate(
            workspaceId: UUID(),
            agentId: TerminalAgent.claudeId,
            cwd: "/tmp/shared",
            startedAt: nil,
            workspaceTitle: nil,
            lastMessagePreview: lastMessagePreview
        )
    }

    private func makeBackfillSessionCandidate(
        sessionId: String,
        updatedAt: Date,
        assistantPreview: String? = nil
    ) -> TermLoopHooks.BackfillSessionCandidate {
        TermLoopHooks.BackfillSessionCandidate(
            session: PersistedAgentSession(
                agentId: TerminalAgent.claudeId,
                sessionId: sessionId,
                cwd: "/tmp/shared",
                updatedAt: updatedAt
            ),
            title: nil,
            assistantPreview: assistantPreview,
            userPreview: nil
        )
    }
}
