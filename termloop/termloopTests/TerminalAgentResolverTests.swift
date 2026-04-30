import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TerminalAgentResolverTests: XCTestCase {
    private var previousProjectSnapshot: [SessionProjectSnapshot] = []
    private var previousActiveProjectId: UUID?
    private var previousOpenProjectIds: [UUID] = []
    private var previousMetadataSnapshot: [String: WorkspaceMetadataStore.Metadata] = [:]
    private var previousDefaultTerminalAgentId: String = TerminalAgent.claudeId

    override func setUp() {
        super.setUp()
        previousProjectSnapshot = ProjectStore.shared.sessionSnapshot
        previousActiveProjectId = ProjectStore.shared.activeProjectId
        previousOpenProjectIds = ProjectStore.shared.openProjectIds
        previousMetadataSnapshot = WorkspaceMetadataStore.shared.snapshot()
        previousDefaultTerminalAgentId = TermLoopSettings.shared.defaultTerminalAgentId
    }

    override func tearDown() {
        TermLoopSettings.shared.defaultTerminalAgentId = previousDefaultTerminalAgentId
        WorkspaceMetadataStore.shared.restore(previousMetadataSnapshot)
        ProjectStore.shared.restoreFromSidecar(
            projects: previousProjectSnapshot,
            activeProjectId: previousActiveProjectId,
            openProjectIds: previousOpenProjectIds
        )
        super.tearDown()
    }

    func testWorkspaceOverrideWins() {
        let wsId = UUID()
        WorkspaceMetadataStore.shared.setTerminalAgentId("codex", for: wsId)
        XCTAssertEqual(TerminalAgentResolver.resolve(workspaceId: wsId)?.id, "codex")
    }

    func testFallsBackToGlobalDefault() {
        let wsId = UUID()
        TermLoopSettings.shared.defaultTerminalAgentId = "opencode"
        XCTAssertEqual(TerminalAgentResolver.resolve(workspaceId: wsId)?.id, "opencode")
    }

    func testProjectDefaultUsesActiveProjectWhenWorkspaceProjectMetadataIsMissing() {
        let project = Project(
            name: "Repo",
            folderPath: "/tmp/repo-\(UUID().uuidString)",
            defaultTerminalAgentId: "codex"
        )
        ProjectStore.shared.restoreFromSidecar(
            projects: [SessionProjectSnapshot(project)],
            activeProjectId: project.id,
            openProjectIds: [project.id]
        )
        TermLoopSettings.shared.defaultTerminalAgentId = "opencode"

        XCTAssertEqual(TerminalAgentResolver.resolve(workspaceId: UUID())?.id, "codex")
    }
}
