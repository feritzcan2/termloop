// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

// termloop/Sources/TermLoop/Bridge/BridgeCableView.swift
import SwiftUI

/// Vertical connector drawn between two linked workspace rows in the sidebar.
/// Shows message count + lifecycle state. Tapping the badge toggles the inline
/// transcript expansion (state stored on the parent via @Binding). The cable
/// carries two arrow buttons that forward each side's latest assistant message
/// to the opposite side — there is no auto-forwarding.
@MainActor
struct BridgeCableView: View {
    let bridge: WorkspaceBridge
    let rightWorkspaceTitle: String
    @Binding var isExpanded: Bool
    let onForward: (BridgeSender) -> Void
    let onStop: () -> Void
    let onDismiss: () -> Void
    let onJumpToRight: () -> Void
    let onSetForwardMode: (BridgeForwardMode) -> Void

    private var isRunning: Bool {
        if case .running = bridge.state { return true }
        return false
    }

    var body: some View {
        HStack(spacing: 8) {
            cableLine
            badge
                .onTapGesture { isExpanded.toggle() }
            jumpButton
            Spacer()
            controls
        }
        .padding(.vertical, 4)
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(minHeight: 28)
    }

    private var toggleIcon: String {
        isExpanded ? "chevron.up" : "chevron.down"
    }

    private var toggleTooltip: String {
        if isExpanded {
            return String(
                localized: "bridge.cable.transcript.close",
                defaultValue: "Hide transcript",
                table: "TermLoop"
            )
        }
        return String(
            localized: "bridge.cable.transcript.open",
            defaultValue: "Show transcript",
            table: "TermLoop"
        )
    }

    @ViewBuilder private var jumpButton: some View {
        Button(action: onJumpToRight) {
            Text(jumpLabel)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
        }
        .buttonStyle(.borderless)
        .help(String(localized: "bridge.cable.jumpTo",
                     defaultValue: "Jump to linked workspace",
                     table: "TermLoop"))
    }

    @ViewBuilder private var cableLine: some View {
        ZStack {
            LinearGradient(
                gradient: Gradient(colors: [Color(hex: "#8af"), Color(hex: "#f8a")]),
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(width: 2, height: 22)

            Circle()
                .fill(isRunning ? Color.white : badgeForeground.opacity(0.9))
                .frame(width: isRunning ? 6 : 5, height: isRunning ? 6 : 5)
                .shadow(color: badgeForeground.opacity(isRunning ? 0.35 : 0.0), radius: 2)
                .offset(y: indicatorOffset)
                .opacity(indicatorOpacity)
        }
        .frame(width: 10, height: 22)
    }

    private var indicatorOffset: CGFloat {
        switch bridge.state {
        case .running: return -8
        case .stopped: return 8
        }
    }

    private var indicatorOpacity: Double {
        switch bridge.state {
        case .running: return 1
        case .stopped: return 0.55
        }
    }

    @ViewBuilder private var badge: some View {
        HStack(spacing: 4) {
            Text(badgeText)
                .font(.caption2)
                .foregroundStyle(badgeForeground)
            Image(systemName: toggleIcon)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(badgeForeground.opacity(0.85))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(badgeBackground)
        .cornerRadius(10)
        .contentShape(Rectangle())
        .help(toggleTooltip)
    }

    private var badgeText: String {
        switch bridge.state {
        case .running:
            return "\(badgePrefix) \(bridge.messages.count) msg · running"
        case .stopped(let reason):
            return stoppedLabel(reason: reason, count: bridge.messages.count)
        }
    }

    private func stoppedLabel(reason: BridgeStopReason, count: Int) -> String {
        switch reason {
        case .manual:
            return "\(badgePrefix) \(count) msg · stopped"
        case .workspaceClosed:
            return "\(badgePrefix) \(count) msg · workspace closed"
        case .sendTimeout:
            return "\(badgePrefix) \(count) msg · send timeout"
        }
    }

    private var badgePrefix: String {
        bridge.intent == .askAgent ? "\(rightWorkspaceTitle) ·" : "⇄"
    }

    private var jumpLabel: String {
        bridge.intent == .askAgent ? "Open \(rightWorkspaceTitle)" : "↦ \(rightWorkspaceTitle)"
    }

    private var badgeForeground: Color {
        switch bridge.state {
        case .running: return .white
        case .stopped: return .secondary
        }
    }

    private var badgeBackground: Color {
        switch bridge.state {
        case .running: return Color.blue.opacity(0.6)
        case .stopped: return Color.gray.opacity(0.2)
        }
    }

    @ViewBuilder private var controls: some View {
        HStack(spacing: 4) {
            switch bridge.state {
            case .running:
                // Both arrows always bright while the bridge is running. The
                // earlier "isReady" heuristic only tracked the last forwarded
                // sender, which dimmed the button after a forward even when
                // the source had since produced new content. Forward calls
                // already extractor-snapshot the latest assistant message
                // and no-op when nothing's new, so let the user tap freely.
                iconButton(
                    "arrow.down",
                    weight: .semibold,
                    tint: Color.primary,
                    help: String(localized: "bridge.cable.forwardToRight",
                                 defaultValue: "Send latest message ↓ other side",
                                 table: "TermLoop"),
                    action: { onForward(.left) }
                )
                iconButton(
                    "arrow.up",
                    weight: .semibold,
                    tint: Color.primary,
                    help: String(localized: "bridge.cable.forwardToLeft",
                                 defaultValue: "Send latest message ↑ other side",
                                 table: "TermLoop"),
                    action: { onForward(.right) }
                )
                modeMenu
                iconButton(
                    "stop.fill",
                    help: String(localized: "bridge.cable.stop",
                                 defaultValue: "Stop bridge",
                                 table: "TermLoop"),
                    action: onStop
                )
            case .stopped:
                iconButton(
                    "xmark",
                    help: String(localized: "bridge.cable.dismiss",
                                 defaultValue: "Dismiss bridge",
                                 table: "TermLoop"),
                    action: onDismiss
                )
            }
        }
    }

    @ViewBuilder private var modeMenu: some View {
        let current = bridge.effectiveForwardMode
        let isArmed = current == .auto
        Button {
            onSetForwardMode(isArmed ? .manual : .auto)
        } label: {
            Text(isArmed
                ? String(localized: "bridge.cable.mode.tag.armed",
                         defaultValue: "auto next",
                         table: "TermLoop")
                : String(localized: "bridge.cable.mode.tag.arm",
                         defaultValue: "auto",
                         table: "TermLoop"))
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(isArmed ? TermLoopSidebarTheme.accent : Color.secondary)
                .frame(minWidth: 40, minHeight: 18)
                .padding(.horizontal, 4)
                .background(
                    RoundedRectangle(cornerRadius: 3)
                        .stroke(
                            isArmed
                                ? TermLoopSidebarTheme.accent.opacity(0.6)
                                : Color.secondary.opacity(0.3),
                            lineWidth: 0.5
                        )
                )
        }
        .buttonStyle(.borderless)
        .help(isArmed
            ? String(localized: "bridge.cable.mode.help.armed",
                     defaultValue: "Auto-forward armed for the next agent reply. Click to cancel.",
                     table: "TermLoop")
            : String(localized: "bridge.cable.mode.help.arm",
                     defaultValue: "Click to auto-forward the next agent reply (one-shot). Otherwise use the arrow buttons.",
                     table: "TermLoop"))
    }

    private func iconButton(
        _ systemName: String,
        weight: Font.Weight = .regular,
        tint: Color = .primary,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 10, weight: weight))
                .foregroundStyle(tint)
                .frame(width: 18, height: 18)
        }
        .buttonStyle(.borderless)
        .help(help)
    }
}

// Minimal hex helper — if Color(hex:) already exists in TermLoop, remove
// this extension.
private extension Color {
    init(hex: String) {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        var rgb: UInt64 = 0
        Scanner(string: s).scanHexInt64(&rgb)
        let r = Double((rgb & 0xff0000) >> 16) / 255
        let g = Double((rgb & 0x00ff00) >> 8) / 255
        let b = Double(rgb & 0x0000ff) / 255
        self = Color(red: r, green: g, blue: b)
    }
}
