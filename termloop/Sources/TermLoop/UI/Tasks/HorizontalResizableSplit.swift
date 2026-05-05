// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// `NSSplitView`-backed horizontal split: top child resizes against bottom child
/// with a draggable divider. Used by the Tasks page's board / detail layout.
///
/// Codex round-2 decision: prefer a fresh `NSSplitView` wrapper over adapting
/// `ResizableSidebarPanelContainer` (which is preset-height + scroll, not a
/// real draggable split, and bringing its sidebar-specific sizing presets into
/// the main area would conflate semantics).
struct HorizontalResizableSplit<Top: View, Bottom: View>: NSViewControllerRepresentable {
    let topMinHeight: CGFloat
    let bottomMinHeight: CGFloat
    @ViewBuilder let top: () -> Top
    @ViewBuilder let bottom: () -> Bottom

    init(
        topMinHeight: CGFloat = 200,
        bottomMinHeight: CGFloat = 140,
        @ViewBuilder top: @escaping () -> Top,
        @ViewBuilder bottom: @escaping () -> Bottom
    ) {
        self.topMinHeight = topMinHeight
        self.bottomMinHeight = bottomMinHeight
        self.top = top
        self.bottom = bottom
    }

    func makeNSViewController(context: Context) -> NSSplitViewController {
        let controller = NSSplitViewController()
        controller.splitView.isVertical = false
        controller.splitView.dividerStyle = .thin

        let topItem = NSSplitViewItem(viewController: NSHostingController(rootView: top()))
        topItem.minimumThickness = topMinHeight
        topItem.canCollapse = false
        controller.addSplitViewItem(topItem)

        let bottomItem = NSSplitViewItem(viewController: NSHostingController(rootView: bottom()))
        bottomItem.minimumThickness = bottomMinHeight
        bottomItem.canCollapse = false
        controller.addSplitViewItem(bottomItem)

        return controller
    }

    func updateNSViewController(_ controller: NSSplitViewController, context: Context) {
        if controller.splitViewItems.count >= 1,
           let topHC = controller.splitViewItems[0].viewController as? NSHostingController<Top> {
            topHC.rootView = top()
        }
        if controller.splitViewItems.count >= 2,
           let botHC = controller.splitViewItems[1].viewController as? NSHostingController<Bottom> {
            botHC.rootView = bottom()
        }
    }
}
