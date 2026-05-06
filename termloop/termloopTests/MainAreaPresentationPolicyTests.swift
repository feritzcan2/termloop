import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class MainAreaPresentationPolicyTests: XCTestCase {
    private let windowId = UUID(uuidString: "10000000-0000-0000-0000-000000000001")!
    private let projectA = UUID(uuidString: "20000000-0000-0000-0000-000000000001")!
    private let projectB = UUID(uuidString: "20000000-0000-0000-0000-000000000002")!
    private let workspaceA = UUID(uuidString: "30000000-0000-0000-0000-000000000001")!
    private let workspaceB = UUID(uuidString: "30000000-0000-0000-0000-000000000002")!

    private func input(
        sidebarTab: TermLoopSidebarTab = .work,
        workSubTab: WorkSubTab = .loop,
        selected: UUID? = nil,
        retiring: UUID? = nil,
        mounted: [UUID]? = nil,
        activeProject: UUID? = nil,
        workspaceProjectIds: [UUID: UUID]? = nil,
        pending: Set<UUID> = [],
        settingsIsOpen: Bool = false,
        markdownURL: URL? = nil,
        gitChangesWorkspaceId: UUID? = nil,
        abilityId: String? = nil,
        abilitySplit: Bool = false,
        taskBoardInlineWorkspaceId: UUID? = nil,
        hasOverlay: Bool = false,
        generation: UInt64 = 0
    ) -> MainAreaPresentationInput {
        MainAreaPresentationInput(
            windowId: windowId,
            sidebarTab: sidebarTab,
            workSubTab: workSubTab,
            selectedWorkspaceId: selected,
            retiringWorkspaceId: retiring,
            mountedWorkspaceIds: mounted ?? [workspaceA, workspaceB],
            pendingBackgroundWorkspaceLoadIds: pending,
            activeProjectId: activeProject,
            workspaceProjectIds: workspaceProjectIds ?? [workspaceA: projectA, workspaceB: projectA],
            settingsIsOpen: settingsIsOpen,
            markdownDocumentURL: markdownURL,
            gitChangesWorkspaceId: gitChangesWorkspaceId,
            abilityDetailId: abilityId,
            abilityDetailIsSplit: abilitySplit,
            taskBoardInlineWorkspaceId: taskBoardInlineWorkspaceId,
            hasCommandPaletteOrFileDropOverlay: hasOverlay,
            handoffGeneration: generation
        )
    }

    func testBackgroundPrimedWorkspaceStaysMountedButNotPanelVisible() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            selected: nil,
            mounted: [workspaceA],
            pending: [workspaceA]
        ))

        let presentation = snapshot.presentation(for: workspaceA)
        XCTAssertEqual(snapshot.mainPage, .content)
        XCTAssertFalse(presentation?.isRenderedVisible ?? true)
        XCTAssertFalse(presentation?.isPanelVisible ?? true)
        XCTAssertEqual(presentation?.renderOpacity, 0.001)
        XCTAssertFalse(presentation?.terminalPortalsVisible ?? true)
    }

    func testCrossProjectSwitchImmediatelyHidesRetiringWorkspace() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceB,
            retiring: workspaceA,
            activeProject: projectB,
            workspaceProjectIds: [workspaceA: projectA, workspaceB: projectB],
            generation: 11
        ))

        XCTAssertEqual(snapshot.handoffPolicy, .immediateHideRetiring(generation: 11))
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.browserPortalsVisible ?? true)
        XCTAssertTrue(snapshot.presentation(for: workspaceB)?.terminalPortalsVisible ?? false)
    }

    func testSameProjectContentHandoffAllowsSelectedAndRetiringWorkspace() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceB,
            retiring: workspaceA,
            activeProject: projectA,
            workspaceProjectIds: [workspaceA: projectA, workspaceB: projectA],
            generation: 7
        ))

        XCTAssertEqual(snapshot.handoffPolicy, .sameProjectContentHandoff(generation: 7))
        XCTAssertTrue(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? false)
        XCTAssertTrue(snapshot.presentation(for: workspaceB)?.terminalPortalsVisible ?? false)
        XCTAssertEqual(snapshot.presentation(for: workspaceA)?.portalPriority, 1)
        XCTAssertEqual(snapshot.presentation(for: workspaceB)?.portalPriority, 2)
    }

    func testCommandPaletteOrFileDropSuppressesRetiringWorkspaceHandoff() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceB,
            retiring: workspaceA,
            activeProject: projectA,
            workspaceProjectIds: [workspaceA: projectA, workspaceB: projectA],
            hasOverlay: true,
            generation: 9
        ))

        XCTAssertEqual(snapshot.mainPage, .content)
        XCTAssertEqual(snapshot.handoffPolicy, .immediateHideRetiring(generation: 9))
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)
        XCTAssertTrue(snapshot.presentation(for: workspaceB)?.terminalPortalsVisible ?? false)
    }

    func testSettingsRouteWinsUntilClosedThenExplicitNavigationCanShowContent() {
        let settingsSnapshot = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceA,
            activeProject: projectA,
            settingsIsOpen: true
        ))
        XCTAssertEqual(settingsSnapshot.mainPage, .settings)
        XCTAssertFalse(settingsSnapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)

        let closedSnapshot = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceA,
            activeProject: projectA,
            settingsIsOpen: false
        ))
        XCTAssertEqual(closedSnapshot.mainPage, .content)
        XCTAssertTrue(closedSnapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? false)
    }

    func testSettingsRouteHidesCrossProjectRetiringWorkspace() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceB,
            retiring: workspaceA,
            activeProject: projectB,
            workspaceProjectIds: [workspaceA: projectA, workspaceB: projectB],
            settingsIsOpen: true,
            generation: 12
        ))

        XCTAssertEqual(snapshot.mainPage, .settings)
        XCTAssertEqual(snapshot.handoffPolicy, .immediateHideRetiring(generation: 12))
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)
        XCTAssertFalse(snapshot.presentation(for: workspaceB)?.terminalPortalsVisible ?? true)
    }

    func testSettingsRouteHidesSameProjectWorkspaceSwitch() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceB,
            retiring: workspaceA,
            activeProject: projectA,
            workspaceProjectIds: [workspaceA: projectA, workspaceB: projectA],
            settingsIsOpen: true,
            generation: 13
        ))

        XCTAssertEqual(snapshot.mainPage, .settings)
        XCTAssertEqual(snapshot.handoffPolicy, .immediateHideRetiring(generation: 13))
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)
        XCTAssertFalse(snapshot.presentation(for: workspaceB)?.terminalPortalsVisible ?? true)
    }

    func testAbilitySplitKeepsSelectedWorkspaceVisibleButNonSplitDoesNot() {
        let split = MainAreaPresentationPolicy.resolve(input(
            workSubTab: .agents,
            selected: workspaceA,
            activeProject: projectA,
            abilityId: "working-with-debugging",
            abilitySplit: true
        ))
        XCTAssertEqual(split.mainPage, .ability(id: "working-with-debugging", split: true))
        XCTAssertTrue(split.presentation(for: workspaceA)?.terminalPortalsVisible ?? false)
        XCTAssertTrue(split.presentation(for: workspaceA)?.isInputActive ?? false)

        let full = MainAreaPresentationPolicy.resolve(input(
            workSubTab: .agents,
            selected: workspaceA,
            activeProject: projectA,
            abilityId: "working-with-debugging",
            abilitySplit: false
        ))
        XCTAssertEqual(full.mainPage, .ability(id: "working-with-debugging", split: false))
        XCTAssertFalse(full.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)
    }

    func testProjectEmptyIsDerivedFromSnapshotInputs() {
        let noWorkspace = MainAreaPresentationPolicy.resolve(input(
            selected: nil,
            mounted: [],
            activeProject: projectA,
            workspaceProjectIds: [:]
        ))
        XCTAssertEqual(noWorkspace.mainPage, .projectEmpty)
        XCTAssertEqual(noWorkspace.handoffPolicy, .none)

        let staleSelection = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceB,
            activeProject: projectA,
            workspaceProjectIds: [workspaceA: projectA, workspaceB: projectB]
        ))
        XCTAssertEqual(staleSelection.mainPage, .projectEmpty)
    }

    func testRoutePrecedenceKeepsContextBankAboveMarkdownDocument() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            workSubTab: .contextBank,
            selected: workspaceA,
            activeProject: projectA,
            markdownURL: URL(fileURLWithPath: "/tmp/readme.md")
        ))

        XCTAssertEqual(snapshot.mainPage, .contextBank)
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)
    }


    func testGitChangesRouteCanOverlayTasksBoard() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            workSubTab: .tasks,
            selected: workspaceA,
            activeProject: projectA,
            gitChangesWorkspaceId: workspaceA
        ))

        XCTAssertEqual(snapshot.mainPage, .gitChanges(workspaceA))
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)
    }

    func testGitChangesFromTasksKeepsExistingInlineTerminalVisible() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            workSubTab: .tasks,
            selected: workspaceA,
            activeProject: projectA,
            gitChangesWorkspaceId: workspaceA,
            taskBoardInlineWorkspaceId: workspaceA
        ))

        XCTAssertEqual(snapshot.mainPage, .gitChanges(workspaceA))
        XCTAssertTrue(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? false)
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.browserPortalsVisible ?? true)
        XCTAssertEqual(snapshot.presentation(for: workspaceA)?.portalPriority, 3)
    }

    func testRoutePrecedenceKeepsMarkdownDocumentAboveGitChanges() {
        let url = URL(fileURLWithPath: "/tmp/notes.md")
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceA,
            activeProject: projectA,
            markdownURL: url,
            gitChangesWorkspaceId: workspaceB
        ))

        XCTAssertEqual(snapshot.mainPage, .markdownDocument(url))
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)
    }

    func testRapidSwitchGenerationTokenIsCarriedByHandoffPolicy() {
        let first = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceB,
            retiring: workspaceA,
            activeProject: projectA,
            workspaceProjectIds: [workspaceA: projectA, workspaceB: projectA],
            generation: 41
        ))
        let second = MainAreaPresentationPolicy.resolve(input(
            selected: workspaceA,
            retiring: workspaceB,
            activeProject: projectA,
            workspaceProjectIds: [workspaceA: projectA, workspaceB: projectA],
            generation: 42
        ))

        XCTAssertEqual(first.handoffPolicy, .sameProjectContentHandoff(generation: 41))
        XCTAssertEqual(second.handoffPolicy, .sameProjectContentHandoff(generation: 42))
        XCTAssertNotEqual(first, second)
    }

    func testRetiringDisallowedForOverlayRouteEvenWithinSameProject() {
        let snapshot = MainAreaPresentationPolicy.resolve(input(
            sidebarTab: .agents,
            selected: workspaceB,
            retiring: workspaceA,
            activeProject: projectA,
            workspaceProjectIds: [workspaceA: projectA, workspaceB: projectA],
            generation: 5
        ))

        XCTAssertEqual(snapshot.mainPage, .agents)
        XCTAssertEqual(snapshot.handoffPolicy, .immediateHideRetiring(generation: 5))
        XCTAssertFalse(snapshot.presentation(for: workspaceA)?.terminalPortalsVisible ?? true)
        XCTAssertFalse(snapshot.presentation(for: workspaceB)?.terminalPortalsVisible ?? true)
    }

    @MainActor
    func testWorkspaceDidCloseRemovesPresentationFromCoordinatorSnapshot() {
        let coordinator = MainAreaPresentationCoordinator.shared
        coordinator.resetForTesting()
        defer { coordinator.resetForTesting() }

        coordinator.apply(
            MainAreaPresentationPolicy.resolve(input(
                selected: workspaceA,
                activeProject: projectA
            )),
            tabManager: TabManager(),
            reason: "test.seed"
        )
        XCTAssertNotNil(coordinator.snapshotForTesting(windowId: windowId)?.presentation(for: workspaceA))

        coordinator.handleNavigationEvent(.workspaceDidClose(workspaceA))

        XCTAssertNil(coordinator.snapshotForTesting(windowId: windowId)?.presentation(for: workspaceA))
    }
}
