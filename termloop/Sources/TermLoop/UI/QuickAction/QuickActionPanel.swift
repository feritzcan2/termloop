// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Borderless, non-activating HUD panel that hosts the Quick Action palette.
///
/// Key-input handling: `.nonactivatingPanel` does not steal frontmost app
/// focus, and by default also would not become key window — which would
/// route keystrokes back to the previously frontmost app. We override
/// `canBecomeKey` to return `true` so the search field can accept
/// keystrokes without activating cmux. This is the Spotlight/Raycast
/// pattern and is verified manually (see spec §10.3 step 1).
final class QuickActionPanel: NSPanel {
    static let canonicalWidth: CGFloat = 760
    private enum Layout {
        static let runHeight: CGFloat = 420
        static let runAdvancedHeight: CGFloat = 760
        static let worktreeHeight: CGFloat = 720
        static let worktreeAdvancedHeight: CGFloat = 900
    }

    init(rootView: some View) {
        let contentRect = NSRect(x: 0, y: 0, width: Self.canonicalWidth, height: Layout.runHeight)
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        self.isFloatingPanel = true
        self.level = .floating
        self.hidesOnDeactivate = true
        self.isMovableByWindowBackground = false
        self.titleVisibility = .hidden
        self.titlebarAppearsTransparent = true
        self.isReleasedWhenClosed = false
        self.hasShadow = true
        self.backgroundColor = .clear
        self.collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle, .fullScreenAuxiliary]
        self.animationBehavior = .utilityWindow

        let hostingView = NSHostingView(rootView: AnyView(rootView))
        hostingView.autoresizingMask = [.width, .height]
        hostingView.frame = contentRect
        self.contentView = hostingView
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// Center the panel on the screen containing the mouse cursor. Raycast
    /// convention. Fallback to the main screen.
    func centerOnMouseScreen() {
        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSMouseInRect(mouseLocation, $0.frame, false) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen else { return }
        let frame = self.frame
        let x = screen.visibleFrame.midX - frame.width / 2
        let y = screen.visibleFrame.midY - frame.height / 2 + 120 // slightly above vertical center
        self.setFrameOrigin(NSPoint(x: x, y: y))
    }

    func applyCanonicalLayout(
        surface: QuickActionSurface,
        isAdvancedOpen: Bool
    ) {
        let height: CGFloat = switch surface {
        case .run:
            isAdvancedOpen ? Layout.runAdvancedHeight : Layout.runHeight
        case .worktree:
            isAdvancedOpen ? Layout.worktreeAdvancedHeight : Layout.worktreeHeight
        }
        setContentSize(NSSize(width: Self.canonicalWidth, height: height))
    }
}
