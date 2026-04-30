import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class TermLoopSidebarTabTests: XCTestCase {
    func testRawValuesStableForAppStorage() {
        // @AppStorage persists the raw string; changing these breaks sessions.
        XCTAssertEqual(TermLoopSidebarTab.work.rawValue, "work")
        XCTAssertEqual(TermLoopSidebarTab.agents.rawValue, "agents")
        XCTAssertEqual(TermLoopSidebarTab.integrations.rawValue, "integrations")
        XCTAssertEqual(TermLoopSidebarTab.plan.rawValue, "plan")
    }

    func testAllCasesOrdering() {
        XCTAssertEqual(TermLoopSidebarTab.allCases, [.work, .agents, .integrations, .plan])
    }

    func testFocusVolatileSidebarTweaksDefaultToOff() {
        XCTAssertTrue(TermLoopSidebarFeatureFlags.defaultHighlightSelectedEpicRow)
        XCTAssertFalse(TermLoopSidebarFeatureFlags.defaultAutoCollapseUnselectedEpic)
        XCTAssertFalse(TermLoopSidebarFeatureFlags.defaultBubbleWorkspaceOnResponse)
        XCTAssertFalse(TermLoopSidebarFeatureFlags.defaultSinkStaleEpics)
        XCTAssertFalse(TermLoopSidebarFeatureFlags.defaultDelayEpicUnsinkOnClick)
    }

}
