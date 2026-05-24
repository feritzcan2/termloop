// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Pure transforms for TermLoop-owned entries in Codex `config.toml`.
///
/// TermLoop owns only the root `codex_hooks` key and the
/// `[mcp_servers.termloop]` table subtree. Comments are breadcrumbs; TOML
/// table boundaries define what may be replaced.
enum CodexConfigToml {
    struct Mutation: Equatable {
        let content: String
        let changed: Bool
    }

    static let managedBlockBegin = "# TermLoop-managed: BEGIN"
    static let managedBlockEnd = "# TermLoop-managed: END"

    static func installTransform(_ content: String) -> Mutation {
        let normalizedContent = normalizeAttachedMarkers(content)
        var lines = splitLines(normalizedContent)
        ensureRootCodexHooksEnabled(lines: &lines)

        let canonical = splitLines(canonicalMCPBlock())
        var ranges = termLoopMCPTableRanges(in: lines)

        if ranges.isEmpty {
            appendCanonicalBlock(to: &lines, canonical: canonical)
        } else {
            let first = ranges.removeFirst()
            lines.replaceSubrange(first, with: canonical)
            for range in ranges.reversed() {
                lines.removeSubrange(range)
            }
        }

        let updated = lines.joined()
        return Mutation(content: updated, changed: updated != content)
    }

    static func uninstallTransform(_ content: String) -> Mutation {
        let normalizedContent = normalizeAttachedMarkers(content)
        var lines = splitLines(normalizedContent)

        for range in termLoopMCPTableRanges(in: lines).reversed() {
            lines.removeSubrange(range)
        }

        let updated = lines.joined()
        return Mutation(content: updated, changed: updated != content)
    }

    static func canonicalMCPBlock() -> String {
        """
        \(managedBlockBegin)
        [mcp_servers.termloop]
        command = "/bin/sh"
        args = ["-lc", "exec \\"${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}\\" termloop-mcp"]
        \(managedBlockEnd)
        """ + "\n"
    }

    private static func normalizeAttachedMarkers(_ content: String) -> String {
        content
            .replacingOccurrences(of: "\(managedBlockBegin)[", with: "\(managedBlockBegin)\n[")
            .replacingOccurrences(of: "\(managedBlockEnd)[", with: "\(managedBlockEnd)\n[")
    }

    private static func appendCanonicalBlock(to lines: inout [String], canonical: [String]) {
        if lines.isEmpty {
            lines.append(contentsOf: canonical)
            return
        }
        if !lines[lines.count - 1].hasSuffix("\n") {
            lines[lines.count - 1].append("\n")
        }
        if lines.last?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            lines.append("\n")
        }
        lines.append(contentsOf: canonical)
    }

    private static func ensureRootCodexHooksEnabled(lines: inout [String]) {
        let rootEnd = lines.firstIndex { tableHeader(in: $0) != nil } ?? lines.endIndex

        for index in 0..<rootEnd {
            guard let assignment = assignmentKey(in: lines[index]),
                  assignment.key == "codex_hooks" else {
                continue
            }
            let updated = "\(assignment.leading)codex_hooks = true\(assignment.trailingComment)\(assignment.newline)"
            lines[index] = updated
            return
        }

        if lines.isEmpty {
            lines.append("codex_hooks = true\n")
        } else {
            lines.insert("codex_hooks = true\n", at: 0)
            if lines.count > 1,
               !lines[1].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                lines.insert("\n", at: 1)
            }
        }
    }

    private static func termLoopMCPTableRanges(in lines: [String]) -> [Range<Int>] {
        var ranges: [Range<Int>] = []
        var index = 0

        while index < lines.count {
            guard isTermLoopMCPHeader(lines[index]) else {
                index += 1
                continue
            }
            let start = index > 0 && isManagedBeginLine(lines[index - 1])
                ? index - 1
                : index
            var end = index + 1
            while end < lines.count {
                if let header = tableHeader(in: lines[end]),
                   !isTermLoopMCPSubtree(header.name) {
                    break
                }
                end += 1
            }
            if end < lines.count, isManagedEndLine(lines[end]) {
                end += 1
            }
            ranges.append(start..<end)
            index = end
        }

        return ranges
    }

    private static func isTermLoopMCPHeader(_ line: String) -> Bool {
        guard let header = tableHeader(in: line), !header.isArray else { return false }
        return isTermLoopMCPSubtree(header.name)
    }

    private static func isManagedBeginLine(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == managedBlockBegin
    }

    private static func isManagedEndLine(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == managedBlockEnd
    }

    private struct TableHeader {
        let name: String
        let isArray: Bool
    }

    private static func tableHeader(in line: String) -> TableHeader? {
        let body = bodyWithoutNewline(line)
        let uncommented = String(body.prefix(upTo: unquotedHashIndex(in: body) ?? body.endIndex))
            .trimmingCharacters(in: .whitespaces)
        let isArray = uncommented.hasPrefix("[[") && uncommented.hasSuffix("]]")
        let isTable = uncommented.hasPrefix("[") && uncommented.hasSuffix("]")
        guard isTable else {
            return nil
        }
        let innerStart = uncommented.index(
            uncommented.startIndex,
            offsetBy: isArray ? 2 : 1
        )
        let innerEnd = uncommented.index(
            uncommented.endIndex,
            offsetBy: isArray ? -2 : -1
        )
        return TableHeader(
            name: String(uncommented[innerStart..<innerEnd]).trimmingCharacters(in: .whitespaces),
            isArray: isArray
        )
    }

    private static func isTermLoopMCPSubtree(_ name: String) -> Bool {
        isTermLoopMCPTableName(name)
            || name.hasPrefix("mcp_servers.termloop.")
            || name.hasPrefix("mcp_servers.\"termloop\".")
            || name.hasPrefix("mcp_servers.'termloop'.")
    }

    private static func isTermLoopMCPTableName(_ name: String) -> Bool {
        name == "mcp_servers.termloop"
            || name == "mcp_servers.\"termloop\""
            || name == "mcp_servers.'termloop'"
    }

    private static func assignmentKey(in line: String) -> (
        key: String,
        leading: String,
        trailingComment: String,
        newline: String
    )? {
        let newline = line.hasSuffix("\n") ? "\n" : ""
        let body = bodyWithoutNewline(line)
        let commentStart = unquotedHashIndex(in: body) ?? body.endIndex
        let uncommented = body[..<commentStart]
        guard let equals = uncommented.firstIndex(of: "=") else { return nil }

        let keyPart = String(uncommented[..<equals])
        let leadingLength = keyPart.prefix { $0 == " " || $0 == "\t" }.count
        let leading = String(keyPart.prefix(leadingLength))
        let key = keyPart.trimmingCharacters(in: .whitespaces)
        let trailingComment = commentStart < body.endIndex ? String(body[commentStart...]) : ""
        return (key, leading, trailingComment.isEmpty ? "" : " \(trailingComment)", newline)
    }

    private static func bodyWithoutNewline(_ line: String) -> Substring {
        if line.hasSuffix("\n") {
            return line.dropLast()
        }
        return Substring(line)
    }

    private static func unquotedHashIndex(in text: Substring) -> Substring.Index? {
        var quote: Character?
        var escaped = false
        var index = text.startIndex

        while index < text.endIndex {
            let ch = text[index]
            if escaped {
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if let active = quote {
                if ch == active {
                    quote = nil
                }
            } else if ch == "\"" || ch == "'" {
                quote = ch
            } else if ch == "#" {
                return index
            }
            index = text.index(after: index)
        }

        return nil
    }

    private static func splitLines(_ content: String) -> [String] {
        guard !content.isEmpty else { return [] }

        var lines: [String] = []
        var start = content.startIndex
        var index = start

        while index < content.endIndex {
            if content[index] == "\n" {
                let next = content.index(after: index)
                lines.append(String(content[start..<next]))
                start = next
            }
            index = content.index(after: index)
        }

        if start < content.endIndex {
            lines.append(String(content[start..<content.endIndex]))
        }

        return lines
    }
}
