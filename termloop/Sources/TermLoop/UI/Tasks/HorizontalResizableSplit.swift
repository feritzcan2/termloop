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
    let bottomPreferredFraction: CGFloat
    @ViewBuilder let top: () -> Top
    @ViewBuilder let bottom: () -> Bottom

    /// Persisted across leaves of the tab and app restarts. `0` is the
    /// sentinel for "never resized" so we can fall back to
    /// `bottomPreferredFraction * availableHeight`. Stored as `Double`
    /// because `@AppStorage` does not bridge `CGFloat` directly.
    @AppStorage("termloop.taskBoard.bottomHeight") private var savedBottomHeightDouble: Double = 0
    @State private var dragStartBottomHeight: CGFloat?

    private var savedBottomHeight: CGFloat? {
        savedBottomHeightDouble > 0 ? CGFloat(savedBottomHeightDouble) : nil
    }

    init(
        topMinHeight: CGFloat = 260,
        bottomMinHeight: CGFloat = 190,
        bottomPreferredFraction: CGFloat = 0.35,
        @ViewBuilder top: @escaping () -> Top,
        @ViewBuilder bottom: @escaping () -> Bottom
    ) {
        self.topMinHeight = topMinHeight
        self.bottomMinHeight = bottomMinHeight
        self.bottomPreferredFraction = bottomPreferredFraction
        self.top = top
        self.bottom = bottom
    }

    var body: some View {
        GeometryReader { proxy in
            let availableHeight = max(0, proxy.size.height)
            let dividerHeight: CGFloat = 8
            let maxBottom = max(bottomMinHeight, availableHeight - topMinHeight - dividerHeight)
            // Default split (when never resized): bottom takes
            // `bottomPreferredFraction` of the available height, scaling with
            // the window. 0.35 = ~65% board / 35% terminal.
            let preferredBottom = max(bottomMinHeight, availableHeight * bottomPreferredFraction)
            let resolvedBottom = clamped(
                savedBottomHeight ?? preferredBottom,
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
        // Track + grip both use `Color.primary` so they have real contrast in
        // both modes. The previous `separatorColor.opacity(0.65)` + `secondary`
        // grip were near-invisible in light mode, hiding the resize affordance
        // entirely.
        Rectangle()
            .fill(Color.primary.opacity(0.08))
            .overlay(
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(Color.primary.opacity(0.32))
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
                        let next = clamped(
                            start - value.translation.height,
                            min: bottomMinHeight,
                            max: maxBottom
                        )
                        savedBottomHeightDouble = Double(next)
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
