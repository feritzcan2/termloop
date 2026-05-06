// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Horizontal-divider split used by the Tasks board.
///
/// This intentionally keeps the bottom inspector/terminal height stable while
/// the window is resized: the board absorbs the extra/shrinking height. The old
/// NSSplitView fraction-based wrapper rebalanced both panes during window
/// resizes, which made the bottom pane feel squeezed from both directions.
struct HorizontalResizableSplit<Top: View, Bottom: View>: View {
    let topMinHeight: CGFloat
    let bottomMinHeight: CGFloat
    let bottomPreferredHeight: CGFloat
    @ViewBuilder let top: () -> Top
    @ViewBuilder let bottom: () -> Bottom

    @State private var committedBottomHeight: CGFloat?
    @State private var dragStartBottomHeight: CGFloat?

    init(
        topMinHeight: CGFloat = 260,
        bottomMinHeight: CGFloat = 190,
        bottomPreferredHeight: CGFloat = 280,
        @ViewBuilder top: @escaping () -> Top,
        @ViewBuilder bottom: @escaping () -> Bottom
    ) {
        self.topMinHeight = topMinHeight
        self.bottomMinHeight = bottomMinHeight
        self.bottomPreferredHeight = bottomPreferredHeight
        self.top = top
        self.bottom = bottom
    }

    var body: some View {
        GeometryReader { proxy in
            let availableHeight = max(0, proxy.size.height)
            let dividerHeight: CGFloat = 8
            let maxBottom = max(bottomMinHeight, availableHeight - topMinHeight - dividerHeight)
            let resolvedBottom = clamped(
                committedBottomHeight ?? bottomPreferredHeight,
                min: bottomMinHeight,
                max: maxBottom
            )
            let topHeight = max(topMinHeight, availableHeight - resolvedBottom - dividerHeight)

            VStack(spacing: 0) {
                top()
                    .frame(maxWidth: .infinity)
                    .frame(height: topHeight)
                    .clipped()

                divider(currentBottomHeight: resolvedBottom, maxBottom: maxBottom)
                    .frame(height: dividerHeight)

                bottom()
                    .frame(maxWidth: .infinity)
                    .frame(height: resolvedBottom)
                    .clipped()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

    private func divider(currentBottomHeight: CGFloat, maxBottom: CGFloat) -> some View {
        Rectangle()
            .fill(Color(nsColor: .separatorColor).opacity(0.65))
            .overlay(
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(Color.secondary.opacity(0.22))
                    .frame(width: 46, height: 3)
            )
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let start = dragStartBottomHeight ?? currentBottomHeight
                        if dragStartBottomHeight == nil {
                            dragStartBottomHeight = currentBottomHeight
                        }
                        committedBottomHeight = clamped(
                            start - value.translation.height,
                            min: bottomMinHeight,
                            max: maxBottom
                        )
                    }
                    .onEnded { _ in
                        dragStartBottomHeight = nil
                    }
            )
            .help(String(localized: "tasks.split.resizeHelp",
                         defaultValue: "Drag to resize board details", table: "TermLoop"))
    }

    private func clamped(_ value: CGFloat, min minValue: CGFloat, max maxValue: CGFloat) -> CGFloat {
        Swift.max(minValue, Swift.min(value, maxValue))
    }
}
