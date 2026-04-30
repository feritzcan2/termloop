// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Minimal read-only markdown renderer shared by every TermLoop surface.
/// Handles YAML frontmatter, headers, paragraphs, bullets, fenced code,
/// horizontal rules, and inline bold/italic/code via `AttributedString`.
/// Unrecognized lines fall through as plain paragraphs so content is never
/// dropped.
struct MarkdownRenderer: View {
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: MarkdownTheme.blockSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                render(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Parsed block model

    fileprivate enum Block {
        case frontmatter(String)
        case header(level: Int, text: String)
        case paragraph(String)
        case bullet([String])
        case codeBlock(String)
        case rule
    }

    private var blocks: [Block] {
        Self.cache.blocks(for: content)
    }

    private static let cache = BlockCache()

    private final class BlockCache: @unchecked Sendable {
        private var lastContent: String = ""
        private var lastBlocks: [Block] = []
        private let lock = NSLock()

        func blocks(for content: String) -> [Block] {
            lock.lock()
            defer { lock.unlock() }
            if content == lastContent { return lastBlocks }
            let parsed = MarkdownRenderer.parse(content)
            lastContent = content
            lastBlocks = parsed
            return parsed
        }
    }

    fileprivate static func parse(_ raw: String) -> [Block] {
        var blocks: [Block] = []
        var lines = raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        if lines.first?.trimmingCharacters(in: .whitespaces) == "---" {
            var i = 1
            var fm: [String] = []
            var closed = false
            while i < lines.count {
                let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
                if trimmed == "---" { closed = true; i += 1; break }
                fm.append(lines[i])
                i += 1
            }
            if closed {
                blocks.append(.frontmatter(fm.joined(separator: "\n")))
                lines = Array(lines.dropFirst(i))
            }
        }

        var paragraph: [String] = []
        var bullets: [String] = []
        var codeLines: [String] = []
        var inCode = false

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph.removeAll()
            }
        }
        func flushBullets() {
            if !bullets.isEmpty {
                blocks.append(.bullet(bullets))
                bullets.removeAll()
            }
        }

        for rawLine in lines {
            let line = rawLine
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                if inCode {
                    blocks.append(.codeBlock(codeLines.joined(separator: "\n")))
                    codeLines.removeAll()
                    inCode = false
                } else {
                    flushParagraph(); flushBullets()
                    inCode = true
                }
                continue
            }
            if inCode { codeLines.append(line); continue }

            if trimmed.isEmpty {
                flushParagraph(); flushBullets()
                continue
            }
            if trimmed == "---" || trimmed == "***" {
                flushParagraph(); flushBullets()
                blocks.append(.rule)
                continue
            }
            if trimmed.hasPrefix("#") {
                flushParagraph(); flushBullets()
                let hashCount = trimmed.prefix { $0 == "#" }.count
                let text = trimmed.drop(while: { $0 == "#" })
                    .trimmingCharacters(in: .whitespaces)
                blocks.append(.header(level: min(hashCount, 6), text: text))
                continue
            }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                flushParagraph()
                bullets.append(String(trimmed.dropFirst(2)))
                continue
            }

            flushBullets()
            paragraph.append(line)
        }
        if inCode {
            blocks.append(.codeBlock(codeLines.joined(separator: "\n")))
        }
        flushParagraph(); flushBullets()
        return blocks
    }

    // MARK: Render

    @ViewBuilder
    private func render(_ block: Block) -> some View {
        switch block {
        case .frontmatter(let text):
            Text(text)
                .font(MarkdownTheme.caption)
                .foregroundColor(.secondary)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(MarkdownTheme.frontmatterBg)
                .overlay(Rectangle().stroke(MarkdownTheme.codeBorder, lineWidth: 1))

        case .header(let level, let text):
            Text(text)
                .font(MarkdownTheme.heading(level: level))
                .padding(.top, MarkdownTheme.headingTopPadding(level: level))

        case .paragraph(let text):
            Text(renderInline(text))
                .font(MarkdownTheme.body)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)

        case .bullet(let items):
            VStack(alignment: .leading, spacing: MarkdownTheme.bulletSpacing) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: "•")
                            .font(MarkdownTheme.bullet)
                            .foregroundColor(.secondary)
                        Text(renderInline(item))
                            .font(MarkdownTheme.bullet)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                }
            }

        case .codeBlock(let text):
            Text(text)
                .font(MarkdownTheme.code)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(MarkdownTheme.codePadding)
                .background(MarkdownTheme.codeBg)
                .overlay(Rectangle().stroke(MarkdownTheme.codeBorder, lineWidth: 1))
                .textSelection(.enabled)

        case .rule:
            Rectangle()
                .fill(MarkdownTheme.rule)
                .frame(height: 1)
                .padding(.vertical, 4)
        }
    }

    private func renderInline(_ text: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: opts))
            ?? AttributedString(text)
    }
}
