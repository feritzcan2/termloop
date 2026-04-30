import XCTest
@testable import Bonsplit
import AppKit
import SwiftUI

final class BonsplitTests: XCTestCase {
    @MainActor
    private final class LayoutProbeView: NSView {
        private(set) var sizeChangeCount = 0
        private(set) var originChangeCount = 0

        override func setFrameSize(_ newSize: NSSize) {
            if frame.size != newSize {
                sizeChangeCount += 1
            }
            super.setFrameSize(newSize)
        }

        override func setFrameOrigin(_ newOrigin: NSPoint) {
            if frame.origin != newOrigin {
                originChangeCount += 1
            }
            super.setFrameOrigin(newOrigin)
        }
    }

    @MainActor
    private struct LayoutProbeRepresentable: NSViewRepresentable {
        let probeView: LayoutProbeView

        func makeNSView(context: Context) -> LayoutProbeView {
            probeView
        }

        func updateNSView(_ nsView: LayoutProbeView, context: Context) {}
    }

    @MainActor
    private final class DropZoneModel: ObservableObject {
        @Published var zone: DropZone?
    }

    @MainActor
    private struct PaneDropInteractionHarness: View {
        @ObservedObject var model: DropZoneModel
        let probeView: LayoutProbeView

        var body: some View {
            PaneDropInteractionContainer(activeDropZone: model.zone) {
                LayoutProbeRepresentable(probeView: probeView)
            } dropLayer: { _ in
                Color.clear
            }
        }
    }

    private final class TabContextActionDelegateSpy: BonsplitDelegate {
        var action: TabContextAction?
        var tabId: TabID?
        var paneId: PaneID?

        func splitTabBar(_ controller: BonsplitController, didRequestTabContextAction action: TabContextAction, for tab: Bonsplit.Tab, inPane pane: PaneID) {
            self.action = action
            self.tabId = tab.id
            self.paneId = pane
        }
    }

    private final class NewTabRequestDelegateSpy: BonsplitDelegate {
        var requestedKind: String?
        var requestedPaneId: PaneID?

        func splitTabBar(_ controller: BonsplitController, didRequestNewTab kind: String, inPane pane: PaneID) {
            requestedKind = kind
            requestedPaneId = pane
        }
    }

    @MainActor
    func testControllerCreation() {
        let controller = BonsplitController()
        XCTAssertNotNil(controller.focusedPaneId)
    }

    @MainActor
    func testTabCreation() {
        let controller = BonsplitController()
        let tabId = controller.createTab(title: "Test Tab", icon: "doc")
        XCTAssertNotNil(tabId)
    }

    @MainActor
    func testTabRetrieval() {
        let controller = BonsplitController()
        let tabId = controller.createTab(title: "Test Tab", icon: "doc")!
        let tab = controller.tab(tabId)
        XCTAssertEqual(tab?.title, "Test Tab")
        XCTAssertEqual(tab?.icon, "doc")
    }

    @MainActor
    func testTabUpdate() {
        let controller = BonsplitController()
        let tabId = controller.createTab(title: "Original", icon: "doc")!

        controller.updateTab(tabId, title: "Updated", isDirty: true)

        let tab = controller.tab(tabId)
        XCTAssertEqual(tab?.title, "Updated")
        XCTAssertEqual(tab?.isDirty, true)
    }

    @MainActor
    func testTabClose() {
        let controller = BonsplitController()
        let tabId = controller.createTab(title: "Test Tab", icon: "doc")!

        let closed = controller.closeTab(tabId)

        XCTAssertTrue(closed)
        XCTAssertNil(controller.tab(tabId))
    }

    @MainActor
    func testCloseSelectedTabKeepsIndexStableWhenPossible() {
        do {
            let config = BonsplitConfiguration(newTabPosition: .end)
            let controller = BonsplitController(configuration: config)

            let tab0 = controller.createTab(title: "0")!
            let tab1 = controller.createTab(title: "1")!
            let tab2 = controller.createTab(title: "2")!

            let pane = controller.focusedPaneId!

            controller.selectTab(tab1)
            XCTAssertEqual(controller.selectedTab(inPane: pane)?.id, tab1)

            _ = controller.closeTab(tab1)

            // Order is [0,1,2] and 1 was selected; after close we should select 2 (same index).
            XCTAssertEqual(controller.selectedTab(inPane: pane)?.id, tab2)
            XCTAssertNotNil(controller.tab(tab0))
        }

        do {
            let config = BonsplitConfiguration(newTabPosition: .end)
            let controller = BonsplitController(configuration: config)

            let tab0 = controller.createTab(title: "0")!
            let tab1 = controller.createTab(title: "1")!
            let tab2 = controller.createTab(title: "2")!

            let pane = controller.focusedPaneId!

            controller.selectTab(tab2)
            XCTAssertEqual(controller.selectedTab(inPane: pane)?.id, tab2)

            _ = controller.closeTab(tab2)

            // Closing last should select previous.
            XCTAssertEqual(controller.selectedTab(inPane: pane)?.id, tab1)
            XCTAssertNotNil(controller.tab(tab0))
        }
    }

    @MainActor
    func testConfiguration() {
        let config = BonsplitConfiguration(
            allowSplits: false,
            allowCloseTabs: true
        )
        let controller = BonsplitController(configuration: config)

        XCTAssertFalse(controller.configuration.allowSplits)
        XCTAssertTrue(controller.configuration.allowCloseTabs)
    }

    func testDefaultSplitButtonTooltips() {
        let defaults = BonsplitConfiguration.SplitButtonTooltips.default
        XCTAssertEqual(defaults.newTerminal, "New Terminal")
        XCTAssertEqual(defaults.newBrowser, "New Browser")
        XCTAssertEqual(defaults.splitRight, "Split Right")
        XCTAssertEqual(defaults.splitDown, "Split Down")
    }

    @MainActor
    func testConfigurationAcceptsCustomSplitButtonTooltips() {
        let customTooltips = BonsplitConfiguration.SplitButtonTooltips(
            newTerminal: "Terminal (⌘T)",
            newBrowser: "Browser (⌘⇧L)",
            splitRight: "Split Right (⌘D)",
            splitDown: "Split Down (⌘⇧D)"
        )
        let config = BonsplitConfiguration(
            appearance: .init(
                splitButtonTooltips: customTooltips
            )
        )
        let controller = BonsplitController(configuration: config)

        XCTAssertEqual(controller.configuration.appearance.splitButtonTooltips, customTooltips)
    }

    func testChromeBackgroundHexOverrideParsesForPaneBackground() {
        let appearance = BonsplitConfiguration.Appearance(
            chromeColors: .init(backgroundHex: "#FDF6E3")
        )
        let color = TabBarColors.nsColorPaneBackground(for: appearance).usingColorSpace(.sRGB)!

        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)

        XCTAssertEqual(Int(round(red * 255)), 253)
        XCTAssertEqual(Int(round(green * 255)), 246)
        XCTAssertEqual(Int(round(blue * 255)), 227)
        XCTAssertEqual(Int(round(alpha * 255)), 255)
    }

    func testChromeBorderHexOverrideParsesForSeparatorColor() {
        let appearance = BonsplitConfiguration.Appearance(
            chromeColors: .init(backgroundHex: "#272822", borderHex: "#112233")
        )
        let color = TabBarColors.nsColorSeparator(for: appearance).usingColorSpace(.sRGB)!

        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)

        XCTAssertEqual(Int(round(red * 255)), 17)
        XCTAssertEqual(Int(round(green * 255)), 34)
        XCTAssertEqual(Int(round(blue * 255)), 51)
        XCTAssertEqual(Int(round(alpha * 255)), 255)
    }

    func testInvalidChromeBackgroundHexFallsBackToPaneDefaultColor() {
        let appearance = BonsplitConfiguration.Appearance(
            chromeColors: .init(backgroundHex: "#ZZZZZZ")
        )
        let resolved = TabBarColors.nsColorPaneBackground(for: appearance).usingColorSpace(.sRGB)!
        let fallback = NSColor.textBackgroundColor.usingColorSpace(.sRGB)!

        var rr: CGFloat = 0
        var rg: CGFloat = 0
        var rb: CGFloat = 0
        var ra: CGFloat = 0
        resolved.getRed(&rr, green: &rg, blue: &rb, alpha: &ra)

        var fr: CGFloat = 0
        var fg: CGFloat = 0
        var fb: CGFloat = 0
        var fa: CGFloat = 0
        fallback.getRed(&fr, green: &fg, blue: &fb, alpha: &fa)

        XCTAssertEqual(rr, fr, accuracy: 0.0001)
        XCTAssertEqual(rg, fg, accuracy: 0.0001)
        XCTAssertEqual(rb, fb, accuracy: 0.0001)
        XCTAssertEqual(ra, fa, accuracy: 0.0001)
    }

    func testPartiallyInvalidChromeBackgroundHexFallsBackToPaneDefaultColor() {
        let appearance = BonsplitConfiguration.Appearance(
            chromeColors: .init(backgroundHex: "#FF000G")
        )
        let resolved = TabBarColors.nsColorPaneBackground(for: appearance).usingColorSpace(.sRGB)!
        let fallback = NSColor.textBackgroundColor.usingColorSpace(.sRGB)!

        var rr: CGFloat = 0
        var rg: CGFloat = 0
        var rb: CGFloat = 0
        var ra: CGFloat = 0
        resolved.getRed(&rr, green: &rg, blue: &rb, alpha: &ra)

        var fr: CGFloat = 0
        var fg: CGFloat = 0
        var fb: CGFloat = 0
        var fa: CGFloat = 0
        fallback.getRed(&fr, green: &fg, blue: &fb, alpha: &fa)

        XCTAssertEqual(rr, fr, accuracy: 0.0001)
        XCTAssertEqual(rg, fg, accuracy: 0.0001)
        XCTAssertEqual(rb, fb, accuracy: 0.0001)
        XCTAssertEqual(ra, fa, accuracy: 0.0001)
    }

    func testInactiveTextUsesLightForegroundOnDarkCustomChromeBackground() {
        let appearance = BonsplitConfiguration.Appearance(
            chromeColors: .init(backgroundHex: "#272822")
        )
        let color = TabBarColors.nsColorInactiveText(for: appearance).usingColorSpace(.sRGB)!

        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)

        XCTAssertGreaterThan(red, 0.5)
        XCTAssertGreaterThan(green, 0.5)
        XCTAssertGreaterThan(blue, 0.5)
        XCTAssertGreaterThan(alpha, 0.6)
    }

    func testSplitActionPressedStateUsesHigherContrast() {
        let appearance = BonsplitConfiguration.Appearance(
            chromeColors: .init(backgroundHex: "#272822")
        )

        let idleIcon = TabBarColors.nsColorSplitActionIcon(for: appearance, isPressed: false).usingColorSpace(.sRGB)!
        let pressedIcon = TabBarColors.nsColorSplitActionIcon(for: appearance, isPressed: true).usingColorSpace(.sRGB)!

        var idleAlpha: CGFloat = 0
        idleIcon.getRed(nil, green: nil, blue: nil, alpha: &idleAlpha)
        var pressedAlpha: CGFloat = 0
        pressedIcon.getRed(nil, green: nil, blue: nil, alpha: &pressedAlpha)

        XCTAssertGreaterThan(pressedAlpha, idleAlpha)
    }

    @MainActor
    func testMoveTabNoopAfterItself() {
        let t0 = TabItem(title: "0")
        let t1 = TabItem(title: "1")
        let pane = PaneState(tabs: [t0, t1], selectedTabId: t1.id)

        // Dragging the last tab to the right corresponds to moving it to `tabs.count`,
        // which should be treated as a no-op.
        pane.moveTab(from: 1, to: 2)
        XCTAssertEqual(pane.tabs.map(\.id), [t0.id, t1.id])
        XCTAssertEqual(pane.selectedTabId, t1.id)

        // Still allow real moves.
        pane.moveTab(from: 0, to: 2)
        XCTAssertEqual(pane.tabs.map(\.id), [t1.id, t0.id])
        XCTAssertEqual(pane.selectedTabId, t1.id)
    }

    @MainActor
    func testPinnedTabInsertionsStayAheadOfUnpinnedTabs() {
        let unpinnedA = TabItem(title: "A", isPinned: false)
        let unpinnedB = TabItem(title: "B", isPinned: false)
        let pinned = TabItem(title: "Pinned", isPinned: true)
        let pane = PaneState(tabs: [unpinnedA, unpinnedB], selectedTabId: unpinnedA.id)

        pane.insertTab(pinned, at: 2)

        XCTAssertEqual(pane.tabs.map(\.isPinned), [true, false, false])
        XCTAssertEqual(pane.tabs.first?.id, pinned.id)
    }

    @MainActor
    func testMovingUnpinnedTabCannotCrossPinnedBoundary() {
        let pinnedA = TabItem(title: "Pinned A", isPinned: true)
        let pinnedB = TabItem(title: "Pinned B", isPinned: true)
        let unpinnedA = TabItem(title: "A", isPinned: false)
        let unpinnedB = TabItem(title: "B", isPinned: false)
        let pane = PaneState(
            tabs: [pinnedA, pinnedB, unpinnedA, unpinnedB],
            selectedTabId: unpinnedB.id
        )

        // Attempt to move an unpinned tab ahead of pinned tabs; move should clamp to
        // the first unpinned position.
        pane.moveTab(from: 3, to: 0)

        XCTAssertEqual(pane.tabs.map(\.id), [pinnedA.id, pinnedB.id, unpinnedB.id, unpinnedA.id])
        XCTAssertEqual(pane.tabs.prefix(2).allSatisfy(\.isPinned), true)
        XCTAssertEqual(pane.tabs.suffix(2).allSatisfy { !$0.isPinned }, true)
    }

    @MainActor
    func testCreateTabStoresKindAndPinnedState() {
        let controller = BonsplitController()
        let tabId = controller.createTab(
            title: "Browser",
            icon: "globe",
            kind: "browser",
            isPinned: true
        )!

        let tab = controller.tab(tabId)
        XCTAssertEqual(tab?.kind, "browser")
        XCTAssertEqual(tab?.isPinned, true)
    }

    @MainActor
    func testCreateAndUpdateTabCustomTitleFlag() {
        let controller = BonsplitController()
        let tabId = controller.createTab(
            title: "Infra",
            hasCustomTitle: true
        )!

        XCTAssertEqual(controller.tab(tabId)?.hasCustomTitle, true)

        controller.updateTab(tabId, hasCustomTitle: false)
        XCTAssertEqual(controller.tab(tabId)?.hasCustomTitle, false)
    }

    @MainActor
    func testSplitPaneWithOptionalTabPreservesCustomTitleFlag() {
        let controller = BonsplitController()
        _ = controller.createTab(title: "Base")
        let sourcePaneId = controller.focusedPaneId!
        let customTab = Bonsplit.Tab(title: "Custom", hasCustomTitle: true)

        guard let newPaneId = controller.splitPane(sourcePaneId, orientation: .horizontal, withTab: customTab) else {
            return XCTFail("Expected splitPane to return new pane")
        }
        let inserted = controller.tabs(inPane: newPaneId).first(where: { $0.id == customTab.id })
        XCTAssertEqual(inserted?.hasCustomTitle, true)
    }

    @MainActor
    func testSplitPaneWithInsertSidePreservesCustomTitleFlag() {
        let controller = BonsplitController()
        _ = controller.createTab(title: "Base")
        let sourcePaneId = controller.focusedPaneId!
        let customTab = Bonsplit.Tab(title: "Custom", hasCustomTitle: true)

        guard let newPaneId = controller.splitPane(
            sourcePaneId,
            orientation: .vertical,
            withTab: customTab,
            insertFirst: true
        ) else {
            return XCTFail("Expected splitPane(insertFirst:) to return new pane")
        }
        let inserted = controller.tabs(inPane: newPaneId).first(where: { $0.id == customTab.id })
        XCTAssertEqual(inserted?.hasCustomTitle, true)
    }

    @MainActor
    func testTogglePaneZoomTracksState() {
        let controller = BonsplitController()
        guard let originalPane = controller.focusedPaneId else {
            return XCTFail("Expected focused pane")
        }

        // Single-pane layouts cannot be zoomed.
        XCTAssertFalse(controller.togglePaneZoom(inPane: originalPane))
        XCTAssertNil(controller.zoomedPaneId)

        guard controller.splitPane(originalPane, orientation: .horizontal) != nil else {
            return XCTFail("Expected splitPane to create a new pane")
        }

        XCTAssertTrue(controller.togglePaneZoom(inPane: originalPane))
        XCTAssertEqual(controller.zoomedPaneId, originalPane)
        XCTAssertTrue(controller.isSplitZoomed)

        XCTAssertTrue(controller.togglePaneZoom(inPane: originalPane))
        XCTAssertNil(controller.zoomedPaneId)
        XCTAssertFalse(controller.isSplitZoomed)
    }

    @MainActor
    func testSplitClearsExistingPaneZoom() {
        let controller = BonsplitController()
        guard let originalPane = controller.focusedPaneId else {
            return XCTFail("Expected focused pane")
        }

        guard let secondPane = controller.splitPane(originalPane, orientation: .horizontal) else {
            return XCTFail("Expected splitPane to create a new pane")
        }

        XCTAssertTrue(controller.togglePaneZoom(inPane: secondPane))
        XCTAssertEqual(controller.zoomedPaneId, secondPane)

        _ = controller.splitPane(secondPane, orientation: .vertical)
        XCTAssertNil(controller.zoomedPaneId, "Splitting should reset zoom state")
    }

    @MainActor
    func testRequestTabContextActionForwardsToDelegate() {
        let controller = BonsplitController()
        let pane = controller.focusedPaneId!
        let tabId = controller.createTab(title: "Test", kind: "browser")!
        let spy = TabContextActionDelegateSpy()
        controller.delegate = spy

        controller.requestTabContextAction(.reload, for: tabId, inPane: pane)

        XCTAssertEqual(spy.action, .reload)
        XCTAssertEqual(spy.tabId, tabId)
        XCTAssertEqual(spy.paneId, pane)
    }

    @MainActor
    func testRequestTabContextActionForwardsMarkAsReadToDelegate() {
        let controller = BonsplitController()
        let pane = controller.focusedPaneId!
        let tabId = controller.createTab(title: "Test", kind: "terminal")!
        let spy = TabContextActionDelegateSpy()
        controller.delegate = spy

        controller.requestTabContextAction(.markAsRead, for: tabId, inPane: pane)

        XCTAssertEqual(spy.action, .markAsRead)
        XCTAssertEqual(spy.tabId, tabId)
        XCTAssertEqual(spy.paneId, pane)
    }

    @MainActor
    func testDoubleClickingEmptyTrailingTabBarSpaceRequestsNewTerminalTab() {
        let appearance = BonsplitConfiguration.Appearance(showSplitButtons: false)
        let configuration = BonsplitConfiguration(appearance: appearance)
        let controller = BonsplitController(configuration: configuration)
        let pane = controller.internalController.rootNode.allPanes.first!
        let spy = NewTabRequestDelegateSpy()
        controller.delegate = spy

        let hostingView = NSHostingView(
            rootView: TabBarView(pane: pane, isFocused: true, showSplitButtons: false)
                .environment(controller)
                .environment(controller.internalController)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 60),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        defer { window.orderOut(nil) }
        guard let contentView = window.contentView else {
            XCTFail("Expected content view")
            return
        }

        hostingView.frame = contentView.bounds
        hostingView.autoresizingMask = [.width, .height]
        contentView.addSubview(hostingView)

        window.makeKeyAndOrderFront(nil)
        contentView.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        contentView.layoutSubtreeIfNeeded()

        let clickPoint = NSPoint(x: hostingView.bounds.maxX - 12, y: hostingView.bounds.midY)
        guard let event = try? makeLeftMouseDownEvent(in: hostingView, at: clickPoint, clickCount: 2) else {
            XCTFail("Expected mouse event")
            return
        }
        NSApp.sendEvent(event)

        XCTAssertEqual(spy.requestedKind, "terminal")
        XCTAssertEqual(spy.requestedPaneId, pane.id)
    }

    func testIconSaturationKeepsRasterFaviconInColorWhenInactive() {
        XCTAssertEqual(
            TabItemStyling.iconSaturation(hasRasterIcon: true, tabSaturation: 0.0),
            1.0
        )
    }

    func testIconSaturationStillDesaturatesSymbolIconsWhenInactive() {
        XCTAssertEqual(
            TabItemStyling.iconSaturation(hasRasterIcon: false, tabSaturation: 0.0),
            0.0
        )
    }

    func testResolvedFaviconImageUsesIncomingDataWhenDecodable() {
        let existing = NSImage(size: NSSize(width: 12, height: 12))
        let incoming = NSImage(size: NSSize(width: 16, height: 16))
        incoming.lockFocus()
        NSColor.systemBlue.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 16, height: 16)).fill()
        incoming.unlockFocus()
        let data = incoming.tiffRepresentation

        let resolved = TabItemStyling.resolvedFaviconImage(existing: existing, incomingData: data)
        XCTAssertNotNil(resolved)
        XCTAssertFalse(resolved === existing)
    }

    func testResolvedFaviconImageKeepsExistingImageWhenIncomingDataIsInvalid() {
        let existing = NSImage(size: NSSize(width: 16, height: 16))
        let invalidData = Data([0x00, 0x11, 0x22, 0x33])

        let resolved = TabItemStyling.resolvedFaviconImage(existing: existing, incomingData: invalidData)
        XCTAssertTrue(resolved === existing)
    }

    func testResolvedFaviconImageClearsWhenIncomingDataIsNil() {
        let existing = NSImage(size: NSSize(width: 16, height: 16))
        let resolved = TabItemStyling.resolvedFaviconImage(existing: existing, incomingData: nil)
        XCTAssertNil(resolved)
    }

    func testTabControlShortcutHintPolicyMatchesConfiguredModifiers() {
        withShortcutHintDefaultsSuite { defaults in
            defaults.set(true, forKey: TabControlShortcutHintPolicy.showHintsOnCommandHoldKey)

            XCTAssertNotNil(TabControlShortcutHintPolicy.hintModifier(for: [.control], defaults: defaults))
            XCTAssertEqual(
                TabControlShortcutHintPolicy.hintModifier(for: [.command], defaults: defaults)?.symbol,
                "⌃"
            )
            XCTAssertNil(TabControlShortcutHintPolicy.hintModifier(for: [], defaults: defaults))
            XCTAssertNil(TabControlShortcutHintPolicy.hintModifier(for: [.control, .shift], defaults: defaults))
            XCTAssertNil(TabControlShortcutHintPolicy.hintModifier(for: [.command, .option], defaults: defaults))

            defaults.set(
                shortcutData(
                    key: "1",
                    command: true,
                    shift: false,
                    option: true,
                    control: false
                ),
                forKey: "shortcut.selectSurfaceByNumber"
            )

            let custom = TabControlShortcutHintPolicy.hintModifier(for: [.command, .option], defaults: defaults)
            XCTAssertEqual(custom?.symbol, "⌥⌘")
            XCTAssertEqual(
                TabControlShortcutHintPolicy.hintModifier(for: [.command], defaults: defaults)?.symbol,
                "⌥⌘"
            )
            XCTAssertNil(TabControlShortcutHintPolicy.hintModifier(for: [.control], defaults: defaults))
        }
    }

    func testTabControlShortcutHintPolicyCanDisableHoldHints() {
        withShortcutHintDefaultsSuite { defaults in
            defaults.set(false, forKey: TabControlShortcutHintPolicy.showHintsOnCommandHoldKey)

            XCTAssertNil(TabControlShortcutHintPolicy.hintModifier(for: [.control], defaults: defaults))
            XCTAssertNil(TabControlShortcutHintPolicy.hintModifier(for: [.command], defaults: defaults))
        }
    }

    func testTabControlShortcutHintPolicyDefaultsToShowingHoldHints() {
        withShortcutHintDefaultsSuite { defaults in
            defaults.removeObject(forKey: TabControlShortcutHintPolicy.showHintsOnCommandHoldKey)

            XCTAssertEqual(TabControlShortcutHintPolicy.hintModifier(for: [.control], defaults: defaults)?.symbol, "⌃")
            XCTAssertEqual(TabControlShortcutHintPolicy.hintModifier(for: [.command], defaults: defaults)?.symbol, "⌃")
        }
    }

    func testTabControlShortcutHintsAreScopedToCurrentKeyWindow() {
        withShortcutHintDefaultsSuite { defaults in
            defaults.set(true, forKey: TabControlShortcutHintPolicy.showHintsOnCommandHoldKey)

            XCTAssertTrue(
                TabControlShortcutHintPolicy.shouldShowHints(
                    for: [.control],
                    hostWindowNumber: 42,
                    hostWindowIsKey: true,
                    eventWindowNumber: 42,
                    keyWindowNumber: 42,
                    defaults: defaults
                )
            )

            XCTAssertFalse(
                TabControlShortcutHintPolicy.shouldShowHints(
                    for: [.control],
                    hostWindowNumber: 42,
                    hostWindowIsKey: true,
                    eventWindowNumber: 7,
                    keyWindowNumber: 42,
                    defaults: defaults
                )
            )

            XCTAssertFalse(
                TabControlShortcutHintPolicy.shouldShowHints(
                    for: [.control],
                    hostWindowNumber: 42,
                    hostWindowIsKey: false,
                    eventWindowNumber: 42,
                    keyWindowNumber: 42,
                    defaults: defaults
                )
            )
        }
    }

    func testTabControlShortcutHintsFallbackToKeyWindowWhenEventWindowMissing() {
        withShortcutHintDefaultsSuite { defaults in
            defaults.set(true, forKey: TabControlShortcutHintPolicy.showHintsOnCommandHoldKey)

            XCTAssertTrue(
                TabControlShortcutHintPolicy.shouldShowHints(
                    for: [.control],
                    hostWindowNumber: 42,
                    hostWindowIsKey: true,
                    eventWindowNumber: nil,
                    keyWindowNumber: 42,
                    defaults: defaults
                )
            )

            XCTAssertFalse(
                TabControlShortcutHintPolicy.shouldShowHints(
                    for: [.control],
                    hostWindowNumber: 42,
                    hostWindowIsKey: true,
                    eventWindowNumber: nil,
                    keyWindowNumber: 7,
                    defaults: defaults
                )
            )
        }
    }

    func testSelectedTabNeverShowsHoverBackground() {
        XCTAssertFalse(
            TabItemStyling.shouldShowHoverBackground(isHovered: true, isSelected: true)
        )
        XCTAssertTrue(
            TabItemStyling.shouldShowHoverBackground(isHovered: true, isSelected: false)
        )
        XCTAssertFalse(
            TabItemStyling.shouldShowHoverBackground(isHovered: false, isSelected: false)
        )
    }

    func testTabBarSeparatorSegmentsClampGapIntoBounds() {
        var segments = TabBarStyling.separatorSegments(totalWidth: 100, gap: -20...40)
        XCTAssertEqual(segments.left, 0, accuracy: 0.0001)
        XCTAssertEqual(segments.right, 60, accuracy: 0.0001)

        segments = TabBarStyling.separatorSegments(totalWidth: 100, gap: 25...120)
        XCTAssertEqual(segments.left, 25, accuracy: 0.0001)
        XCTAssertEqual(segments.right, 0, accuracy: 0.0001)

        segments = TabBarStyling.separatorSegments(totalWidth: 100, gap: nil)
        XCTAssertEqual(segments.left, 100, accuracy: 0.0001)
        XCTAssertEqual(segments.right, 0, accuracy: 0.0001)
    }

    @MainActor
    func testPaneDropOverlayDoesNotResizeHostedContentDuringHover() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 240),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        defer { window.orderOut(nil) }
        guard let contentView = window.contentView else {
            XCTFail("Expected content view")
            return
        }

        let model = DropZoneModel()
        let probeView = LayoutProbeView(frame: .zero)
        let hostingView = NSHostingView(
            rootView: PaneDropInteractionHarness(
                model: model,
                probeView: probeView
            )
        )
        hostingView.frame = contentView.bounds
        hostingView.autoresizingMask = [.width, .height]
        contentView.addSubview(hostingView)

        window.makeKeyAndOrderFront(nil)
        contentView.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        contentView.layoutSubtreeIfNeeded()

        let initialFrame = probeView.frame
        let initialSizeChanges = probeView.sizeChangeCount
        let initialOriginChanges = probeView.originChangeCount

        model.zone = .left
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        contentView.layoutSubtreeIfNeeded()

        XCTAssertEqual(probeView.frame, initialFrame)
        XCTAssertEqual(
            probeView.sizeChangeCount,
            initialSizeChanges,
            "Drag-hover overlays must not resize the hosted pane content"
        )
        XCTAssertEqual(
            probeView.originChangeCount,
            initialOriginChanges,
            "Drag-hover overlays must not move the hosted pane content"
        )

        model.zone = .bottom
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        contentView.layoutSubtreeIfNeeded()

        XCTAssertEqual(probeView.frame, initialFrame)
        XCTAssertEqual(
            probeView.sizeChangeCount,
            initialSizeChanges,
            "Switching hover targets should keep the hosted pane geometry stable"
        )
        XCTAssertEqual(
            probeView.originChangeCount,
            initialOriginChanges,
            "Switching hover targets should not reposition the hosted pane content"
        )
    }

    @MainActor
    func testTranslucentSplitWrappersStayClear() {
        let appearance = BonsplitConfiguration.Appearance(
            enableAnimations: false,
            chromeColors: .init(backgroundHex: "#11223380")
        )
        let configuration = BonsplitConfiguration(appearance: appearance)
        let controller = BonsplitController(configuration: configuration)
        _ = controller.createTab(title: "Base")
        guard let sourcePane = controller.focusedPaneId else {
            XCTFail("Expected focused pane")
            return
        }
        guard controller.splitPane(sourcePane, orientation: .horizontal) != nil else {
            XCTFail("Expected splitPane to create a new pane")
            return
        }

        let hostingView = NSHostingView(
            rootView: BonsplitView(controller: controller) { _, _ in
                Color.clear
            } emptyPane: { _ in
                Color.clear
            }
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        defer { window.orderOut(nil) }
        guard let contentView = window.contentView else {
            XCTFail("Expected content view")
            return
        }

        hostingView.frame = contentView.bounds
        hostingView.autoresizingMask = [.width, .height]
        contentView.addSubview(hostingView)

        window.makeKeyAndOrderFront(nil)
        contentView.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        contentView.layoutSubtreeIfNeeded()

        guard let splitView = firstDescendant(ofType: NSSplitView.self, in: hostingView) else {
            XCTFail("Expected split view")
            return
        }
        XCTAssertEqual(splitView.arrangedSubviews.count, 2)

        let dividerBackground = splitView.layer?.backgroundColor.flatMap(NSColor.init(cgColor:))
        XCTAssertNotNil(dividerBackground, "Expected split view to be layer-backed")
        XCTAssertEqual(
            dividerBackground?.alphaComponent ?? 0,
            0,
            accuracy: 0.001,
            "Split root should stay clear so translucent pane chrome is painted only once"
        )

        for container in splitView.arrangedSubviews {
            let background = container.layer?.backgroundColor.flatMap(NSColor.init(cgColor:))
            XCTAssertNotNil(background, "Expected arranged subview to be layer-backed")
            XCTAssertEqual(
                background?.alphaComponent ?? -1,
                0,
                accuracy: 0.001,
                "Split-only wrapper containers should stay clear so translucent pane chrome is not composited twice"
            )
        }
    }

    @MainActor
    func testSplitContentAlphaMatchesSinglePane() {
        let appearance = BonsplitConfiguration.Appearance(
            enableAnimations: false,
            chromeColors: .init(backgroundHex: "#11223380")
        )
        let expectedAlpha = CGFloat(128.0 / 255.0)
        let samplePoint = NSPoint(x: 100, y: 100)

        let singlePaneController = BonsplitController(
            configuration: BonsplitConfiguration(appearance: appearance)
        )
        _ = singlePaneController.createTab(title: "Base")

        guard let singlePaneAlpha = renderedAlpha(
            for: singlePaneController,
            samplePoint: samplePoint
        ) else {
            XCTFail("Expected single-pane rendered alpha")
            return
        }
        XCTAssertEqual(
            singlePaneAlpha,
            expectedAlpha,
            accuracy: 0.03,
            "Single-pane content should preserve the configured translucent alpha"
        )

        let splitController = BonsplitController(
            configuration: BonsplitConfiguration(appearance: appearance)
        )
        _ = splitController.createTab(title: "Base")
        guard let sourcePane = splitController.focusedPaneId else {
            XCTFail("Expected focused pane")
            return
        }
        guard splitController.splitPane(sourcePane, orientation: .horizontal) != nil else {
            XCTFail("Expected splitPane to create a new pane")
            return
        }

        guard let splitAlpha = renderedAlpha(
            for: splitController,
            samplePoint: samplePoint
        ) else {
            XCTFail("Expected split rendered alpha")
            return
        }

        XCTAssertEqual(
            splitAlpha,
            singlePaneAlpha,
            accuracy: 0.03,
            "Split mode should render the same content alpha as single-pane mode"
        )
    }

    private func withShortcutHintDefaultsSuite(_ body: (UserDefaults) -> Void) {
        let suiteName = "BonsplitShortcutHintPolicyTests-\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Failed to create defaults suite")
            return
        }

        defaults.removePersistentDomain(forName: suiteName)
        body(defaults)
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func shortcutData(
        key: String,
        command: Bool,
        shift: Bool,
        option: Bool,
        control: Bool
    ) -> Data {
        let payload: [String: Any] = [
            "key": key,
            "command": command,
            "shift": shift,
            "option": option,
            "control": control
        ]
        return try! JSONSerialization.data(withJSONObject: payload, options: [])
    }

    private func firstDescendant<T: NSView>(ofType type: T.Type, in root: NSView) -> T? {
        if let match = root as? T {
            return match
        }
        for subview in root.subviews {
            if let match = firstDescendant(ofType: type, in: subview) {
                return match
            }
        }
        return nil
    }

    @MainActor
    private func renderedAlpha(
        for controller: BonsplitController,
        samplePoint: NSPoint,
        size: NSSize = NSSize(width: 800, height: 600)
    ) -> CGFloat? {
        let hostingView = NSHostingView(
            rootView: BonsplitView(controller: controller) { _, _ in
                Color.clear
            } emptyPane: { _ in
                Color.clear
            }
        )
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        defer { window.orderOut(nil) }
        guard let contentView = window.contentView else { return nil }

        contentView.wantsLayer = true
        contentView.layer?.backgroundColor = NSColor.clear.cgColor
        hostingView.frame = contentView.bounds
        hostingView.autoresizingMask = [.width, .height]
        contentView.addSubview(hostingView)

        window.makeKeyAndOrderFront(nil)
        contentView.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        contentView.layoutSubtreeIfNeeded()

        return renderedColor(in: hostingView, at: samplePoint)?.alphaComponent
    }

    @MainActor
    private func renderedColor(in view: NSView, at point: NSPoint) -> NSColor? {
        let integralBounds = view.bounds.integral
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: integralBounds) else { return nil }
        bitmap.size = integralBounds.size
        view.cacheDisplay(in: integralBounds, to: bitmap)

        let x = Int(point.x.rounded())
        let y = Int(point.y.rounded())
        guard x >= 0,
              y >= 0,
              x < bitmap.pixelsWide,
              y < bitmap.pixelsHigh else { return nil }
        return bitmap.colorAt(x: x, y: y)
    }

    @MainActor
    private func makeLeftMouseDownEvent(
        in view: NSView,
        at point: NSPoint,
        clickCount: Int
    ) throws -> NSEvent {
        guard let window = view.window else {
            throw NSError(domain: "BonsplitTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing window"])
        }
        let pointInWindow = view.convert(point, to: nil)
        guard let event = NSEvent.mouseEvent(
            with: .leftMouseDown,
            location: pointInWindow,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: clickCount,
            pressure: 1
        ) else {
            throw NSError(domain: "BonsplitTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create mouse event"])
        }
        return event
    }
}
