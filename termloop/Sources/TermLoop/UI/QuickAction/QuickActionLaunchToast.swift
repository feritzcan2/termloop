// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

final class QuickActionLaunchToast: NSPanel {
    static let visibleDuration: TimeInterval = 2.4
    static let fadeOutDuration: TimeInterval = 0.18

    init(rootView: some View) {
        let contentRect = NSRect(x: 0, y: 0, width: 260, height: 54)
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .statusBar
        hidesOnDeactivate = false
        ignoresMouseEvents = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle, .fullScreenAuxiliary]

        let hosting = NSHostingView(rootView: rootView)
        hosting.autoresizingMask = [.width, .height]
        hosting.frame = contentRect
        contentView = hosting
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class QuickActionLaunchToastController {
    static let shared = QuickActionLaunchToastController()

    private var panel: QuickActionLaunchToast?
    private var hideTimer: Timer?

    private init() {}

    func show(title: String, subtitle: String?) {
        hideTimer?.invalidate()

        let view = QuickActionLaunchToastView(title: title, subtitle: subtitle)
        if let existing = panel {
            existing.contentView = NSHostingView(rootView: view)
        } else {
            panel = QuickActionLaunchToast(rootView: view)
        }
        guard let panel else { return }
        place(panel)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.14
            panel.animator().alphaValue = 1
        }

        hideTimer = Timer.scheduledTimer(
            withTimeInterval: QuickActionLaunchToast.visibleDuration,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in self?.dismiss() }
        }
    }

    func dismiss() {
        guard let panel else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = QuickActionLaunchToast.fadeOutDuration
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                self?.panel?.orderOut(nil)
            }
        })
    }

    private func place(_ panel: NSPanel) {
        let screen = NSScreen.main ?? NSScreen.screens.first
        guard let visibleFrame = screen?.visibleFrame else { return }
        let frame = panel.frame
        let origin = NSPoint(
            x: visibleFrame.maxX - frame.width - 24,
            y: visibleFrame.maxY - frame.height - 24
        )
        panel.setFrameOrigin(origin)
    }
}

private struct QuickActionLaunchToastView: View {
    let title: String
    let subtitle: String?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.accentColor)
                .frame(width: 28, height: 28)
                .background(
                    Circle().fill(Color.accentColor.opacity(0.15))
                )
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(.regularMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
        )
    }
}
