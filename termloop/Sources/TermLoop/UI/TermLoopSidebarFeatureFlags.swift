// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation
import SwiftUI

/// Pre-set color treatments for the selected-workspace row in the sidebar.
/// Writing one of these to the `sidebarSelectionColorHex` UserDefaults key
/// (which the upstream `sidebarSelectedWorkspaceBackgroundNSColor` reads on
/// every render) overrides the default Mac blue gradient. The set mirrors
/// `docs/mockups/sidebar-selection-colors.html`.
enum SidebarSelectionVariant: String, CaseIterable, Identifiable {
    case macBlue
    case graphite
    case accentBar
    case softBlue
    case amber
    case violet
    case teal
    case rose
    case outline
    case elevated

    var id: String { rawValue }

    /// Hex used for the row fill. `nil` means "leave UserDefaults unset" so
    /// the upstream termloop default (system accent / mac blue) wins. Variants
    /// whose mockup relies on alpha/border (accent-bar, soft-blue, outline,
    /// elevated) use the best-fitting single-hex approximation — the
    /// upstream `NSColor(hex:)` only accepts solid RGB.
    var hex: String? {
        switch self {
        case .macBlue:   return nil
        case .graphite:  return "#2A2C33"
        case .accentBar: return "#E8F0FF"
        case .softBlue:  return "#A9C5FF"
        case .amber:     return "#EF8F1A"
        case .violet:    return "#5A3CE6"
        case .teal:      return "#149687"
        case .rose:      return "#E14A78"
        case .outline:   return "#9A9DA6"
        case .elevated:  return "#FBFBFD"
        }
    }

    var displayName: String {
        switch self {
        case .macBlue:   return "Mac Blue (default)"
        case .graphite:  return "Graphite"
        case .accentBar: return "Accent bar (low-noise tint)"
        case .softBlue:  return "Soft blue"
        case .amber:     return "Amber"
        case .violet:    return "Violet"
        case .teal:      return "Teal"
        case .rose:      return "Rose"
        case .outline:   return "Outline (neutral)"
        case .elevated:  return "Elevated (near-white)"
        }
    }

    /// Color shown in the picker swatch.
    var swatchColor: Color {
        if let hex, let nsColor = NSColor(hex: hex) {
            return Color(nsColor: nsColor)
        }
        return Color.accentColor
    }
}

/// Persisted on/off toggles for the TermLoop sidebar tweaks added via the
/// "sidebar settings" popover. Each flag is UserDefaults-backed so it survives
/// app restarts. Views observe this shared instance to react live when a
/// toggle changes.
@MainActor
final class TermLoopSidebarFeatureFlags: ObservableObject {
    static let shared = TermLoopSidebarFeatureFlags()

    // Focus-first defaults: avoid unsolicited sidebar motion until the user
    // explicitly opts into those experiments.
    static let defaultHighlightSelectedEpicRow = true
    static let defaultAutoCollapseUnselectedEpic = false
    static let defaultBubbleWorkspaceOnResponse = false
    static let defaultSinkStaleEpics = false
    static let defaultDelayEpicUnsinkOnClick = false

    @Published var hideWorkspaceDescription: Bool {
        didSet { defaults.set(hideWorkspaceDescription, forKey: Key.hideWorkspaceDescription) }
    }

    @Published var showEpicUnreadDot: Bool {
        didSet { defaults.set(showEpicUnreadDot, forKey: Key.showEpicUnreadDot) }
    }

    @Published var showEpicRunningDot: Bool {
        didSet { defaults.set(showEpicRunningDot, forKey: Key.showEpicRunningDot) }
    }

    @Published var highlightSelectedEpicRow: Bool {
        didSet { defaults.set(highlightSelectedEpicRow, forKey: Key.highlightSelectedEpicRow) }
    }

    @Published var autoCollapseUnselectedEpic: Bool {
        didSet { defaults.set(autoCollapseUnselectedEpic, forKey: Key.autoCollapseUnselectedEpic) }
    }

    @Published var bubbleWorkspaceOnResponse: Bool {
        didSet { defaults.set(bubbleWorkspaceOnResponse, forKey: Key.bubbleWorkspaceOnResponse) }
    }

    @Published var sinkStaleEpics: Bool {
        didSet { defaults.set(sinkStaleEpics, forKey: Key.sinkStaleEpics) }
    }

    @Published var delayEpicUnsinkOnClick: Bool {
        didSet { defaults.set(delayEpicUnsinkOnClick, forKey: Key.delayEpicUnsinkOnClick) }
    }

    @Published var autoCollapseSeconds: Double {
        didSet { defaults.set(autoCollapseSeconds, forKey: Key.autoCollapseSeconds) }
    }

    @Published var staleThresholdSeconds: Double {
        didSet { defaults.set(staleThresholdSeconds, forKey: Key.staleThresholdSeconds) }
    }

    @Published var epicUnsinkDelaySeconds: Double {
        didSet { defaults.set(epicUnsinkDelaySeconds, forKey: Key.epicUnsinkDelaySeconds) }
    }

    @Published var selectedWorkspaceColorVariant: String {
        didSet {
            defaults.set(selectedWorkspaceColorVariant, forKey: Key.selectedWorkspaceColorVariant)
            let variant = SidebarSelectionVariant(rawValue: selectedWorkspaceColorVariant) ?? .macBlue
            if let hex = variant.hex {
                defaults.set(hex, forKey: Self.upstreamSelectionColorHexKey)
            } else {
                defaults.removeObject(forKey: Self.upstreamSelectionColorHexKey)
            }
            NotificationCenter.default.post(name: .termLoopSidebarSelectionColorChanged, object: nil)
        }
    }

    /// Upstream-cmux UserDefaults key consumed by
    /// `sidebarSelectedWorkspaceBackgroundNSColor` in `ContentView.swift`.
    private static let upstreamSelectionColorHexKey = "sidebarSelectionColorHex"

    private let defaults = UserDefaults.standard

    private enum Key {
        static let hideWorkspaceDescription = "termloop.sidebar.hideWorkspaceDescription"
        static let showEpicUnreadDot = "termloop.sidebar.showEpicUnreadDot"
        static let showEpicRunningDot = "termloop.sidebar.showEpicRunningDot"
        static let highlightSelectedEpicRow = "termloop.sidebar.highlightSelectedEpicRow"
        static let autoCollapseUnselectedEpic = "termloop.sidebar.autoCollapseUnselectedEpic"
        static let bubbleWorkspaceOnResponse = "termloop.sidebar.bubbleWorkspaceOnResponse"
        static let sinkStaleEpics = "termloop.sidebar.sinkStaleEpics"
        static let delayEpicUnsinkOnClick = "termloop.sidebar.delayEpicUnsinkOnClick"
        static let autoCollapseSeconds = "termloop.sidebar.autoCollapseSeconds"
        static let staleThresholdSeconds = "termloop.sidebar.staleThresholdSeconds"
        static let epicUnsinkDelaySeconds = "termloop.sidebar.epicUnsinkDelaySeconds"
        static let selectedWorkspaceColorVariant = "termloop.sidebar.selectedWorkspaceColorVariant"
    }

    private init() {
        let d = UserDefaults.standard
        self.hideWorkspaceDescription = d.object(forKey: Key.hideWorkspaceDescription) as? Bool ?? true
        self.showEpicUnreadDot = d.object(forKey: Key.showEpicUnreadDot) as? Bool ?? true
        self.showEpicRunningDot = d.object(forKey: Key.showEpicRunningDot) as? Bool ?? true
        self.highlightSelectedEpicRow = d.object(forKey: Key.highlightSelectedEpicRow) as? Bool
            ?? Self.defaultHighlightSelectedEpicRow
        self.autoCollapseUnselectedEpic = d.object(forKey: Key.autoCollapseUnselectedEpic) as? Bool
            ?? Self.defaultAutoCollapseUnselectedEpic
        self.bubbleWorkspaceOnResponse = d.object(forKey: Key.bubbleWorkspaceOnResponse) as? Bool
            ?? Self.defaultBubbleWorkspaceOnResponse
        self.sinkStaleEpics = d.object(forKey: Key.sinkStaleEpics) as? Bool
            ?? Self.defaultSinkStaleEpics
        self.delayEpicUnsinkOnClick = d.object(forKey: Key.delayEpicUnsinkOnClick) as? Bool
            ?? Self.defaultDelayEpicUnsinkOnClick
        self.autoCollapseSeconds = d.object(forKey: Key.autoCollapseSeconds) as? Double ?? 10
        self.staleThresholdSeconds = d.object(forKey: Key.staleThresholdSeconds) as? Double ?? 40
        self.epicUnsinkDelaySeconds = d.object(forKey: Key.epicUnsinkDelaySeconds) as? Double ?? 5
        self.selectedWorkspaceColorVariant = d.string(forKey: Key.selectedWorkspaceColorVariant)
            ?? SidebarSelectionVariant.macBlue.rawValue
    }
}

extension Notification.Name {
    static let termLoopSidebarSelectionColorChanged = Notification.Name("termloop.sidebar.selectionColorChanged")
}
