// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Result of parsing a Claude Code skill / slash-command Markdown file.
///
/// Frontmatter is detected only when the first non-whitespace line is `---`.
/// Parsing is intentionally permissive: any failure falls back to treating the
/// whole file as body with no metadata.
struct SkillFrontmatter: Equatable {
    let name: String?
    let description: String?
    let body: String
}

enum SkillFrontmatterParser {
    static func parse(_ raw: String) -> SkillFrontmatter {
        let lines = raw.components(separatedBy: "\n")
        var firstNonBlank = 0
        while firstNonBlank < lines.count,
              lines[firstNonBlank].trimmingCharacters(in: .whitespaces).isEmpty {
            firstNonBlank += 1
        }
        guard firstNonBlank < lines.count,
              lines[firstNonBlank].trimmingCharacters(in: .whitespaces) == "---"
        else {
            return SkillFrontmatter(name: nil, description: nil, body: raw)
        }

        var closingIndex: Int?
        for i in (firstNonBlank + 1)..<lines.count {
            if lines[i].trimmingCharacters(in: .whitespaces) == "---" {
                closingIndex = i
                break
            }
        }
        guard let closing = closingIndex else {
            return SkillFrontmatter(name: nil, description: nil, body: raw)
        }

        let headerLines = lines[(firstNonBlank + 1)..<closing]
        var name: String?
        var description: String?
        for line in headerLines {
            if let (key, value) = splitKeyValue(line) {
                switch key.lowercased() {
                case "name": name = value
                case "description": description = value
                default: break
                }
            }
        }

        let bodyLines = lines[(closing + 1)..<lines.count]
        let body = bodyLines.joined(separator: "\n")
        return SkillFrontmatter(name: name, description: description, body: body)
    }

    private static func splitKeyValue(_ line: String) -> (key: String, value: String)? {
        guard let colon = line.firstIndex(of: ":") else { return nil }
        let key = line[..<colon].trimmingCharacters(in: .whitespaces)
        var value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { return nil }
        if value.count >= 2 {
            let first = value.first!
            let last = value.last!
            if (first == "\"" && last == "\"") || (first == "'" && last == "'") {
                value = String(value.dropFirst().dropLast())
            }
        }
        return (key, value)
    }
}
