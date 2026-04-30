import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class TinyYAMLTests: XCTestCase {
    func testScalarString() throws {
        let out = try TinyYAML.parse("name: Save Agent")
        XCTAssertEqual(out["name"] as? String, "Save Agent")
    }

    func testScalarBool() throws {
        let out = try TinyYAML.parse("defaultAttach: true\nother: false")
        XCTAssertEqual(out["defaultAttach"] as? Bool, true)
        XCTAssertEqual(out["other"] as? Bool, false)
    }

    func testScalarInt() throws {
        let out = try TinyYAML.parse("timeoutSeconds: 300")
        XCTAssertEqual(out["timeoutSeconds"] as? Int, 300)
    }

    func testInlineArray() throws {
        let out = try TinyYAML.parse("triggers: [manual, on_workspace_close]")
        XCTAssertEqual(out["triggers"] as? [String], ["manual", "on_workspace_close"])
    }

    func testIgnoresQuotesSingleDouble() throws {
        let out = try TinyYAML.parse(#"name: "Save Agent""#)
        XCTAssertEqual(out["name"] as? String, "Save Agent")
    }

    func testCommentAndBlankLines() throws {
        let out = try TinyYAML.parse("""
        # header
        name: X

        scope: workspace
        """)
        XCTAssertEqual(out["name"] as? String, "X")
        XCTAssertEqual(out["scope"] as? String, "workspace")
    }

    func testRejectsBlockScalar() {
        XCTAssertThrowsError(try TinyYAML.parse("prompt: |\n  multi\n  line"))
    }

    func testRejectsNestedMapping() {
        XCTAssertThrowsError(try TinyYAML.parse("nested:\n  key: value"))
    }
}
