// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Minimal YAML parser for template frontmatter. Supports only:
///   - top-level `key: value` pairs
///   - scalar values: string (optionally quoted), bool (true/false), int
///   - inline array: `[a, b, c]`
///   - `#` comments, blank lines
/// Throws on anything else (block scalars, nested maps, anchors, flow maps).
enum TinyYAML {
    enum Error: Swift.Error, CustomStringConvertible {
        case blockScalarUnsupported(line: Int)
        case nestedMappingUnsupported(line: Int)
        case malformedLine(line: Int, text: String)

        var description: String {
            switch self {
            case .blockScalarUnsupported(let l): return "tiny-yaml: block scalar unsupported at line \(l)"
            case .nestedMappingUnsupported(let l): return "tiny-yaml: nested mapping unsupported at line \(l)"
            case .malformedLine(let l, let t): return "tiny-yaml: malformed line \(l): \(t)"
            }
        }
    }

    static func parse(_ text: String) throws -> [String: Any] {
        var out: [String: Any] = [:]
        let lines = text.components(separatedBy: "\n")
        for (idx, raw) in lines.enumerated() {
            let line = idx + 1
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            if raw.first == " " || raw.first == "\t" {
                throw Error.nestedMappingUnsupported(line: line)
            }
            guard let colon = trimmed.firstIndex(of: ":") else {
                throw Error.malformedLine(line: line, text: trimmed)
            }
            let key = String(trimmed[..<colon]).trimmingCharacters(in: .whitespaces)
            let valuePart = String(trimmed[trimmed.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            if valuePart == "|" || valuePart == ">" {
                throw Error.blockScalarUnsupported(line: line)
            }
            if valuePart.isEmpty {
                // bare key implies nested mapping on next line — unsupported
                if idx + 1 < lines.count,
                   let next = lines[idx + 1].first, next == " " || next == "\t" {
                    throw Error.nestedMappingUnsupported(line: line)
                }
                out[key] = ""
                continue
            }
            out[key] = parseScalar(valuePart)
        }
        return out
    }

    private static func parseScalar(_ raw: String) -> Any {
        // inline array
        if raw.hasPrefix("["), raw.hasSuffix("]") {
            let inner = String(raw.dropFirst().dropLast())
            let parts = inner.split(separator: ",").map {
                unquote(String($0).trimmingCharacters(in: .whitespaces))
            }
            return parts
        }
        if raw == "true" { return true }
        if raw == "false" { return false }
        if let i = Int(raw) { return i }
        return unquote(raw)
    }

    private static func unquote(_ s: String) -> String {
        guard s.count >= 2 else { return s }
        let first = s.first!
        let last = s.last!
        if (first == "\"" && last == "\"") || (first == "'" && last == "'") {
            return String(s.dropFirst().dropLast())
        }
        return s
    }
}
