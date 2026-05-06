import XCTest
@testable import termloop

final class TaskRankingTests: XCTestCase {
    func testInitialRankIsMid() {
        XCTAssertEqual(TaskRanking.initial(), "U")
    }

    func testInsertBetweenAlphaPicksMidpoint() {
        let r = TaskRanking.between("A", "C")
        XCTAssertGreaterThan(r, "A")
        XCTAssertLessThan(r, "C")
    }

    func testInsertAfterAppendsHigher() {
        let after = TaskRanking.after("M")
        XCTAssertGreaterThan(after, "M")
    }

    func testInsertBeforePrependsLower() {
        let before = TaskRanking.before("M")
        XCTAssertLessThan(before, "M")
    }

    func testManyInsertsBetweenSameNeighborsTriggersRebalance() {
        // 64 sequential inserts between same neighbors must succeed and stay ordered.
        var current = TaskRanking.between("A", "Z")
        for _ in 0..<64 {
            let next = TaskRanking.between("A", current)
            XCTAssertGreaterThan(current, next)
            XCTAssertGreaterThan(next, "A")
            current = next
        }
    }

    func testRebalanceProducesEvenSpacing() {
        let ranks = TaskRanking.rebalanced(count: 5)
        XCTAssertEqual(ranks.count, 5)
        let sorted = ranks.sorted()
        XCTAssertEqual(ranks, sorted)
        for (a, b) in zip(ranks, ranks.dropFirst()) {
            XCTAssertLessThan(a, b)
        }
    }

    func testRebalanceSupportsMoreThanAlphabetCount() {
        let ranks = TaskRanking.rebalanced(count: 64)
        XCTAssertEqual(ranks.count, 64)
        XCTAssertEqual(Set(ranks).count, 64)
        XCTAssertEqual(ranks, ranks.sorted())
        XCTAssertTrue(ranks.allSatisfy { !$0.isEmpty })
    }
}
