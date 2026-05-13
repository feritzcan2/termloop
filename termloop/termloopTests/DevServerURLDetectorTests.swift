// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class DevServerURLDetectorTests: XCTestCase {
    func testDetectsLocalFullAndBareURLs() {
        let line = "Local: http://localhost:5173/ Network: http://0.0.0.0:5173 and 127.0.0.1:3000"
        let urls = DevServerURLDetector.detect(in: line).map(\.normalizedString)
        XCTAssertEqual(urls, [
            "http://localhost:5173/",
            "http://localhost:5173",
            "http://127.0.0.1:3000"
        ])
    }

    func testDetectsIPv6LoopbackAndNormalizesUnspecifiedAddress() {
        let line = "ready on http://[::1]:4000 and http://[::]:5000"
        let urls = DevServerURLDetector.detect(in: line).map(\.normalizedString)
        XCTAssertEqual(urls, [
            "http://localhost:4000",
            "http://localhost:5000"
        ])
    }

    func testIgnoresRemoteHosts() {
        XCTAssertEqual(DevServerURLDetector.detect(in: "https://example.com:443"), [])
    }

    func testDeduplicatesWithinLine() {
        let urls = DevServerURLDetector.detect(in: "http://localhost:5173 and localhost:5173")
        XCTAssertEqual(urls.map(\.normalizedString), ["http://localhost:5173"])
    }

    func testTrimsUnmatchedClosingDelimitersFromLogText() {
        let line = "Serving HTTP on 127.0.0.1 port 5173 (http://127.0.0.1:5173/) ..."
        let urls = DevServerURLDetector.detect(in: line).map(\.normalizedString)
        XCTAssertEqual(urls, ["http://127.0.0.1:5173/"])
    }

    func testKeepsBalancedPathDelimiters() {
        XCTAssertEqual(
            DevServerURLDetector.normalize("http://localhost:5173/foo(bar)"),
            "http://localhost:5173/foo(bar)"
        )
    }
}
