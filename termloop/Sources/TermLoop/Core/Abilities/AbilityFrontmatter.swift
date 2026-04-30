// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Hand-rolled minimal YAML frontmatter parser/serializer for ability files.
///
/// The schema is fixed and tiny — three scalar keys (`name`, `description`,
/// `activation`). Rather than depending on a general YAML library, this
/// parses the envelope `---\n<fields>\n---\n<body>` and a line-oriented
/// `key: value` block. Unknown keys are ignored on parse and dropped on
/// serialize. Malformed input (missing required keys, unknown activation
/// value) returns `nil` — callers surface this as an invalid ability.
enum AbilityFrontmatter {
    struct Fields {
        var name: String
        var description: String
        var activation: AbilityActivation
    }

    struct Parsed {
        var fields: Fields
        /// Body with the leading envelope stripped; retains the trailing
        /// newline structure so round-trip saves don't reflow the file.
        var body: String
    }

    /// Parses a full `.md` file. Returns `nil` if the envelope is missing or
    /// the required fields are malformed.
    static func parse(_ contents: String) -> Parsed? {
        let normalized = contents.replacingOccurrences(of: "\r\n", with: "\n")
        // Envelope must start with exactly `---\n`.
        guard normalized.hasPrefix("---\n") else { return nil }
        let afterOpen = normalized.index(normalized.startIndex, offsetBy: 4)
        guard let closeRange = normalized.range(of: "\n---\n", range: afterOpen..<normalized.endIndex)
                ?? normalized.range(of: "\n---", range: afterOpen..<normalized.endIndex) else {
            return nil
        }
        let yamlSection = String(normalized[afterOpen..<closeRange.lowerBound])
        let bodyStart = closeRange.upperBound
        let body = bodyStart < normalized.endIndex ? String(normalized[bodyStart...]) : ""

        var name: String?
        var description: String?
        var activationRaw: String?

        for rawLine in yamlSection.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            guard let colonIdx = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colonIdx]).trimmingCharacters(in: .whitespaces)
            let valueRaw = String(line[line.index(after: colonIdx)...])
                .trimmingCharacters(in: .whitespaces)
            let value = unquote(valueRaw)
            switch key {
            case "name": name = value
            case "description": description = value
            case "activation": activationRaw = value
            default: continue
            }
        }

        guard let name, !name.isEmpty,
              let description,
              let activationRaw,
              let activation = AbilityActivation(rawValue: activationRaw) else {
            return nil
        }

        return Parsed(
            fields: Fields(name: name, description: description, activation: activation),
            body: body
        )
    }

    /// Serializes `fields` + `body` back to a full file string.
    static func serialize(fields: Fields, body: String) -> String {
        let bodyNormalized: String
        if body.isEmpty {
            bodyNormalized = ""
        } else if body.hasPrefix("\n") {
            bodyNormalized = body
        } else {
            bodyNormalized = "\n" + body
        }
        let header = """
        ---
        name: \(escape(fields.name))
        description: \(escape(fields.description))
        activation: \(fields.activation.rawValue)
        ---
        """
        return header + bodyNormalized
    }

    // MARK: - Helpers

    private static func unquote(_ value: String) -> String {
        guard value.count >= 2 else { return value }
        let first = value.first!
        let last = value.last!
        if (first == "\"" && last == "\"") || (first == "'" && last == "'") {
            return String(value.dropFirst().dropLast())
        }
        return value
    }

    /// Wraps the value in double quotes when it contains characters that would
    /// confuse the line parser (colons, leading/trailing whitespace, quotes).
    private static func escape(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        let needsQuoting = trimmed != value
            || trimmed.contains(":")
            || trimmed.contains("\"")
            || trimmed.contains("'")
            || trimmed.contains("\n")
        if !needsQuoting { return trimmed }
        let escaped = trimmed
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"\(escaped)\""
    }
}
