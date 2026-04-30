// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum ClaudeSessionJSONLFormatter {
    static func render(_ line: TranscriptLine, colorize: Bool) -> String {
        switch line {
        case .user(let s):      return color("❯ \(s)", code: "1;37", on: colorize)
        case .assistant(let s): return color(s, code: "0;37", on: colorize)
        case .toolCall(let n, let a):
            let txt = a.isEmpty ? "▶ \(n)" : "▶ \(n) \(a)"
            return color(txt, code: "2;37", on: colorize)
        }
    }

    private static func color(_ s: String, code: String, on: Bool) -> String {
        guard on else { return s }
        return "\u{001B}[\(code)m\(s)\u{001B}[0m"
    }
}
