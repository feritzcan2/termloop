import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class ClaudeSessionJSONLFormatterTests: XCTestCase {
    func test_render_userLine_hasPromptPrefix() {
        let out = ClaudeSessionJSONLFormatter.render(.user("hello"), colorize: false)
        XCTAssertEqual(out, "❯ hello")
    }

    func test_render_assistantLine_hasNoPrefix() {
        let out = ClaudeSessionJSONLFormatter.render(.assistant("world"), colorize: false)
        XCTAssertEqual(out, "world")
    }

    func test_render_toolCall_usesDimmedArrow() {
        let out = ClaudeSessionJSONLFormatter.render(
            .toolCall(name: "Read", arg: "ContentView.swift"),
            colorize: false)
        XCTAssertEqual(out, "▶ Read ContentView.swift")
    }

    func test_render_withColor_wrapsInANSI() {
        let out = ClaudeSessionJSONLFormatter.render(.user("hi"), colorize: true)
        XCTAssertTrue(out.contains("\u{001B}["))
        XCTAssertTrue(out.hasSuffix("\u{001B}[0m"))
    }
}
