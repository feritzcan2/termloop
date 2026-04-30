import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ExternalLinkParserTests: XCTestCase {
    func test_jiraCloud() throws {
        let link = ExternalLinkParser.parse("https://acme.atlassian.net/browse/ONB-142")
        XCTAssertEqual(link?.provider, .jira)
        XCTAssertEqual(link?.ticketKey, "ONB-142")
    }

    func test_linear() throws {
        let link = ExternalLinkParser.parse("https://linear.app/acme/issue/ONB-142/title-slug")
        XCTAssertEqual(link?.provider, .linear)
        XCTAssertEqual(link?.ticketKey, "ONB-142")
    }

    func test_githubIssue() throws {
        let link = ExternalLinkParser.parse("https://github.com/acme/repo/issues/42")
        XCTAssertEqual(link?.provider, .github)
        XCTAssertEqual(link?.ticketKey, "acme/repo#42")
    }

    func test_unknownURL_producesOther() throws {
        let link = ExternalLinkParser.parse("https://example.com/foo")
        XCTAssertEqual(link?.provider, .other)
        XCTAssertNil(link?.ticketKey)
    }

    func test_invalidURL_returnsNil() {
        XCTAssertNil(ExternalLinkParser.parse("not a url"))
    }
}
