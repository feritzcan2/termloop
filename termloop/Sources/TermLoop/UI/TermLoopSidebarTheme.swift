// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Visual vocabulary for the TermLoop sidebar redesign.
///
/// Direction: **monospace brutalist** — every header, counter, footer token
/// uses SF Mono. Hierarchy comes from case (UPPER for sections, lower for
/// rows), weight, and the single accent color. No rounded corners on row
/// backgrounds, thin horizontal rules for section separation, tight 22pt
/// rows.
enum TermLoopSidebarTheme {
    // MARK: - Metrics

    static let rowHeight: CGFloat = 22
    static let headerRowHeight: CGFloat = 28
    static let rowInsetH: CGFloat = 10
    static let ruleThickness: CGFloat = 1

    // MARK: - Colors
    //
    // All resolved against `.primary` / `.accentColor` so they automatically
    // adapt to light/dark appearance and user accent-color preferences.

    // Light-mode surfaces are tuned to sit on top of the translucent `.sidebar`
    // NSVisualEffectView material so the chrome reads like a native macOS
    // sidebar (Finder/Mail/Clarc) — soft hairlines and almost-imperceptible
    // tinted backgrounds, not painted opaque rectangles. Dark-mode values are
    // intentionally left as-is.
    static let rule: Color = dynamicSurface(
        light: NSColor.black.withAlphaComponent(0.07),
        dark:  NSColor.white.withAlphaComponent(0.08)
    )
    static let ruleStrong: Color = dynamicSurface(
        light: NSColor.black.withAlphaComponent(0.11),
        dark:  NSColor.white.withAlphaComponent(0.14)
    )
    static let hoverBg: Color = dynamicSurface(
        light: NSColor.black.withAlphaComponent(0.045),
        dark:  NSColor.white.withAlphaComponent(0.05)
    )
    static let groupHeaderBg: Color = dynamicSurface(
        light: NSColor.black.withAlphaComponent(0.022),
        dark:  NSColor.white.withAlphaComponent(0.00)
    )
    static let groupHeaderBorder: Color = dynamicSurface(
        light: NSColor.black.withAlphaComponent(0.06),
        dark:  NSColor.white.withAlphaComponent(0.00)
    )
    static let activeBg: Color = Color.accentColor.opacity(0.12)
    static let accent: Color = Color.accentColor
    /// Secondary/tertiary semantic label colors give much better contrast
    /// in light mode while still reading correctly in dark mode.
    static let dim: Color = Color(nsColor: .secondaryLabelColor)
    static let dimmer: Color = Color(nsColor: .tertiaryLabelColor)
    static let stateReady: Color = dynamicSurface(
        light: NSColor(red: 0.36, green: 0.39, blue: 0.44, alpha: 1.0),
        dark:  NSColor.white.withAlphaComponent(0.68)
    )
    static let stateRunning: Color = dynamicSurface(
        light: NSColor(red: 0.05, green: 0.48, blue: 0.25, alpha: 1.0),
        dark:  NSColor(red: 0.90, green: 0.48, blue: 0.08, alpha: 1.0)
    )
    // Light-mode hue pulled toward a cooler ochre (less pure orange) so the
    // 7%-opacity row wash that flags `needsInput` rows reads as a soft
    // straw tint instead of cream/peach. Dark mode keeps its warmer amber
    // since the wash there is barely perceptible.
    static let stateNeedsInput: Color = dynamicSurface(
        light: NSColor(red: 0.58, green: 0.42, blue: 0.10, alpha: 1.0),
        dark:  NSColor(red: 0.76, green: 0.58, blue: 0.08, alpha: 1.0)
    )
    static let stateCompleted: Color = dynamicSurface(
        light: NSColor(red: 0.12, green: 0.48, blue: 0.30, alpha: 1.0),
        dark:  NSColor(red: 0.05, green: 0.52, blue: 0.28, alpha: 1.0)
    )
    static let stateError: Color = dynamicSurface(
        light: NSColor(red: 0.70, green: 0.16, blue: 0.13, alpha: 1.0),
        dark:  NSColor(red: 0.79, green: 0.24, blue: 0.21, alpha: 1.0)
    )
    static let gitDirty: Color = dynamicSurface(
        light: NSColor(red: 0.62, green: 0.34, blue: 0.04, alpha: 1.0),
        dark:  NSColor(red: 0.64, green: 0.36, blue: 0.09, alpha: 1.0)
    )

    // Jira ticket chip — used by the worktree row's ticket binding. The
    // upstream Jira brand yellow (#F7C700) is unreadable as foreground on a
    // light sidebar (yellow-on-white), so light mode swaps to a deep amber
    // text on an ivory fill, while dark mode keeps the brand yellow which
    // sits well on the dark sidebar surface.
    static let jiraChipForeground: Color = dynamicSurface(
        light: NSColor(red: 0.52, green: 0.34, blue: 0.02, alpha: 1.0),
        dark:  NSColor(red: 0.97, green: 0.78, blue: 0.00, alpha: 1.0)
    )
    static let jiraChipBackground: Color = dynamicSurface(
        light: NSColor(red: 0.99, green: 0.94, blue: 0.78, alpha: 1.0),
        dark:  NSColor(red: 0.97, green: 0.78, blue: 0.00, alpha: 0.18)
    )
    static let jiraChipBorder: Color = dynamicSurface(
        light: NSColor(red: 0.78, green: 0.58, blue: 0.10, alpha: 0.55),
        dark:  NSColor(red: 0.97, green: 0.78, blue: 0.00, alpha: 0.55)
    )

    // Agent-brand accents for the agent-name suffix in row metadata. In dark
    // mode each agent keeps its hue (Claude purple, Codex blue, Gemini green,
    // Aider amber) so the row metadata stays scannable. In light mode the
    // brand tints are dropped entirely — color in the sidebar carries *state*
    // (running / needsInput / completed / error), and the agent label collapses
    // to plain `secondaryLabelColor`. The brand identity lives in the agent's
    // main-area chrome where it isn't competing with status signals.
    static let claudeAccent: Color = dynamicAccent(
        light: NSColor.secondaryLabelColor,
        dark:  NSColor(red: 0.78, green: 0.55, blue: 0.95, alpha: 1.0)
    )
    static let codexAccent: Color = dynamicAccent(
        light: NSColor.secondaryLabelColor,
        dark:  NSColor(red: 0.40, green: 0.70, blue: 1.00, alpha: 1.0)
    )
    static let geminiAccent: Color = dynamicAccent(
        light: NSColor.secondaryLabelColor,
        dark:  NSColor(red: 0.42, green: 0.78, blue: 0.62, alpha: 1.0)
    )
    static let aiderAccent: Color = dynamicAccent(
        light: NSColor.secondaryLabelColor,
        dark:  NSColor(red: 0.95, green: 0.62, blue: 0.40, alpha: 1.0)
    )

    /// Builds an appearance-adaptive `Color` from explicit light/dark
    /// `NSColor` values. Used for agent-brand accents because the same
    /// hex looks neon on dark and washed-out on light — picking each
    /// variant by hand keeps both modes legible.
    private static func dynamicAccent(light: NSColor, dark: NSColor) -> Color {
        dynamicSurface(light: light, dark: dark)
    }

    private static func dynamicSurface(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(
                from: [.darkAqua, .vibrantDark]
            ) != nil
            return isDark ? dark : light
        })
    }

    // MARK: - Fonts
    //
    // Explicit sizes so hierarchy is legible at a glance:
    //   sectionCaps — UPPER project/epic tags with letter-spacing
    //   headerLabel — project name in the top strip
    //   bodyMono    — standard row text (epic names, workspace labels)
    //   tinyMono    — counts, port numbers, tag pills
    //   microCaps   — dev-build marker and similar annotations

    static let headerLabel: Font = .system(size: 12, weight: .semibold, design: .monospaced)
    static let sectionCaps: Font = .system(size: 10, weight: .semibold, design: .monospaced)
    static let bodyMono: Font = .system(size: 11, weight: .regular, design: .monospaced)
    static let bodyMonoStrong: Font = .system(size: 11, weight: .semibold, design: .monospaced)
    static let tinyMono: Font = .system(size: 10, weight: .regular, design: .monospaced)
    static let microCaps: Font = .system(size: 9, weight: .bold, design: .monospaced)

    // MARK: - Helpers

    /// Uppercase with a tracked-out kern (for CAPS section headers).
    static func caps(_ text: String) -> AttributedString {
        var attr = AttributedString(text.uppercased())
        attr.kern = 1.2
        return attr
    }

    /// Plain Title Case section title — same layout in light and dark.
    /// Replaces the previous brutalist UPPER + tracked kern look so headers
    /// read like native macOS sidebar section labels (Finder/Mail). Color
    /// is the only thing that differs between modes (see
    /// `adaptiveSectionColor`).
    static func adaptiveSectionTitle(_ text: String) -> AttributedString {
        AttributedString(text)
    }

    /// Section header font, paired with `adaptiveSectionTitle`. System
    /// semibold in both modes — no SF Mono. Size remains caller-controlled
    /// so each section can keep its own metric.
    static func adaptiveSectionFont(size: CGFloat = 11) -> Font {
        .system(size: size, weight: .semibold)
    }

    /// `secondaryLabelColor` auto-adapts to appearance, so this single call
    /// gives the soft-gray section header in light mode and the lighter
    /// gray in dark mode without any branching.
    static var adaptiveSectionColor: Color {
        Color(nsColor: .secondaryLabelColor)
    }

    static func color(for state: TerminalAgentDisplayState) -> Color {
        switch state {
        case .ready:      return stateReady
        case .running:    return stateRunning
        case .needsInput: return stateNeedsInput
        case .completed:  return stateCompleted
        case .error:      return stateError
        case .idle:       return dim
        }
    }

    /// Returns a brand tint for the agent-name suffix shown in row metadata
    /// (e.g. "Claude Code", "Codex CLI"). Matches case-insensitively against
    /// the labels surfaced by `AgentRowPresentationSnapshot.agentLabel`.
    /// Falls back to `dim` so unknown agents stay neutral.
    static func agentAccent(for label: String) -> Color {
        let normalized = label.lowercased()
        if normalized.contains("claude") { return claudeAccent }
        if normalized.contains("codex")  { return codexAccent }
        if normalized.contains("gemini") { return geminiAccent }
        if normalized.contains("aider")  { return aiderAccent }
        return dim
    }

    static func iconName(for state: TerminalAgentDisplayState) -> String {
        switch state {
        case .ready:      return "circle.fill"
        case .running:    return "circle.fill"
        case .needsInput: return "bell.fill"
        case .completed:  return "checkmark.circle.fill"
        case .error:      return "exclamationmark.triangle.fill"
        case .idle:       return "circle"
        }
    }

    /// Relative-time label used by every agent row ("5s", "12m"). Coarse by
    /// design — elapsed is refreshed whenever the row's memoized snapshot is
    /// re-evaluated; idle rows can go a few seconds stale between telemetry
    /// ticks and that is acceptable.
    static func elapsedLabel(since: Date) -> String {
        let elapsed = Int(Date().timeIntervalSince(since))
        if elapsed < 60 { return "\(elapsed)s" }
        return "\(elapsed / 60)m"
    }
}

enum TermLoopSidebarTokenTone {
    case neutral
    case accent
    case muted
    case warning
}

struct TermLoopSidebarToken: View {
    let label: String
    var iconSystemName: String? = nil
    var tone: TermLoopSidebarTokenTone = .neutral
    var emphasized: Bool = false

    var body: some View {
        HStack(spacing: 4) {
            if let iconSystemName {
                Image(systemName: iconSystemName)
                    .font(.system(size: 8.5, weight: .semibold))
            }
            Text(verbatim: label)
                .lineLimit(1)
                .truncationMode(.middle)
                .monospacedDigit()
        }
        // Tokens render as plain colored text in both modes — capsule
        // background + border were dropped so the sidebar stops looking
        // like a wall of pills. Color carries tone (accent / warning /
        // dim); the row's leading accent strip carries state.
        .fixedSize(horizontal: true, vertical: false)
        .font(emphasized ? TermLoopSidebarTheme.microCaps : TermLoopSidebarTheme.tinyMono)
        .foregroundStyle(foregroundColor)
    }

    private var foregroundColor: Color {
        switch tone {
        case .neutral:
            return Color.primary.opacity(emphasized ? 0.9 : 0.72)
        case .accent:
            return TermLoopSidebarTheme.accent.opacity(0.96)
        case .muted:
            return TermLoopSidebarTheme.dim
        case .warning:
            return Color.orange.opacity(0.96)
        }
    }
}

/// Thin full-width horizontal rule that reads as a single hairline in both
/// light and dark mode. Used to separate the project header, epic groups,
/// and the footer from their neighbors.
struct TermLoopSidebarRule: View {
    var strong: Bool = false

    var body: some View {
        Rectangle()
            .fill(strong ? TermLoopSidebarTheme.ruleStrong : TermLoopSidebarTheme.rule)
            .frame(height: TermLoopSidebarTheme.ruleThickness)
    }
}

/// Subtle hover-only row background. Applied via `.background(...)` so the
/// host row owns its own padding/hit-testing and the state change is
/// isolated to this decoration.
struct TermLoopSidebarRowBackground: View {
    let isActive: Bool
    let isHovering: Bool

    var body: some View {
        Rectangle()
            .fill(isActive
                  ? TermLoopSidebarTheme.activeBg
                  : (isHovering ? TermLoopSidebarTheme.hoverBg : Color.clear))
    }
}
