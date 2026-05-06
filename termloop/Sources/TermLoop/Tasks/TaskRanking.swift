// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Fractional ordering helpers (LexoRank-style, but base-26 alphabetic for
/// readability in tasks.json). `String` ordering is lexicographic so
/// "A" < "AM" < "AZ" < "B" < "U" < "Z".
public enum TaskRanking {
    private static let alphabet: [Character] =
        Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    private static let mid: Character = "U" // ~75% — leaves headroom on both sides

    /// First rank in an empty column.
    public static func initial() -> String { String(mid) }

    /// Append after `prev` (toward higher ranks).
    public static func after(_ prev: String) -> String {
        between(prev, end: nil)
    }

    /// Prepend before `next` (toward lower ranks).
    public static func before(_ next: String) -> String {
        between(start: nil, next)
    }

    /// Pick a rank strictly between `a` and `b`. Precondition: a < b.
    public static func between(_ a: String, _ b: String) -> String {
        precondition(a < b, "between requires a < b")
        return between(a, end: b)
    }

    /// `count` evenly distributed ranks for rebalancing.
    public static func rebalanced(count: Int) -> [String] {
        precondition(count > 0)
        guard count > 1 else { return [String(mid)] }

        var width = 1
        var capacity = alphabet.count
        while capacity <= count + 1 {
            width += 1
            capacity *= alphabet.count
        }

        return (0..<count).map { i in
            let value = (i + 1) * capacity / (count + 1)
            return fixedWidthRank(value, width: width)
        }
    }

    // MARK: - Internals

    private static func between(start: String?, _ end: String) -> String {
        // Place mid between "" (logical low) and end[0].
        guard let firstEnd = end.first else { return String(mid) }
        if let prepended = char(less: firstEnd) {
            return String(prepended)
        }
        // end is "A" — extend with mid.
        return String(end.first!) + String(mid)
    }

    private static func between(_ start: String, end: String?) -> String {
        guard let end else {
            // Extend after start.
            return start + String(mid)
        }
        if start.count == end.count, start.count == 1 {
            let s = start.first!
            let e = end.first!
            if let m = midChar(between: s, end: e) {
                return String(m)
            }
            // Adjacent — extend the shorter.
            return start + String(mid)
        }
        // Pad and recurse on the position they diverge.
        return alignedBetween(start: start, end: end)
    }

    private static func alignedBetween(start: String, end: String) -> String {
        let maxLen = max(start.count, end.count) + 1
        let s = padded(start, to: maxLen)
        let e = padded(end, to: maxLen)
        var result = ""
        var i = s.startIndex
        var j = e.startIndex
        while i < s.endIndex && j < e.endIndex {
            let sc = s[i]
            let ec = e[j]
            if sc == ec {
                result.append(sc)
                i = s.index(after: i)
                j = e.index(after: j)
                continue
            }
            if let mid = midChar(between: sc, end: ec) {
                result.append(mid)
                return result
            }
            // Adjacent (e.g., A,B) — keep `sc`, descend.
            result.append(sc)
            i = s.index(after: i)
            j = e.index(after: j)
        }
        result.append(mid)
        return result
    }

    private static func padded(_ s: String, to length: Int) -> String {
        guard s.count < length else { return s }
        return s + String(repeating: "A", count: length - s.count)
    }

    private static func midChar(between a: Character, end b: Character) -> Character? {
        guard let ai = alphabet.firstIndex(of: a),
              let bi = alphabet.firstIndex(of: b),
              bi - ai > 1 else { return nil }
        return alphabet[(ai + bi) / 2]
    }

    private static func char(less than: Character) -> Character? {
        guard let idx = alphabet.firstIndex(of: than), idx > 0 else { return nil }
        return alphabet[idx / 2]
    }

    private static func fixedWidthRank(_ value: Int, width: Int) -> String {
        var remaining = value
        var chars = Array(repeating: alphabet[0], count: width)
        for idx in stride(from: width - 1, through: 0, by: -1) {
            chars[idx] = alphabet[remaining % alphabet.count]
            remaining /= alphabet.count
        }
        return String(chars)
    }
}
