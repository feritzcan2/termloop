import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class FrontmatterParserTests: XCTestCase {
    func testSplitsFrontmatterAndBody() throws {
        let src = """
        ---
        id: save-agent
        name: Save Agent
        ---
        You are the Save Agent.
        Do the thing.
        """
        let r = try FrontmatterParser.parse(src)
        XCTAssertEqual(r.frontmatter["id"] as? String, "save-agent")
        XCTAssertEqual(r.frontmatter["name"] as? String, "Save Agent")
        XCTAssertEqual(r.body, "You are the Save Agent.\nDo the thing.")
    }

    func testMissingFrontmatterThrows() {
        XCTAssertThrowsError(try FrontmatterParser.parse("just a body"))
    }

    func testEmptyFrontmatterOK() throws {
        let r = try FrontmatterParser.parse("---\n---\nbody here")
        XCTAssertTrue(r.frontmatter.isEmpty)
        XCTAssertEqual(r.body, "body here")
    }

    func testMissingClosingDelimiterThrows() {
        XCTAssertThrowsError(try FrontmatterParser.parse("---\nid: x\nbody"))
    }
}
