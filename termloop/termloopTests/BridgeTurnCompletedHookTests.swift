// termloop/termloopTests/BridgeTurnCompletedHookTests.swift
import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class BridgeTurnCompletedHookTests: XCTestCase {
    func testBridgeForwardModeDefaultsToManual() {
        let bridge = WorkspaceBridge(
            leftWorkspaceId: UUID(),
            rightWorkspaceId: UUID(),
            kickoffMessage: "test",
            firstSpeaker: .left
        )
        XCTAssertEqual(bridge.effectiveForwardMode, .manual)
    }
}

