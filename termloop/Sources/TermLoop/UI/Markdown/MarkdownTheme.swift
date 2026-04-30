// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Typography + spacing tokens shared by every markdown surface in TermLoop.
/// Hierarchy: H1 22 / H2 18 / H3 15 / H4+ 13 / body 13 / code 12 / caption 10.
/// Matches the monospace brutalist direction in TermLoopSidebarTheme but uses
/// proportional fonts for prose (so long markdown stays readable).
enum MarkdownTheme {
    // Headings — proportional, bold.
    static let h1: Font = .system(size: 22, weight: .bold)
    static let h2: Font = .system(size: 18, weight: .bold)
    static let h3: Font = .system(size: 15, weight: .bold)
    static let h4: Font = .system(size: 13, weight: .bold)

    // Body / inline.
    static let body: Font = .system(size: 13)
    static let bullet: Font = .system(size: 13)
    static let caption: Font = .system(size: 10, design: .monospaced)

    // Code — monospaced.
    static let code: Font = .system(size: 12, design: .monospaced)
    static let codeEditor: Font = .system(size: 13, design: .monospaced)

    // Spacing.
    static let blockSpacing: CGFloat = 10
    static let bulletSpacing: CGFloat = 4
    static let containerPaddingH: CGFloat = 22
    static let containerPaddingV: CGFloat = 18
    static let codePadding: CGFloat = 10

    // Surfaces.
    static let codeBg: Color = Color.primary.opacity(0.06)
    static let codeBorder: Color = Color.primary.opacity(0.15)
    static let frontmatterBg: Color = Color.primary.opacity(0.05)
    static let rule: Color = Color.primary.opacity(0.15)

    static func heading(level: Int) -> Font {
        switch level {
        case 1: return h1
        case 2: return h2
        case 3: return h3
        default: return h4
        }
    }

    static func headingTopPadding(level: Int) -> CGFloat {
        level <= 2 ? 8 : 4
    }
}
