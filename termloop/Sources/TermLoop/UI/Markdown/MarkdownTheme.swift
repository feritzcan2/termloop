// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
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

    // Surfaces. Keep markdown/editor panes off pure black in dark mode and
    // give light mode enough structure without turning every block into a card.
    static let surfaceBg: Color = adaptiveColor(
        light: NSColor(red: 0.965, green: 0.972, blue: 0.982, alpha: 1.0),
        dark: NSColor(red: 0.255, green: 0.270, blue: 0.285, alpha: 1.0)
    )
    static let toolbarBg: Color = adaptiveColor(
        light: NSColor(red: 0.935, green: 0.945, blue: 0.958, alpha: 1.0),
        dark: NSColor(red: 0.205, green: 0.218, blue: 0.232, alpha: 1.0)
    )
    static let editorBg: Color = adaptiveColor(
        light: NSColor(red: 0.985, green: 0.988, blue: 0.992, alpha: 1.0),
        dark: NSColor(red: 0.255, green: 0.270, blue: 0.285, alpha: 1.0)
    )
    static let insetBg: Color = adaptiveColor(
        light: NSColor(red: 0.945, green: 0.952, blue: 0.965, alpha: 1.0),
        dark: NSColor(red: 0.190, green: 0.205, blue: 0.220, alpha: 1.0)
    )
    static let codeBg: Color = insetBg
    static let codeBorder: Color = adaptiveColor(
        light: NSColor(red: 0.70, green: 0.73, blue: 0.78, alpha: 0.55),
        dark: NSColor.white.withAlphaComponent(0.18)
    )
    static let frontmatterBg: Color = adaptiveColor(
        light: NSColor(red: 0.930, green: 0.940, blue: 0.955, alpha: 1.0),
        dark: NSColor(red: 0.225, green: 0.240, blue: 0.255, alpha: 1.0)
    )
    static let bodyFg: Color = adaptiveColor(
        light: NSColor(red: 0.090, green: 0.100, blue: 0.115, alpha: 1.0),
        dark: NSColor(red: 0.880, green: 0.895, blue: 0.910, alpha: 1.0)
    )
    static let secondaryFg: Color = adaptiveColor(
        light: NSColor(red: 0.360, green: 0.390, blue: 0.430, alpha: 1.0),
        dark: NSColor(red: 0.700, green: 0.730, blue: 0.760, alpha: 1.0)
    )
    static let rule: Color = codeBorder

    static var nsEditorBackground: NSColor {
        NSColor(name: nil) { appearance in
            isDark(appearance)
                ? NSColor(red: 0.255, green: 0.270, blue: 0.285, alpha: 1.0)
                : NSColor(red: 0.985, green: 0.988, blue: 0.992, alpha: 1.0)
        }
    }

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

    private static func adaptiveColor(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            isDark(appearance) ? dark : light
        })
    }

    private static func isDark(_ appearance: NSAppearance) -> Bool {
        appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
    }
}
