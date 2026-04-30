import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class AgentWorkspaceKindTests: XCTestCase {
    func testCreatorEquality() {
        XCTAssertEqual(AgentWorkspaceKind.abilityCreator, .abilityCreator)
    }

    func testRefinerEqualityRespectsAbilityId() {
        XCTAssertEqual(
            AgentWorkspaceKind.abilityRefiner(abilityId: "x"),
            .abilityRefiner(abilityId: "x")
        )
        XCTAssertNotEqual(
            AgentWorkspaceKind.abilityRefiner(abilityId: "x"),
            .abilityRefiner(abilityId: "y")
        )
    }

    func testCreatorRefinerNotEqual() {
        XCTAssertNotEqual(
            AgentWorkspaceKind.abilityCreator,
            .abilityRefiner(abilityId: "x")
        )
    }

    func testDiscussionEqualityRespectsAbilityId() {
        XCTAssertEqual(
            AgentWorkspaceKind.abilityDiscussion(abilityId: "x"),
            .abilityDiscussion(abilityId: "x")
        )
        XCTAssertNotEqual(
            AgentWorkspaceKind.abilityDiscussion(abilityId: "x"),
            .abilityDiscussion(abilityId: "y")
        )
    }

    func testCodableRoundTripCreator() throws {
        let encoded = try JSONEncoder().encode(AgentWorkspaceKind.abilityCreator)
        let decoded = try JSONDecoder().decode(AgentWorkspaceKind.self, from: encoded)
        XCTAssertEqual(decoded, .abilityCreator)
    }

    func testCodableRoundTripRefiner() throws {
        let kind = AgentWorkspaceKind.abilityRefiner(abilityId: "systematic-debugging")
        let encoded = try JSONEncoder().encode(kind)
        let decoded = try JSONDecoder().decode(AgentWorkspaceKind.self, from: encoded)
        XCTAssertEqual(decoded, kind)
    }

    func testCodableRoundTripDiscussion() throws {
        let kind = AgentWorkspaceKind.abilityDiscussion(abilityId: "working-with-git")
        let encoded = try JSONEncoder().encode(kind)
        let decoded = try JSONDecoder().decode(AgentWorkspaceKind.self, from: encoded)
        XCTAssertEqual(decoded, kind)
    }
}
