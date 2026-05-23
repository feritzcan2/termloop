// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

@MainActor
enum AgentSidebarPanelHeightPreset: String, CaseIterable {
    case small
    case medium
    case large
    case xLarge
    case unlimited

    var shortLabel: String {
        switch self {
        case .small: return "S"
        case .medium: return "M"
        case .large: return "L"
        case .xLarge: return "XL"
        case .unlimited: return "∞"
        }
    }
}

@MainActor
enum AgentSidebarPanelSizing {
    static let unlimitedSentinel = -1.0

    static func currentPreset(
        for storageKey: String,
        mediumHeight: CGFloat,
        defaults: UserDefaults = .standard
    ) -> AgentSidebarPanelHeightPreset {
        let value = defaults.object(forKey: storageKey) as? Double ?? unlimitedSentinel
        if value == unlimitedSentinel {
            return .unlimited
        }

        let options: [(AgentSidebarPanelHeightPreset, Double)] = [
            (.small, 72),
            (.medium, Double(mediumHeight)),
            (.large, max(300, Double(mediumHeight) * 1.75)),
            (.xLarge, max(440, Double(mediumHeight) * 2.4)),
        ]
        return options.min(by: { abs($0.1 - value) < abs($1.1 - value) })?.0 ?? .medium
    }

    static func height(
        for preset: AgentSidebarPanelHeightPreset,
        mediumHeight: CGFloat
    ) -> CGFloat? {
        switch preset {
        case .small:
            return 72
        case .medium:
            return mediumHeight
        case .large:
            return max(300, mediumHeight * 1.75)
        case .xLarge:
            return max(440, mediumHeight * 2.4)
        case .unlimited:
            return nil
        }
    }

    static func apply(
        preset: AgentSidebarPanelHeightPreset,
        to storageKey: String,
        mediumHeight: CGFloat,
        defaults: UserDefaults = .standard
    ) {
        let value = height(for: preset, mediumHeight: mediumHeight).map(Double.init) ?? unlimitedSentinel
        defaults.set(value, forKey: storageKey)
    }

    static func cycle(
        storageKey: String,
        mediumHeight: CGFloat,
        defaults: UserDefaults = .standard
    ) {
        let current = currentPreset(for: storageKey, mediumHeight: mediumHeight, defaults: defaults)
        let next: AgentSidebarPanelHeightPreset
        switch current {
        case .small: next = .medium
        case .medium: next = .large
        case .large: next = .xLarge
        case .xLarge: next = .unlimited
        case .unlimited: next = .small
        }
        apply(preset: next, to: storageKey, mediumHeight: mediumHeight, defaults: defaults)
    }

    static var cycleHelpText: String {
        String(
            localized: "sidebar.panelSize.cycle.help",
            defaultValue: "Cycle panel size",
            table: "TermLoop"
        )
    }
}

@MainActor
enum AgentSidebarPanelLayoutState {
    static let worktreeOpenPRsHeightKey = "termloop.sidebar.loop.worktreeOpenPRsHeight.v4"
    static let worktreeMergedPRsHeightKey = "termloop.sidebar.loop.worktreeMergedPRsHeight.v4"
    static let worktreeAgentsHeightKey = "termloop.sidebar.loop.worktreeAgentsHeight.v4"
    static let activeLoopHeightKey = "termloop.sidebar.loop.activeAgentsPanelHeight.v4"
    static let abilitiesHeightKey = "termloop.sidebar.agents.abilitiesPanelHeight.v4"
}

@MainActor
struct AgentSidebarPanelSizeCycleButton: View {
    let storageKey: String
    let mediumHeight: CGFloat

    @AppStorage private var storedHeight: Double

    init(storageKey: String, mediumHeight: CGFloat) {
        self.storageKey = storageKey
        self.mediumHeight = mediumHeight
        self._storedHeight = AppStorage(wrappedValue: AgentSidebarPanelSizing.unlimitedSentinel, storageKey)
    }

    var body: some View {
        Button {
            AgentSidebarPanelSizing.cycle(
                storageKey: storageKey,
                mediumHeight: mediumHeight
            )
            storedHeight = UserDefaults.standard.object(forKey: storageKey) as? Double
                ?? AgentSidebarPanelSizing.unlimitedSentinel
        } label: {
            Text(verbatim: AgentSidebarPanelSizing.currentPreset(
                for: storageKey,
                mediumHeight: mediumHeight
            ).shortLabel)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .frame(width: 24)
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .help(AgentSidebarPanelSizing.cycleHelpText)
    }
}

@MainActor
struct ResizableSidebarPanelContainer<Content: View>: View {
    private let storageKey: String
    private let mediumHeight: CGFloat
    private let minHeight: CGFloat
    private let content: () -> Content

    @AppStorage private var storedHeight: Double

    init(
        storageKey: String,
        mediumHeight: CGFloat,
        minHeight: CGFloat = 140,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.storageKey = storageKey
        self.mediumHeight = mediumHeight
        self.minHeight = minHeight
        self.content = content
        self._storedHeight = AppStorage(wrappedValue: AgentSidebarPanelSizing.unlimitedSentinel, storageKey)
    }

    private var currentPreset: AgentSidebarPanelHeightPreset {
        if storedHeight == AgentSidebarPanelSizing.unlimitedSentinel {
            return .unlimited
        }
        return AgentSidebarPanelSizing.currentPreset(
            for: storageKey,
            mediumHeight: mediumHeight
        )
    }

    private var resolvedHeight: CGFloat? {
        AgentSidebarPanelSizing.height(for: currentPreset, mediumHeight: mediumHeight)
            .map { max(minHeight, $0) }
    }

    var body: some View {
        Group {
            if let resolvedHeight {
                ScrollView(.vertical, showsIndicators: true) {
                    content()
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .frame(height: resolvedHeight)
                .clipped()
                .modifier(ClearScrollBackground())
            } else {
                content()
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }
}
