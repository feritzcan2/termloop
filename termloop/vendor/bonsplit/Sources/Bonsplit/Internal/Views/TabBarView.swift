import SwiftUI
import AppKit
import UniformTypeIdentifiers

private struct SelectedTabFramePreferenceKey: PreferenceKey {
    static let defaultValue: CGRect? = nil

    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) {
        if let next = nextValue() {
            value = next
        }
    }
}

enum TabBarStyling {
    static func separatorSegments(
        totalWidth: CGFloat,
        gap: ClosedRange<CGFloat>?
    ) -> (left: CGFloat, right: CGFloat) {
        let clampedTotal = max(0, totalWidth)
        guard let gap else {
            return (left: clampedTotal, right: 0)
        }

        let start = min(max(gap.lowerBound, 0), clampedTotal)
        let end = min(max(gap.upperBound, 0), clampedTotal)
        let normalizedStart = min(start, end)
        let normalizedEnd = max(start, end)
        let left = max(0, normalizedStart)
        let right = max(0, clampedTotal - normalizedEnd)
        return (left: left, right: right)
    }
}

struct TabContextMenuState: Equatable {
    let isPinned: Bool
    let isUnread: Bool
    let isBrowser: Bool
    let isTerminal: Bool
    let hasCustomTitle: Bool
    let canCloseToLeft: Bool
    let canCloseToRight: Bool
    let canCloseOthers: Bool
    let canMoveToLeftPane: Bool
    let canMoveToRightPane: Bool
    let isZoomed: Bool
    let hasSplits: Bool
    let shortcuts: [TabContextAction: KeyboardShortcut]

    var canMarkAsUnread: Bool {
        !isUnread
    }

    var canMarkAsRead: Bool {
        isUnread
    }
}

/// Tab bar view with scrollable tabs, drag/drop support, and split buttons
struct TabBarView: View {
    @Environment(BonsplitController.self) private var controller
    @Environment(SplitViewController.self) private var splitViewController
    
    @Bindable var pane: PaneState
    let isFocused: Bool
    var showSplitButtons: Bool = true

    @AppStorage("workspacePresentationMode") private var presentationMode = "standard"
    @AppStorage("debugFadeColorStyle") private var fadeColorStyle = 0
    @State private var isHoveringTabBar = false
    @State private var dropTargetIndex: Int?
    @State private var dropLifecycle: TabDropLifecycle = .idle
    @State private var scrollOffset: CGFloat = 0
    @State private var contentWidth: CGFloat = 0
    @State private var containerWidth: CGFloat = 0
    @State private var selectedTabFrameInBar: CGRect?
    @StateObject private var controlKeyMonitor = TabControlShortcutKeyMonitor()

    private var canScrollLeft: Bool {
        scrollOffset > 1
    }

    private var canScrollRight: Bool {
        // contentWidth includes the 30pt drop zone after tabs.
        let tabsWidth = contentWidth - 30
        guard tabsWidth > containerWidth + 4 else { return false }
        return scrollOffset < tabsWidth - containerWidth
    }

    /// Whether this tab bar should show full saturation (focused or drag source)
    private var shouldShowFullSaturation: Bool {
        isFocused || splitViewController.dragSourcePaneId == pane.id
    }

    private var tabBarSaturation: Double {
        shouldShowFullSaturation ? 1.0 : 0.0
    }

    private var appearance: BonsplitConfiguration.Appearance {
        controller.configuration.appearance
    }

    private var showsControlShortcutHints: Bool {
        isFocused && controlKeyMonitor.isShortcutHintVisible
    }


    var body: some View {
        HStack(spacing: 0) {
            if appearance.tabBarLeadingInset > 0 && controller.internalController.rootNode.allPaneIds.first == pane.id {
                TabBarDragZoneView { return false }
                    .frame(width: appearance.tabBarLeadingInset)
            }
            // Scrollable tabs with fade overlays
            GeometryReader { containerGeo in
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: TabBarMetrics.tabSpacing) {
                            ForEach(Array(pane.tabs.enumerated()), id: \.element.id) { index, tab in
                                tabItem(for: tab, at: index)
                                    .id(tab.id)
                            }

                            // Unified drop zone after the last tab.
                            dropZoneAfterTabs
                        }
                        .padding(.horizontal, TabBarMetrics.barPadding)
                        .padding(.trailing, showSplitButtons ? 114 : 0)
                        .animation(nil, value: pane.tabs.map(\.id))
                        .background(
                            GeometryReader { contentGeo in
                                Color.clear
                                    .onChange(of: contentGeo.frame(in: .named("tabScroll"))) { _, newFrame in
                                        scrollOffset = -newFrame.minX
                                        contentWidth = newFrame.width
                                    }
                                    .onAppear {
                                        let frame = contentGeo.frame(in: .named("tabScroll"))
                                        scrollOffset = -frame.minX
                                        contentWidth = frame.width
                                    }
                            }
                        )
                    }
                    // When the tab strip is shorter than the visible area, allow dropping in the
                    // empty trailing space without forcing tabs to stretch.
                    .overlay(alignment: .trailing) {
                        let trailing = max(0, containerGeo.size.width - contentWidth)
                        if trailing >= 1 {
                            TabBarDragZoneView {
                                guard splitViewController.isInteractive else { return false }
                                controller.requestNewTab(kind: "terminal", inPane: pane.id)
                                return true
                            }
                            .frame(width: trailing, height: TabBarMetrics.tabHeight)
                            .onDrop(of: [.tabTransfer], delegate: TabDropDelegate(
                                targetIndex: pane.tabs.count,
                                pane: pane,
                                bonsplitController: controller,
                                controller: splitViewController,
                                dropTargetIndex: $dropTargetIndex,
                                dropLifecycle: $dropLifecycle
                            ))
                        }
                    }
                    .coordinateSpace(name: "tabScroll")
                    .onAppear {
                        containerWidth = containerGeo.size.width
                        if let tabId = pane.selectedTabId {
                            proxy.scrollTo(tabId, anchor: .center)
                        }
                    }
                    .onChange(of: containerGeo.size.width) { _, newWidth in
                        containerWidth = newWidth
                    }
                    .onChange(of: pane.selectedTabId) { _, newTabId in
                        if let tabId = newTabId {
                            withTransaction(Transaction(animation: nil)) {
                                proxy.scrollTo(tabId, anchor: .center)
                            }
                        }
                    }
                }
                .frame(height: TabBarMetrics.barHeight)
                .mask(combinedMask)
                // Split buttons sit on top of the tab strip in their own opaque backdrop.
                // The backdrop visually obscures any tabs that scroll under the buttons,
                // and (critically) does not break hit testing on tabs outside the backdrop —
                // unlike the prior approach of using a `Color.clear` region in `combinedMask`,
                // which silently blocked SwiftUI hit tests in the masked-out area and let
                // tab clicks fall through to `TabBarDragAndHoverView` (which performs a
                // window drag in minimal mode).
                .overlay(alignment: .trailing) {
                    if showSplitButtons {
                        let shouldShow = presentationMode != "minimal" || isHoveringTabBar
                        let backdropColor = Color(nsColor: Self.buttonBackdropColor(
                            for: appearance,
                            focused: isFocused,
                            style: fadeColorStyle
                        ))
                        ZStack(alignment: .trailing) {
                            HStack(spacing: 0) {
                                LinearGradient(
                                    colors: [backdropColor.opacity(0), backdropColor],
                                    startPoint: .leading,
                                    endPoint: .trailing
                                )
                                .frame(width: 24)
                                Rectangle().fill(backdropColor)
                            }
                            .frame(width: 114)

                            splitButtons
                                .saturation(tabBarSaturation)
                        }
                        .padding(.bottom, 1)
                        .opacity(shouldShow ? 1 : 0)
                        .allowsHitTesting(shouldShow)
                        .animation(.easeInOut(duration: 0.14), value: shouldShow)
                    }
                }
            }
        }
        .frame(height: TabBarMetrics.barHeight)
        .coordinateSpace(name: "tabBar")
        .background(tabBarBackground)
        .background(TabBarDragAndHoverView(
            isMinimalMode: presentationMode == "minimal",
            onHoverChanged: { isHoveringTabBar = $0 }
        ))
        .background(
            TabBarHostWindowReader { window in
                controlKeyMonitor.setHostWindow(window)
            }
            .frame(width: 0, height: 0)
        )
        // Clear drop state when drag ends elsewhere (cancelled, dropped in another pane, etc.)
        .onChange(of: splitViewController.draggingTab) { _, newValue in
#if DEBUG
            dlog(
                "tab.dragState pane=\(pane.id.id.uuidString.prefix(5)) " +
                "draggingTab=\(newValue != nil ? 1 : 0) " +
                "activeDragTab=\(splitViewController.activeDragTab != nil ? 1 : 0)"
            )
#endif
            if newValue == nil {
                dropTargetIndex = nil
                dropLifecycle = .idle
            }
        }
        .onAppear {
            controlKeyMonitor.start()
        }
        .onPreferenceChange(SelectedTabFramePreferenceKey.self) { frame in
            selectedTabFrameInBar = frame
        }
        .onDisappear {
            controlKeyMonitor.stop()
        }
    }

    // MARK: - Tab Item

    @ViewBuilder
    private func tabItem(for tab: TabItem, at index: Int) -> some View {
        let contextMenuState = contextMenuState(for: tab, at: index)
        let showsZoomIndicator = splitViewController.zoomedPaneId == pane.id && pane.selectedTabId == tab.id
        TabItemView(
            tab: tab,
            isSelected: pane.selectedTabId == tab.id,
            showsZoomIndicator: showsZoomIndicator,
            appearance: appearance,
            saturation: tabBarSaturation,
            controlShortcutDigit: tabControlShortcutDigit(for: index, tabCount: pane.tabs.count),
            showsControlShortcutHint: showsControlShortcutHints,
            shortcutModifierSymbol: controlKeyMonitor.shortcutModifierSymbol,
            contextMenuState: contextMenuState,
            onSelect: {
                // Tab selection must be instant. Animating this transaction causes the pane
                // content (often swapped via opacity) to crossfade, which is undesirable for
                // terminal/browser surfaces.
#if DEBUG
                dlog("tab.select pane=\(pane.id.id.uuidString.prefix(5)) tab=\(tab.id.uuidString.prefix(5)) title=\"\(tab.title)\"")
#endif
                withTransaction(Transaction(animation: nil)) {
                    pane.selectTab(tab.id)
                    controller.focusPane(pane.id)
                }
            },
            onClose: {
                guard !tab.isPinned else { return }
                // Close should be instant (no fade-out/removal animation).
#if DEBUG
                dlog("tab.close pane=\(pane.id.id.uuidString.prefix(5)) tab=\(tab.id.uuidString.prefix(5)) title=\"\(tab.title)\"")
#endif
                withTransaction(Transaction(animation: nil)) {
                    controller.onTabCloseRequest?(TabID(id: tab.id), pane.id)
                    _ = controller.closeTab(TabID(id: tab.id), inPane: pane.id)
                }
            },
            onZoomToggle: {
                _ = splitViewController.togglePaneZoom(pane.id)
            },
            onContextAction: { action in
                controller.requestTabContextAction(action, for: TabID(id: tab.id), inPane: pane.id)
            }
        )
        .equatable()
        .background(
            GeometryReader { geometry in
                Color.clear.preference(
                    key: SelectedTabFramePreferenceKey.self,
                    value: pane.selectedTabId == tab.id
                        ? geometry.frame(in: .named("tabBar"))
                        : nil
                )
            }
        )
        .onDrag {
            createItemProvider(for: tab)
        } preview: {
            TabDragPreview(tab: tab, appearance: appearance)
        }
        .onDrop(of: [.tabTransfer], delegate: TabDropDelegate(
            targetIndex: index,
            pane: pane,
            bonsplitController: controller,
            controller: splitViewController,
            dropTargetIndex: $dropTargetIndex,
            dropLifecycle: $dropLifecycle
        ))
        .overlay(alignment: .leading) {
            if dropTargetIndex == index {
                dropIndicator
                    .saturation(tabBarSaturation)
            }
        }
    }

    private func contextMenuState(for tab: TabItem, at index: Int) -> TabContextMenuState {
        let leftTabs = pane.tabs.prefix(index)
        let canCloseToLeft = leftTabs.contains(where: { !$0.isPinned })
        let canCloseToRight: Bool
        if (index + 1) < pane.tabs.count {
            canCloseToRight = pane.tabs.suffix(from: index + 1).contains(where: { !$0.isPinned })
        } else {
            canCloseToRight = false
        }
        let canCloseOthers = pane.tabs.enumerated().contains { itemIndex, item in
            itemIndex != index && !item.isPinned
        }
        return TabContextMenuState(
            isPinned: tab.isPinned,
            isUnread: tab.showsNotificationBadge,
            isBrowser: tab.kind == "browser",
            isTerminal: tab.kind == "terminal",
            hasCustomTitle: tab.hasCustomTitle,
            canCloseToLeft: canCloseToLeft,
            canCloseToRight: canCloseToRight,
            canCloseOthers: canCloseOthers,
            canMoveToLeftPane: controller.adjacentPane(to: pane.id, direction: .left) != nil,
            canMoveToRightPane: controller.adjacentPane(to: pane.id, direction: .right) != nil,
            isZoomed: splitViewController.zoomedPaneId == pane.id,
            hasSplits: splitViewController.rootNode.allPaneIds.count > 1,
            shortcuts: controller.contextMenuShortcuts
        )
    }

    // MARK: - Item Provider

    private func createItemProvider(for tab: TabItem) -> NSItemProvider {
        #if DEBUG
        NSLog("[Bonsplit Drag] createItemProvider for tab: \(tab.title)")
        #endif
#if DEBUG
        dlog("tab.dragStart pane=\(pane.id.id.uuidString.prefix(5)) tab=\(tab.id.uuidString.prefix(5)) title=\"\(tab.title)\"")
#endif
        // Clear any stale drop indicator from previous incomplete drag
        dropTargetIndex = nil
        dropLifecycle = .idle

        // Set drag source for visual feedback (observable) and drop delegates (non-observable).
        splitViewController.dragGeneration += 1
        splitViewController.draggingTab = tab
        splitViewController.dragSourcePaneId = pane.id
        splitViewController.activeDragTab = tab
        splitViewController.activeDragSourcePaneId = pane.id

        // Install a one-shot mouse-up monitor to clear stale drag state if the drag is
        // cancelled (dropped outside any valid target). SwiftUI's onDrag doesn't provide
        // a drag-cancelled callback, so performDrop never fires and draggingTab stays set,
        // which disables hit testing on all content views.
        let controller = splitViewController
        let dragGen = controller.dragGeneration
        var monitorRef: Any?
        monitorRef = NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { event in
            // One-shot: remove ourselves, then clean up stale drag state.
            if let m = monitorRef {
                NSEvent.removeMonitor(m)
                monitorRef = nil
            }
            // Use async to avoid mutating @Observable state during event dispatch.
            DispatchQueue.main.async {
                guard controller.dragGeneration == dragGen else { return }
                if controller.draggingTab != nil || controller.activeDragTab != nil {
#if DEBUG
                    dlog("tab.dragCancel (stale draggingTab cleared)")
#endif
                    controller.draggingTab = nil
                    controller.dragSourcePaneId = nil
                    controller.activeDragTab = nil
                    controller.activeDragSourcePaneId = nil
                }
            }
            return event
        }

        let transfer = TabTransferData(tab: tab, sourcePaneId: pane.id.id)
        if let data = try? JSONEncoder().encode(transfer) {
            let provider = NSItemProvider()
            provider.registerDataRepresentation(
                forTypeIdentifier: UTType.tabTransfer.identifier,
                visibility: .ownProcess
            ) { completion in
                completion(data, nil)
                return nil
            }
#if DEBUG
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) {
                let types = NSPasteboard(name: .drag).types?.map(\.rawValue).joined(separator: ",") ?? "-"
                dlog("tab.dragPasteboard types=\(types)")
            }
#endif
            return provider
        }
        return NSItemProvider()
    }

    private func tabControlShortcutDigit(for index: Int, tabCount: Int) -> Int? {
        for digit in 1...9 {
            if tabIndexForControlShortcutDigit(digit, tabCount: tabCount) == index {
                return digit
            }
        }
        return nil
    }

    private func tabIndexForControlShortcutDigit(_ digit: Int, tabCount: Int) -> Int? {
        guard tabCount > 0, digit >= 1, digit <= 9 else { return nil }
        if digit == 9 {
            return tabCount - 1
        }
        let index = digit - 1
        return index < tabCount ? index : nil
    }

    // MARK: - Drop Zone at End

    @ViewBuilder
    private var dropZoneAfterTabs: some View {
        TabBarDragZoneView {
            guard splitViewController.isInteractive else { return false }
            controller.requestNewTab(kind: "terminal", inPane: pane.id)
            return true
        }
        .frame(width: 30, height: TabBarMetrics.tabHeight)
        .onDrop(of: [.tabTransfer], delegate: TabDropDelegate(
            targetIndex: pane.tabs.count,
            pane: pane,
            bonsplitController: controller,
            controller: splitViewController,
            dropTargetIndex: $dropTargetIndex,
            dropLifecycle: $dropLifecycle
        ))
        .overlay(alignment: .leading) {
            if dropTargetIndex == pane.tabs.count {
                dropIndicator
                    .saturation(tabBarSaturation)
            }
        }
    }

    // MARK: - Drop Indicator

    @ViewBuilder
    private var dropIndicator: some View {
        Capsule()
            .fill(TabBarColors.dropIndicator(for: appearance))
            .frame(width: TabBarMetrics.dropIndicatorWidth, height: TabBarMetrics.dropIndicatorHeight)
            .offset(x: -1)
    }

    // MARK: - Split Buttons

    @ViewBuilder
    private var splitButtons: some View {
        let tooltips = controller.configuration.appearance.splitButtonTooltips
        HStack(spacing: 4) {
            Button {
                controller.requestNewTab(kind: "terminal", inPane: pane.id)
            } label: {
                Image(systemName: "terminal")
                    .font(.system(size: 12))
            }
            .buttonStyle(SplitActionButtonStyle(appearance: appearance))
            .safeHelp(tooltips.newTerminal)

            Button {
                controller.requestNewTab(kind: "browser", inPane: pane.id)
            } label: {
                Image(systemName: "globe")
                    .font(.system(size: 12))
            }
            .buttonStyle(SplitActionButtonStyle(appearance: appearance))
            .safeHelp(tooltips.newBrowser)

            Button {
                // 120fps animation handled by SplitAnimator
                controller.splitPane(pane.id, orientation: .horizontal)
            } label: {
                Image(systemName: "square.split.2x1")
                    .font(.system(size: 12))
            }
            .buttonStyle(SplitActionButtonStyle(appearance: appearance))
            .safeHelp(tooltips.splitRight)

            Button {
                // 120fps animation handled by SplitAnimator
                controller.splitPane(pane.id, orientation: .vertical)
            } label: {
                Image(systemName: "square.split.1x2")
                    .font(.system(size: 12))
            }
            .buttonStyle(SplitActionButtonStyle(appearance: appearance))
            .safeHelp(tooltips.splitDown)
        }
        .padding(.leading, 6)
        .padding(.trailing, 8)
    }


    private static func buttonBackdropColor(
        for appearance: BonsplitConfiguration.Appearance,
        focused: Bool,
        style: Int
    ) -> NSColor {
        switch style {
        case 1: // raw paneBackground forced opaque
            return TabBarColors.nsColorPaneBackground(for: appearance).withAlphaComponent(1.0)
        case 2: // barBackground (tab bar chrome)
            let c = NSColor(TabBarColors.barBackground(for: appearance))
            return (c.usingColorSpace(.sRGB) ?? c).withAlphaComponent(1.0)
        case 3: // windowBackgroundColor
            return NSColor.windowBackgroundColor.withAlphaComponent(1.0)
        case 4: // controlBackgroundColor
            return NSColor.controlBackgroundColor.withAlphaComponent(1.0)
        case 5: // pre-composited barBackground over windowBg
            let chrome = NSColor(TabBarColors.barBackground(for: appearance))
            let winBg = NSColor.windowBackgroundColor
            guard let fg = chrome.usingColorSpace(.sRGB),
                  let bk = winBg.usingColorSpace(.sRGB) else {
                return chrome.withAlphaComponent(1.0)
            }
            let a: CGFloat = focused ? fg.alphaComponent : fg.alphaComponent * 0.95
            let oneMinusA = 1.0 - a
            let r = fg.redComponent * a + bk.redComponent * oneMinusA
            let g = fg.greenComponent * a + bk.greenComponent * oneMinusA
            let b = fg.blueComponent * a + bk.blueComponent * oneMinusA
            return NSColor(red: r, green: g, blue: b, alpha: 1.0)
        default: // 0: pre-composited paneBackground over windowBg
            return precompositedPaneBackground(for: appearance, focused: focused)
        }
    }

    /// Pre-composite the pane background over the window background to produce
    /// a flat opaque color that matches what .background(barFill) looks like
    /// after compositing. Avoids double-compositing mismatch on overlays.
    private static func precompositedPaneBackground(
        for appearance: BonsplitConfiguration.Appearance,
        focused: Bool
    ) -> NSColor {
        let chrome = TabBarColors.nsColorPaneBackground(for: appearance)
        let winBg = NSColor.windowBackgroundColor
        guard let fg = chrome.usingColorSpace(.sRGB),
              let bk = winBg.usingColorSpace(.sRGB) else {
            return chrome.withAlphaComponent(1.0)
        }
        let a: CGFloat = focused ? fg.alphaComponent : fg.alphaComponent * 0.95
        let oneMinusA = 1.0 - a
        let r = fg.redComponent * a + bk.redComponent * oneMinusA
        let g = fg.greenComponent * a + bk.greenComponent * oneMinusA
        let b = fg.blueComponent * a + bk.blueComponent * oneMinusA
        return NSColor(red: r, green: g, blue: b, alpha: 1.0)
    }

    // MARK: - Combined Mask (scroll fades + button area)
    //
    // IMPORTANT: SwiftUI's `.mask()` with `Color.clear` regions blocks hit testing on the
    // masked content in those regions. Previously this mask used a 90pt clear region at the
    // trailing edge to hide tabs under the split buttons; that caused clicks on tabs in that
    // 90pt area to fall through the masked ScrollView to the `TabBarDragAndHoverView`
    // background, which (in minimal mode) interpreted the click as a window drag instead
    // of a tab tap. Keep the entire mask opaque so hit testing works on every tab; the split
    // buttons' opaque backdrop (rendered in the splitButtons overlay) handles the visual
    // obscuring of tabs underneath.

    @ViewBuilder
    private var combinedMask: some View {
        let fadeWidth: CGFloat = 24
        HStack(spacing: 0) {
            // Left scroll fade
            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                .frame(width: canScrollLeft ? fadeWidth : 0)

            // Visible content area (always opaque so hit testing reaches the tabs)
            Rectangle().fill(Color.black)

            // Right scroll fade only when scroll content actually overflows.
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: canScrollRight ? fadeWidth : 0)
        }
    }

    // MARK: - Fade Overlays

    /// Mask that fades scroll content at the edges instead of overlaying
    /// a colored gradient. The mask uses black (visible) → clear (hidden),
    /// so the tab bar background shows through naturally with no compositing.
    @ViewBuilder
    private var fadeOverlays: some View {
        let fadeWidth: CGFloat = 24
        HStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                .frame(width: canScrollLeft ? fadeWidth : 0)

            Rectangle().fill(Color.black)

            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: canScrollRight ? fadeWidth : 0)
        }
    }

    // MARK: - Background

    @ViewBuilder
    private var tabBarBackground: some View {
        let barFill = isFocused
            ? TabBarColors.barBackground(for: appearance)
            : TabBarColors.barBackground(for: appearance).opacity(0.95)

        Rectangle()
            .fill(barFill)
            .overlay(alignment: .bottom) {
                GeometryReader { geometry in
                    let separator = TabBarColors.separator(for: appearance)
                    let gapRange: ClosedRange<CGFloat>? = selectedTabFrameInBar.map { frame in
                        frame.minX...frame.maxX
                    }
                    let segments = TabBarStyling.separatorSegments(
                        totalWidth: geometry.size.width,
                        gap: gapRange
                    )

                    HStack(spacing: 0) {
                        Rectangle()
                            .fill(separator)
                            .frame(width: segments.left, height: 1)
                        Spacer(minLength: 0)
                        Rectangle()
                            .fill(separator)
                            .frame(width: segments.right, height: 1)
                    }
                }
                .frame(height: 1)
            }
    }
}

private struct SplitActionButtonStyle: ButtonStyle {
    let appearance: BonsplitConfiguration.Appearance

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(TabBarColors.splitActionIcon(for: appearance, isPressed: configuration.isPressed))
    }
}

/// Background view that provides window-drag-from-empty-space in minimal mode
/// and hover tracking via NSTrackingArea (replacing .contentShape + .onHover).
/// As a .background(), AppKit routes clicks to tabs/buttons in front first;
/// this view only receives hits in truly empty space.
private struct TabBarDragAndHoverView: NSViewRepresentable {
    let isMinimalMode: Bool
    let onHoverChanged: (Bool) -> Void

    func makeNSView(context: Context) -> TabBarBackgroundNSView {
        let view = TabBarBackgroundNSView()
        view.isMinimalMode = isMinimalMode
        view.onHoverChanged = onHoverChanged
        return view
    }

    func updateNSView(_ nsView: TabBarBackgroundNSView, context: Context) {
        nsView.isMinimalMode = isMinimalMode
        nsView.onHoverChanged = onHoverChanged
    }

    final class TabBarBackgroundNSView: NSView {
        var isMinimalMode = false
        var onHoverChanged: ((Bool) -> Void)?
        private var hoverTrackingArea: NSTrackingArea?

        override var mouseDownCanMoveWindow: Bool { false }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let existing = hoverTrackingArea {
                removeTrackingArea(existing)
            }
            let area = NSTrackingArea(
                rect: bounds,
                options: [.mouseEnteredAndExited, .activeInActiveApp],
                owner: self
            )
            addTrackingArea(area)
            hoverTrackingArea = area
        }

        override func mouseEntered(with event: NSEvent) {
            onHoverChanged?(true)
        }

        override func mouseExited(with event: NSEvent) {
            onHoverChanged?(false)
        }

        override func mouseDown(with event: NSEvent) {
#if DEBUG
            dlog("tab.bar.bg.mouseDown isMinimal=\(isMinimalMode ? 1 : 0) clickCount=\(event.clickCount)")
#endif
            guard isMinimalMode, let window else {
                super.mouseDown(with: event)
                return
            }
            if event.clickCount >= 2 {
                let action = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?["AppleActionOnDoubleClick"] as? String
                switch action {
                case "Minimize": window.miniaturize(nil)
                default: window.zoom(nil)
                }
                return
            }
            let wasMovable = window.isMovable
            window.isMovable = true
            window.performDrag(with: event)
            window.isMovable = wasMovable
        }
    }
}

private struct TabBarDragZoneView: NSViewRepresentable {
    let onDoubleClick: () -> Bool

    func makeNSView(context: Context) -> DragNSView {
        let view = DragNSView()
        view.onDoubleClick = onDoubleClick
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
        return view
    }

    func updateNSView(_ nsView: DragNSView, context: Context) {
        nsView.onDoubleClick = onDoubleClick
    }

    final class DragNSView: NSView {
        var onDoubleClick: (() -> Bool)?

        override var mouseDownCanMoveWindow: Bool {
            return UserDefaults.standard.string(forKey: "workspacePresentationMode") == "minimal"
        }

        override func hitTest(_ point: NSPoint) -> NSView? {
            return bounds.contains(point) ? self : nil
        }

        override func mouseDown(with event: NSEvent) {
#if DEBUG
            let isMinimal = UserDefaults.standard.string(forKey: "workspacePresentationMode") == "minimal"
            dlog("tab.bar.dragZone.mouseDown isMinimal=\(isMinimal ? 1 : 0) clickCount=\(event.clickCount)")
#endif
            guard let window = self.window else {
                super.mouseDown(with: event)
                return
            }

            if event.clickCount >= 2 {
                if UserDefaults.standard.string(forKey: "workspacePresentationMode") == "minimal" {
                    let action = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?["AppleActionOnDoubleClick"] as? String
                    switch action {
                    case "Minimize": window.miniaturize(nil)
                    default: window.zoom(nil)
                    }
                    return
                } else {
                    if onDoubleClick?() == true {
                        return
                    }
                }
            }

            if UserDefaults.standard.string(forKey: "workspacePresentationMode") == "minimal" {
                let wasMovable = window.isMovable
                window.isMovable = true
                window.performDrag(with: event)
                window.isMovable = wasMovable
            } else {
                super.mouseDown(with: event)
            }
        }
    }
}

private struct TabControlShortcutStoredShortcut: Decodable {
    let key: String
    let command: Bool
    let shift: Bool
    let option: Bool
    let control: Bool

    init(
        key: String,
        command: Bool,
        shift: Bool,
        option: Bool,
        control: Bool
    ) {
        self.key = key
        self.command = command
        self.shift = shift
        self.option = option
        self.control = control
    }

    var modifierFlags: NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if command { flags.insert(.command) }
        if shift { flags.insert(.shift) }
        if option { flags.insert(.option) }
        if control { flags.insert(.control) }
        return flags
    }

    var modifierSymbol: String {
        var parts: [String] = []
        if control { parts.append("⌃") }
        if option { parts.append("⌥") }
        if shift { parts.append("⇧") }
        if command { parts.append("⌘") }
        return parts.joined()
    }
}

private enum TabControlShortcutSettings {
    static let surfaceByNumberKey = "shortcut.selectSurfaceByNumber"
    static let defaultShortcut = TabControlShortcutStoredShortcut(
        key: "1",
        command: false,
        shift: false,
        option: false,
        control: true
    )

    static func surfaceByNumberShortcut(defaults: UserDefaults = .standard) -> TabControlShortcutStoredShortcut {
        guard let data = defaults.data(forKey: surfaceByNumberKey),
              let shortcut = try? JSONDecoder().decode(TabControlShortcutStoredShortcut.self, from: data) else {
            return defaultShortcut
        }
        return shortcut
    }
}

struct TabControlShortcutModifier: Equatable {
    let modifierFlags: NSEvent.ModifierFlags
    let symbol: String
}

enum TabControlShortcutHintPolicy {
    static let intentionalHoldDelay: TimeInterval = 0.30
    static let showHintsOnCommandHoldKey = "shortcutHintShowOnCommandHold"
    static let defaultShowHintsOnCommandHold = true

    static func showHintsOnCommandHoldEnabled(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: showHintsOnCommandHoldKey) != nil else {
            return defaultShowHintsOnCommandHold
        }
        return defaults.bool(forKey: showHintsOnCommandHoldKey)
    }

    static func hintModifier(
        for modifierFlags: NSEvent.ModifierFlags,
        defaults: UserDefaults = .standard
    ) -> TabControlShortcutModifier? {
        guard showHintsOnCommandHoldEnabled(defaults: defaults) else { return nil }
        let flags = modifierFlags.intersection(.deviceIndependentFlagsMask)
            .subtracting([.numericPad, .function, .capsLock])
        let shortcut = TabControlShortcutSettings.surfaceByNumberShortcut(defaults: defaults)
        if flags != shortcut.modifierFlags {
            // Command-only hold reveals all hints (including pane hints), while
            // control (or other modifiers) remains strict to the pane shortcut.
            guard flags == [.command] else { return nil }
        }
        return TabControlShortcutModifier(
            modifierFlags: shortcut.modifierFlags,
            symbol: shortcut.modifierSymbol
        )
    }

    static func isCurrentWindow(
        hostWindowNumber: Int?,
        hostWindowIsKey: Bool,
        eventWindowNumber: Int?,
        keyWindowNumber: Int?
    ) -> Bool {
        guard let hostWindowNumber, hostWindowIsKey else { return false }
        if let eventWindowNumber {
            return eventWindowNumber == hostWindowNumber
        }
        return keyWindowNumber == hostWindowNumber
    }

    static func shouldShowHints(
        for modifierFlags: NSEvent.ModifierFlags,
        hostWindowNumber: Int?,
        hostWindowIsKey: Bool,
        eventWindowNumber: Int?,
        keyWindowNumber: Int?,
        defaults: UserDefaults = .standard
    ) -> Bool {
        hintModifier(for: modifierFlags, defaults: defaults) != nil &&
            isCurrentWindow(
                hostWindowNumber: hostWindowNumber,
                hostWindowIsKey: hostWindowIsKey,
                eventWindowNumber: eventWindowNumber,
                keyWindowNumber: keyWindowNumber
            )
    }
}

private struct TabBarHostWindowReader: NSViewRepresentable {
    let onResolve: (NSWindow?) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { [weak view] in
            onResolve(view?.window)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { [weak nsView] in
            onResolve(nsView?.window)
        }
    }
}

@MainActor
private final class TabControlShortcutKeyMonitor: ObservableObject {
    @Published private(set) var isShortcutHintVisible = false
    @Published private(set) var shortcutModifierSymbol = "⌃"

    private weak var hostWindow: NSWindow?
    private var hostWindowDidBecomeKeyObserver: NSObjectProtocol?
    private var hostWindowDidResignKeyObserver: NSObjectProtocol?
    private var flagsMonitor: Any?
    private var keyDownMonitor: Any?
    private var resignObserver: NSObjectProtocol?
    private var pendingShowWorkItem: DispatchWorkItem?
    private var pendingModifier: TabControlShortcutModifier?

    func setHostWindow(_ window: NSWindow?) {
        guard hostWindow !== window else { return }
        removeHostWindowObservers()
        hostWindow = window
        guard let window else {
            cancelPendingHintShow(resetVisible: true)
            return
        }

        hostWindowDidBecomeKeyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.update(from: NSEvent.modifierFlags, eventWindow: nil)
            }
        }

        hostWindowDidResignKeyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.cancelPendingHintShow(resetVisible: true)
            }
        }

        update(from: NSEvent.modifierFlags, eventWindow: nil)
    }

    func start() {
        guard flagsMonitor == nil else {
            update(from: NSEvent.modifierFlags, eventWindow: nil)
            return
        }

        flagsMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.update(from: event.modifierFlags, eventWindow: event.window)
            return event
        }

        keyDownMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard self?.isCurrentWindow(eventWindow: event.window) == true else { return event }
            self?.cancelPendingHintShow(resetVisible: true)
            return event
        }

        resignObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.cancelPendingHintShow(resetVisible: true)
            }
        }

        update(from: NSEvent.modifierFlags, eventWindow: nil)
    }

    func stop() {
        if let flagsMonitor {
            NSEvent.removeMonitor(flagsMonitor)
            self.flagsMonitor = nil
        }
        if let keyDownMonitor {
            NSEvent.removeMonitor(keyDownMonitor)
            self.keyDownMonitor = nil
        }
        if let resignObserver {
            NotificationCenter.default.removeObserver(resignObserver)
            self.resignObserver = nil
        }
        removeHostWindowObservers()
        cancelPendingHintShow(resetVisible: true)
    }

    private func isCurrentWindow(eventWindow: NSWindow?) -> Bool {
        TabControlShortcutHintPolicy.isCurrentWindow(
            hostWindowNumber: hostWindow?.windowNumber,
            hostWindowIsKey: hostWindow?.isKeyWindow ?? false,
            eventWindowNumber: eventWindow?.windowNumber,
            keyWindowNumber: NSApp.keyWindow?.windowNumber
        )
    }

    private func update(from modifierFlags: NSEvent.ModifierFlags, eventWindow: NSWindow?) {
        guard TabControlShortcutHintPolicy.shouldShowHints(
            for: modifierFlags,
            hostWindowNumber: hostWindow?.windowNumber,
            hostWindowIsKey: hostWindow?.isKeyWindow ?? false,
            eventWindowNumber: eventWindow?.windowNumber,
            keyWindowNumber: NSApp.keyWindow?.windowNumber
        ) else {
            cancelPendingHintShow(resetVisible: true)
            return
        }

        guard let modifier = TabControlShortcutHintPolicy.hintModifier(for: modifierFlags) else {
            cancelPendingHintShow(resetVisible: true)
            return
        }

        if isShortcutHintVisible {
            shortcutModifierSymbol = modifier.symbol
            return
        }

        queueHintShow(for: modifier)
    }

    private func queueHintShow(for modifier: TabControlShortcutModifier) {
        if pendingModifier == modifier, pendingShowWorkItem != nil {
            return
        }

        pendingShowWorkItem?.cancel()

        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingShowWorkItem = nil
            self.pendingModifier = nil
            guard TabControlShortcutHintPolicy.shouldShowHints(
                for: NSEvent.modifierFlags,
                hostWindowNumber: self.hostWindow?.windowNumber,
                hostWindowIsKey: self.hostWindow?.isKeyWindow ?? false,
                eventWindowNumber: nil,
                keyWindowNumber: NSApp.keyWindow?.windowNumber
            ) else { return }
            guard let currentModifier = TabControlShortcutHintPolicy.hintModifier(for: NSEvent.modifierFlags) else { return }
            self.shortcutModifierSymbol = currentModifier.symbol
            withAnimation(.easeInOut(duration: 0.14)) {
                self.isShortcutHintVisible = true
            }
        }

        pendingModifier = modifier
        pendingShowWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + TabControlShortcutHintPolicy.intentionalHoldDelay, execute: workItem)
    }

    private func cancelPendingHintShow(resetVisible: Bool) {
        pendingShowWorkItem?.cancel()
        pendingShowWorkItem = nil
        pendingModifier = nil
        if resetVisible {
            withAnimation(.easeInOut(duration: 0.14)) {
                isShortcutHintVisible = false
            }
        }
    }

    private func removeHostWindowObservers() {
        if let hostWindowDidBecomeKeyObserver {
            NotificationCenter.default.removeObserver(hostWindowDidBecomeKeyObserver)
            self.hostWindowDidBecomeKeyObserver = nil
        }
        if let hostWindowDidResignKeyObserver {
            NotificationCenter.default.removeObserver(hostWindowDidResignKeyObserver)
            self.hostWindowDidResignKeyObserver = nil
        }
    }
}


/// Drop lifecycle state to prevent dropUpdated from re-setting state after performDrop
enum TabDropLifecycle {
    case idle
    case hovering
}

// MARK: - Tab Drop Delegate

struct TabDropDelegate: DropDelegate {
    let targetIndex: Int
    let pane: PaneState
    let bonsplitController: BonsplitController
    let controller: SplitViewController
    @Binding var dropTargetIndex: Int?
    @Binding var dropLifecycle: TabDropLifecycle

    func performDrop(info: DropInfo) -> Bool {
        #if DEBUG
        NSLog("[Bonsplit Drag] performDrop called, targetIndex: \(targetIndex)")
        #endif
#if DEBUG
        dlog("tab.drop pane=\(pane.id.id.uuidString.prefix(5)) targetIndex=\(targetIndex)")
#endif

        // Ensure all drag/drop side-effects run on the main actor. SwiftUI can call these
        // callbacks off-main, and SplitViewController is @MainActor.
        if !Thread.isMainThread {
            return DispatchQueue.main.sync {
                performDrop(info: info)
            }
        }

        // Read from non-observable drag state — @Observable writes from createItemProvider
        // may not have propagated yet when performDrop runs.
        guard let draggedTab = controller.activeDragTab ?? controller.draggingTab,
              let sourcePaneId = controller.activeDragSourcePaneId ?? controller.dragSourcePaneId else {
            guard let transfer = decodeTransfer(from: info),
                  transfer.isFromCurrentProcess else {
                return false
            }
            let request = BonsplitController.ExternalTabDropRequest(
                tabId: TabID(id: transfer.tab.id),
                sourcePaneId: PaneID(id: transfer.sourcePaneId),
                destination: .insert(targetPane: pane.id, targetIndex: targetIndex)
            )
            let handled = bonsplitController.onExternalTabDrop?(request) ?? false
            if handled {
                dropLifecycle = .idle
                dropTargetIndex = nil
            }
            return handled
        }

        // Execute synchronously when possible so the dragged tab disappears immediately.
        let applyMove = {
            // Ensure the move itself doesn't animate.
            withTransaction(Transaction(animation: nil)) {
                if sourcePaneId == pane.id {
                    guard let sourceIndex = pane.tabs.firstIndex(where: { $0.id == draggedTab.id }) else { return }
                    // Same-pane no-op: don't mutate the model (and don't show an indicator).
                    if targetIndex == sourceIndex || targetIndex == sourceIndex + 1 {
                        return
                    }
                    pane.moveTab(from: sourceIndex, to: targetIndex)
                } else {
                    _ = bonsplitController.moveTab(
                        TabID(id: draggedTab.id),
                        toPane: pane.id,
                        atIndex: targetIndex
                    )
                }
            }
        }

        applyMove()

        // Clear visual state immediately to prevent lingering indicators.
        // Must happen synchronously before returning, not in async callback.
        // Setting dropLifecycle to idle prevents dropUpdated from re-setting dropTargetIndex.
        dropLifecycle = .idle
        dropTargetIndex = nil
        controller.draggingTab = nil
        controller.dragSourcePaneId = nil
        controller.activeDragTab = nil
        controller.activeDragSourcePaneId = nil

        return true
    }

    func dropEntered(info: DropInfo) {
        #if DEBUG
        NSLog("[Bonsplit Drag] dropEntered at index: \(targetIndex)")
        dlog(
            "tab.dropEntered pane=\(pane.id.id.uuidString.prefix(5)) targetIndex=\(targetIndex) " +
            "hasDrag=\(controller.draggingTab != nil ? 1 : 0) " +
            "hasActive=\(controller.activeDragTab != nil ? 1 : 0)"
        )
        #endif
        dropLifecycle = .hovering
        if shouldSuppressIndicatorForNoopSamePaneDrop() {
            dropTargetIndex = nil
        } else {
            dropTargetIndex = targetIndex
        }
    }

    func dropExited(info: DropInfo) {
        #if DEBUG
        NSLog("[Bonsplit Drag] dropExited from index: \(targetIndex)")
        dlog("tab.dropExited pane=\(pane.id.id.uuidString.prefix(5)) targetIndex=\(targetIndex)")
        #endif
        dropLifecycle = .idle
        if dropTargetIndex == targetIndex {
            dropTargetIndex = nil
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        // Guard against dropUpdated firing after performDrop/dropExited
        // This is the key fix for the lingering indicator bug
        guard dropLifecycle == .hovering else {
#if DEBUG
            dlog("tab.dropUpdated.skip pane=\(pane.id.id.uuidString.prefix(5)) targetIndex=\(targetIndex) reason=lifecycle_idle")
#endif
            return DropProposal(operation: .move)
        }
        // Only update if this is the active target, and suppress same-pane no-op indicators.
        if shouldSuppressIndicatorForNoopSamePaneDrop() {
            if dropTargetIndex == targetIndex {
                dropTargetIndex = nil
            }
        } else if dropTargetIndex != targetIndex {
            dropTargetIndex = targetIndex
        }
#if DEBUG
        dlog(
            "tab.dropUpdated pane=\(pane.id.id.uuidString.prefix(5)) targetIndex=\(targetIndex) " +
            "dropTarget=\(dropTargetIndex.map(String.init) ?? "nil")"
        )
#endif
        return DropProposal(operation: .move)
    }

    func validateDrop(info: DropInfo) -> Bool {
        // Reject drops on inactive workspaces whose views are kept alive in a ZStack.
        guard controller.isInteractive else {
#if DEBUG
            dlog("tab.validateDrop pane=\(pane.id.id.uuidString.prefix(5)) allowed=0 reason=inactive")
#endif
            return false
        }
        // The custom UTType alone is sufficient — only Bonsplit tab drags produce it.
        // Do NOT gate on draggingTab != nil: @Observable changes from createItemProvider
        // may not have propagated to the drop delegate yet, causing false rejections.
        let hasType = info.hasItemsConforming(to: [.tabTransfer])
        guard hasType else { return false }

        // Local drags use in-memory state and are always same-process.
        if controller.activeDragTab != nil || controller.draggingTab != nil {
            return true
        }

        // External drags (another Bonsplit controller) must include a payload from this process.
        guard let transfer = decodeTransfer(from: info),
              transfer.isFromCurrentProcess else {
            return false
        }
#if DEBUG
        let hasDrag = controller.draggingTab != nil
        let hasActive = controller.activeDragTab != nil
        dlog(
            "tab.validateDrop pane=\(pane.id.id.uuidString.prefix(5)) " +
            "allowed=\(hasType ? 1 : 0) hasDrag=\(hasDrag ? 1 : 0) hasActive=\(hasActive ? 1 : 0)"
        )
#endif
        return true
    }

    private func shouldSuppressIndicatorForNoopSamePaneDrop() -> Bool {
        guard let draggedTab = controller.draggingTab,
              controller.dragSourcePaneId == pane.id,
              let sourceIndex = pane.tabs.firstIndex(where: { $0.id == draggedTab.id }) else {
            return false
        }
        // Insertion indices are expressed in "original array" coordinates; after removal,
        // inserting at `sourceIndex` or `sourceIndex + 1` results in no change.
        return targetIndex == sourceIndex || targetIndex == sourceIndex + 1
    }

    private func decodeTransfer(from string: String) -> TabTransferData? {
        guard let data = string.data(using: .utf8),
              let transfer = try? JSONDecoder().decode(TabTransferData.self, from: data) else {
            return nil
        }
        return transfer
    }

    private func decodeTransfer(from info: DropInfo) -> TabTransferData? {
        let pasteboard = NSPasteboard(name: .drag)
        let type = NSPasteboard.PasteboardType(UTType.tabTransfer.identifier)
        if let data = pasteboard.data(forType: type),
           let transfer = try? JSONDecoder().decode(TabTransferData.self, from: data) {
            return transfer
        }
        if let raw = pasteboard.string(forType: type) {
            return decodeTransfer(from: raw)
        }
        return nil
    }
}
