import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class VariableSubstitutionTests: XCTestCase {
    func testSubstitutesKnownVars() throws {
        let out = try VariableSubstitution.apply(
            "On branch {{branch_name}} in {{workspace_path}}.",
            values: ["branch_name": "feat/x", "workspace_path": "/tmp"]
        )
        XCTAssertEqual(out, "On branch feat/x in /tmp.")
    }

    func testThrowsOnUnknownVar() {
        XCTAssertThrowsError(try VariableSubstitution.apply(
            "Hi {{missing}}.",
            values: [:]
        )) { err in
            guard case VariableSubstitution.Error.unknownVariable(let name) = err,
                  name == "missing" else { return XCTFail() }
        }
    }

    func testNoVarsIsIdentity() throws {
        XCTAssertEqual(try VariableSubstitution.apply("plain", values: [:]), "plain")
    }

    func testAllowsRepeatedVar() throws {
        let out = try VariableSubstitution.apply(
            "{{a}} and {{a}}", values: ["a": "x"]
        )
        XCTAssertEqual(out, "x and x")
    }
}
