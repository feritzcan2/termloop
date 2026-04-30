// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum FrontmatterParser {
    struct Result {
        let frontmatter: [String: Any]
        let body: String
    }

    enum Error: Swift.Error, CustomStringConvertible {
        case missingOpener
        case missingCloser

        var description: String {
            switch self {
            case .missingOpener: return "frontmatter: must start with --- on first line"
            case .missingCloser: return "frontmatter: missing closing --- delimiter"
            }
        }
    }

    static func parse(_ text: String) throws -> Result {
        let lines = text.components(separatedBy: "\n")
        guard let first = lines.first, first.trimmingCharacters(in: .whitespaces) == "---" else {
            throw Error.missingOpener
        }
        guard let closeIdx = lines.dropFirst().firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces) == "---"
        }) else {
            throw Error.missingCloser
        }
        let yamlText = lines[1..<closeIdx].joined(separator: "\n")
        let frontmatter = yamlText.isEmpty ? [:] : try TinyYAML.parse(yamlText)
        let bodyStart = closeIdx + 1
        let body: String
        if bodyStart < lines.count {
            body = lines[bodyStart...].joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            body = ""
        }
        return Result(frontmatter: frontmatter, body: body)
    }
}
