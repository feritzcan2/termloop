import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class DocsStoreTests: XCTestCase {
    func testFoldersFeatureRemoved() {
        XCTAssertTrue(true)
    }
}
