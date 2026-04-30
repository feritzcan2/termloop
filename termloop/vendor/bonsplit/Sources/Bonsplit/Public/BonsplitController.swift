import Foundation
import SwiftUI

/// Main controller for the split tab bar system
@MainActor
@Observable
public final class BonsplitController {

    public struct ExternalTabDropRequest {
        public enum Destination {
            case insert(targetPane: PaneID, targetIndex: Int?)
            case split(targetPane: PaneID, orientation: SplitOrientation, insertFirst: Bool)
        }

        public let tabId: TabID
        public let sourcePaneId: PaneID
        public let destination: Destination

        public init(tabId: TabID, sourcePaneId: PaneID, destination: Destination) {
            self.tabId = tabId
            self.sourcePaneId = sourcePaneId
            self.destination = destination
        }
    }

    // MARK: - Delegate

    /// Delegate for receiving callbacks about tab bar events
    public weak var delegate: BonsplitDelegate?

    // MARK: - Configuration

    /// Configuration for behavior and appearance
    public var configuration: BonsplitConfiguration

    /// When false, drop delegates reject all drags. Set to false for inactive workspaces
    /// so their views (kept alive in a ZStack for state preservation) don't intercept drags
    /// meant for the active workspace.
    @ObservationIgnored public var isInteractive: Bool = true {
        didSet { internalController.isInteractive = isInteractive }
    }

    /// Handler for file/URL drops from external apps (e.g., Finder).
    /// Called when files are dropped onto a pane's content area.
    /// Return `true` if the drop was handled.
    @ObservationIgnored public var onFileDrop: ((_ urls: [URL], _ paneId: PaneID) -> Bool)? {
        didSet { internalController.onFileDrop = onFileDrop }
    }

    /// Handler for tab drops originating from another Bonsplit controller (e.g. another workspace/window).
    /// Return `true` when the drop has been handled by the host application.
    @ObservationIgnored public var onExternalTabDrop: ((ExternalTabDropRequest) -> Bool)?

    /// Called when the user explicitly requests to close a tab from the tab strip UI.
    /// Internal host-driven closes should not use this hook.
    @ObservationIgnored public var onTabCloseRequest: ((_ tabId: TabID, _ paneId: PaneID) -> Void)?

    // MARK: - Internal State

    internal var internalController: SplitViewController
    @ObservationIgnored private var sidebarOrderRevision: Int = 0

    // MARK: - Initialization

    /// Create a new controller with the specified configuration
    public init(configuration: BonsplitConfiguration = .default) {
        self.configuration = configuration
        self.internalController = SplitViewController()
    }

    private func invalidateSidebarOrderCache() {
        sidebarOrderRevision &+= 1
    }

    // MARK: - Tab Operations

    /// Create a new tab in the focused pane (or specified pane)
    /// - Parameters:
    ///   - title: The tab title
    ///   - icon: Optional SF Symbol name for the tab icon
    ///   - iconImageData: Optional image data (PNG recommended) for the tab icon. When present, takes precedence over `icon`.
    ///   - kind: Consumer-defined tab kind identifier (e.g. "terminal", "browser")
    ///   - hasCustomTitle: Whether the tab title came from a custom user override
    ///   - isDirty: Whether the tab shows a dirty indicator
    ///   - showsNotificationBadge: Whether the tab shows an "unread/activity" badge
    ///   - isLoading: Whether the tab shows an activity/loading indicator (e.g. spinning icon)
    ///   - isPinned: Whether the tab should be treated as pinned
    ///   - pane: Optional pane to add the tab to (defaults to focused pane)
    /// - Returns: The TabID of the created tab, or nil if creation was vetoed by delegate
    @discardableResult
    public func createTab(
        title: String,
        hasCustomTitle: Bool = false,
        icon: String? = "doc.text",
        iconImageData: Data? = nil,
        kind: String? = nil,
        isDirty: Bool = false,
        showsNotificationBadge: Bool = false,
        isLoading: Bool = false,
        isPinned: Bool = false,
        inPane pane: PaneID? = nil
    ) -> TabID? {
        let tabId = TabID()
        let tab = Tab(
            id: tabId,
            title: title,
            hasCustomTitle: hasCustomTitle,
            icon: icon,
            iconImageData: iconImageData,
            kind: kind,
            isDirty: isDirty,
            showsNotificationBadge: showsNotificationBadge,
            isLoading: isLoading,
            isPinned: isPinned
        )
        let targetPane = pane ?? focusedPaneId ?? PaneID(id: internalController.rootNode.allPaneIds.first!.id)

        // Check with delegate
        if delegate?.splitTabBar(self, shouldCreateTab: tab, inPane: targetPane) == false {
            return nil
        }

        // Calculate insertion index based on configuration
        let insertIndex: Int?
        switch configuration.newTabPosition {
        case .current:
            // Insert after the currently selected tab
            if let paneState = internalController.rootNode.findPane(PaneID(id: targetPane.id)),
               let selectedTabId = paneState.selectedTabId,
               let currentIndex = paneState.tabs.firstIndex(where: { $0.id == selectedTabId }) {
                insertIndex = currentIndex + 1
            } else {
                // No selected tab, append to end
                insertIndex = nil
            }
        case .end:
            insertIndex = nil
        }

        // Create internal TabItem
        let tabItem = TabItem(
            id: tabId.id,
            title: title,
            hasCustomTitle: hasCustomTitle,
            icon: icon,
            iconImageData: iconImageData,
            kind: kind,
            isDirty: isDirty,
            showsNotificationBadge: showsNotificationBadge,
            isLoading: isLoading,
            isPinned: isPinned
        )
        internalController.addTab(tabItem, toPane: PaneID(id: targetPane.id), atIndex: insertIndex)
        invalidateSidebarOrderCache()

        // Notify delegate
        delegate?.splitTabBar(self, didCreateTab: tab, inPane: targetPane)

        return tabId
    }

    /// Request the delegate to create a new tab of the given kind in a pane.
    /// The delegate is responsible for the actual creation logic.
    public func requestNewTab(kind: String, inPane pane: PaneID) {
        delegate?.splitTabBar(self, didRequestNewTab: kind, inPane: pane)
    }

    /// Request the delegate to handle a tab context-menu action.
    public func requestTabContextAction(_ action: TabContextAction, for tabId: TabID, inPane pane: PaneID) {
        guard let tab = tab(tabId) else { return }
        delegate?.splitTabBar(self, didRequestTabContextAction: action, for: tab, inPane: pane)
    }

    /// Update an existing tab's metadata
    /// - Parameters:
    ///   - tabId: The tab to update
    ///   - title: New title (pass nil to keep current)
    ///   - icon: New icon (pass nil to keep current, pass .some(nil) to remove icon)
    ///   - iconImageData: New icon image data (pass nil to keep current, pass .some(nil) to remove)
    ///   - kind: New tab kind (pass nil to keep current, pass .some(nil) to clear)
    ///   - hasCustomTitle: New custom-title state (pass nil to keep current)
    ///   - isDirty: New dirty state (pass nil to keep current)
    ///   - showsNotificationBadge: New badge state (pass nil to keep current)
    ///   - isLoading: New loading/busy state (pass nil to keep current)
    ///   - isPinned: New pinned state (pass nil to keep current)
    public func updateTab(
        _ tabId: TabID,
        title: String? = nil,
        icon: String?? = nil,
        iconImageData: Data?? = nil,
        kind: String?? = nil,
        hasCustomTitle: Bool? = nil,
        isDirty: Bool? = nil,
        showsNotificationBadge: Bool? = nil,
        isLoading: Bool? = nil,
        isPinned: Bool? = nil
    ) {
        guard let (pane, tabIndex) = findTabInternal(tabId) else { return }

        if let title = title {
            pane.tabs[tabIndex].title = title
        }
        if let icon = icon {
            pane.tabs[tabIndex].icon = icon
        }
        if let iconImageData = iconImageData {
            pane.tabs[tabIndex].iconImageData = iconImageData
        }
        if let kind = kind {
            pane.tabs[tabIndex].kind = kind
        }
        if let hasCustomTitle = hasCustomTitle {
            pane.tabs[tabIndex].hasCustomTitle = hasCustomTitle
        }
        if let isDirty = isDirty {
            pane.tabs[tabIndex].isDirty = isDirty
        }
        if let showsNotificationBadge = showsNotificationBadge {
            pane.tabs[tabIndex].showsNotificationBadge = showsNotificationBadge
        }
        if let isLoading = isLoading {
            pane.tabs[tabIndex].isLoading = isLoading
        }
        if let isPinned = isPinned {
            pane.tabs[tabIndex].isPinned = isPinned
        }
    }

    /// Close a tab by ID
    /// - Parameter tabId: The tab to close
    /// - Returns: true if the tab was closed, false if vetoed by delegate
    @discardableResult
    public func closeTab(_ tabId: TabID) -> Bool {
        guard let (pane, tabIndex) = findTabInternal(tabId) else { return false }
        return closeTab(tabId, with: tabIndex, in: pane)
    }
    
    /// Close a tab by ID in a specific pane.
    /// - Parameter tabId: The tab to close
    /// - Parameter paneId: The pane in which to close the tab
    public func closeTab(_ tabId: TabID, inPane paneId: PaneID) -> Bool {
        guard let pane = internalController.rootNode.findPane(paneId),
              let tabIndex = pane.tabs.firstIndex(where: { $0.id == tabId.id }) else {
            return false
        }
        
        return closeTab(tabId, with: tabIndex, in: pane)
    }
    
    /// Internal helper to close a tab given its index in a pane
    /// - Parameter tabId: The tab to close
    /// - Parameter tabIndex: The position of the tab within the pane
    /// - Parameter pane: The pane in which to close the tab
    private func closeTab(_ tabId: TabID, with tabIndex: Int, in pane: PaneState) -> Bool {
        let tabItem = pane.tabs[tabIndex]
        let tab = Tab(from: tabItem)
        let paneId = pane.id

        // Check with delegate
        if delegate?.splitTabBar(self, shouldCloseTab: tab, inPane: paneId) == false {
            return false
        }

        internalController.closeTab(tabId.id, inPane: pane.id)
        invalidateSidebarOrderCache()

        // Notify delegate
        delegate?.splitTabBar(self, didCloseTab: tabId, fromPane: paneId)
        notifyGeometryChange()

        return true
    }

    /// Select a tab by ID
    /// - Parameter tabId: The tab to select
    public func selectTab(_ tabId: TabID) {
        guard let (pane, tabIndex) = findTabInternal(tabId) else { return }

        pane.selectTab(tabId.id)
        internalController.focusPane(pane.id)

        // Notify delegate
        let tab = Tab(from: pane.tabs[tabIndex])
        delegate?.splitTabBar(self, didSelectTab: tab, inPane: pane.id)
    }

    /// Move a tab to a specific pane (and optional index) inside this controller.
    /// - Parameters:
    ///   - tabId: The tab to move.
    ///   - targetPaneId: Destination pane.
    ///   - index: Optional destination index. When nil, appends at the end.
    /// - Returns: true if moved.
    @discardableResult
    public func moveTab(_ tabId: TabID, toPane targetPaneId: PaneID, atIndex index: Int? = nil) -> Bool {
        guard let (sourcePane, sourceIndex) = findTabInternal(tabId) else { return false }
        guard let targetPane = internalController.rootNode.findPane(PaneID(id: targetPaneId.id)) else { return false }

        let tabItem = sourcePane.tabs[sourceIndex]
        let movedTab = Tab(from: tabItem)
        let sourcePaneId = sourcePane.id

        if sourcePaneId == targetPane.id {
            // Reorder within same pane.
            let destinationIndex: Int = {
                if let index { return max(0, min(index, sourcePane.tabs.count)) }
                return sourcePane.tabs.count
            }()
            sourcePane.moveTab(from: sourceIndex, to: destinationIndex)
            invalidateSidebarOrderCache()
            sourcePane.selectTab(tabItem.id)
            internalController.focusPane(sourcePane.id)
            delegate?.splitTabBar(self, didSelectTab: movedTab, inPane: sourcePane.id)
            notifyGeometryChange()
            return true
        }

        internalController.moveTab(tabItem, from: sourcePaneId, to: targetPane.id, atIndex: index)
        invalidateSidebarOrderCache()
        delegate?.splitTabBar(self, didMoveTab: movedTab, fromPane: sourcePaneId, toPane: targetPane.id)
        notifyGeometryChange()
        return true
    }

    /// Reorder a tab within its pane.
    /// - Parameters:
    ///   - tabId: The tab to reorder.
    ///   - toIndex: Destination index.
    /// - Returns: true if reordered.
    @discardableResult
    public func reorderTab(_ tabId: TabID, toIndex: Int) -> Bool {
        guard let (pane, sourceIndex) = findTabInternal(tabId) else { return false }
        let destinationIndex = max(0, min(toIndex, pane.tabs.count))
        pane.moveTab(from: sourceIndex, to: destinationIndex)
        invalidateSidebarOrderCache()
        pane.selectTab(tabId.id)
        internalController.focusPane(pane.id)
        if let tabIndex = pane.tabs.firstIndex(where: { $0.id == tabId.id }) {
            let tab = Tab(from: pane.tabs[tabIndex])
            delegate?.splitTabBar(self, didSelectTab: tab, inPane: pane.id)
        }
        notifyGeometryChange()
        return true
    }

    /// Move to previous tab in focused pane
    public func selectPreviousTab() {
        internalController.selectPreviousTab()
        notifyTabSelection()
    }

    /// Move to next tab in focused pane
    public func selectNextTab() {
        internalController.selectNextTab()
        notifyTabSelection()
    }

    // MARK: - Split Operations

    /// Split the focused pane (or specified pane)
    /// - Parameters:
    ///   - paneId: Optional pane to split (defaults to focused pane)
    ///   - orientation: Direction to split (horizontal = side-by-side, vertical = stacked)
    ///   - tab: Optional tab to add to the new pane
    /// - Returns: The new pane ID, or nil if vetoed by delegate
    @discardableResult
    public func splitPane(
        _ paneId: PaneID? = nil,
        orientation: SplitOrientation,
        withTab tab: Tab? = nil
    ) -> PaneID? {
        guard configuration.allowSplits else { return nil }

        let targetPaneId = paneId ?? focusedPaneId
        guard let targetPaneId else { return nil }

        // Check with delegate
        if delegate?.splitTabBar(self, shouldSplitPane: targetPaneId, orientation: orientation) == false {
            return nil
        }

        let internalTab: TabItem?
        if let tab {
            internalTab = TabItem(
                id: tab.id.id,
                title: tab.title,
                hasCustomTitle: tab.hasCustomTitle,
                icon: tab.icon,
                iconImageData: tab.iconImageData,
                kind: tab.kind,
                isDirty: tab.isDirty,
                showsNotificationBadge: tab.showsNotificationBadge,
                isLoading: tab.isLoading,
                isPinned: tab.isPinned
            )
        } else {
            internalTab = nil
        }

        // Perform split
        internalController.splitPane(
            PaneID(id: targetPaneId.id),
            orientation: orientation,
            with: internalTab
        )
        invalidateSidebarOrderCache()

        // Find new pane (will be focused after split)
        let newPaneId = focusedPaneId!

        // Notify delegate
        delegate?.splitTabBar(self, didSplitPane: targetPaneId, newPane: newPaneId, orientation: orientation)

        notifyGeometryChange()

        return newPaneId
    }

    /// Split a pane and place a specific tab in the newly created pane, choosing which side to insert on.
    ///
    /// This is like `splitPane(_:orientation:withTab:)`, but allows choosing left/top vs right/bottom insertion
    /// without needing to create then move a tab.
    ///
    /// - Parameters:
    ///   - paneId: Optional pane to split (defaults to focused pane).
    ///   - orientation: Direction to split (horizontal = side-by-side, vertical = stacked).
    ///   - tab: The tab to add to the new pane.
    ///   - insertFirst: If true, insert the new pane first (left/top). Otherwise insert second (right/bottom).
    /// - Returns: The new pane ID, or nil if vetoed by delegate.
    @discardableResult
    public func splitPane(
        _ paneId: PaneID? = nil,
        orientation: SplitOrientation,
        withTab tab: Tab,
        insertFirst: Bool
    ) -> PaneID? {
        guard configuration.allowSplits else { return nil }

        let targetPaneId = paneId ?? focusedPaneId
        guard let targetPaneId else { return nil }

        // Check with delegate
        if delegate?.splitTabBar(self, shouldSplitPane: targetPaneId, orientation: orientation) == false {
            return nil
        }

        let internalTab = TabItem(
            id: tab.id.id,
            title: tab.title,
            hasCustomTitle: tab.hasCustomTitle,
            icon: tab.icon,
            iconImageData: tab.iconImageData,
            kind: tab.kind,
            isDirty: tab.isDirty,
            showsNotificationBadge: tab.showsNotificationBadge,
            isLoading: tab.isLoading,
            isPinned: tab.isPinned
        )

        // Perform split with insertion side.
        internalController.splitPaneWithTab(
            PaneID(id: targetPaneId.id),
            orientation: orientation,
            tab: internalTab,
            insertFirst: insertFirst
        )
        invalidateSidebarOrderCache()

        let newPaneId = focusedPaneId!

        // Notify delegate
        delegate?.splitTabBar(self, didSplitPane: targetPaneId, newPane: newPaneId, orientation: orientation)

        notifyGeometryChange()

        return newPaneId
    }

    /// Split a pane by moving an existing tab into the new pane.
    ///
    /// This mirrors the "drag a tab to a pane edge to create a split" interaction:
    /// the tab is removed from its source pane first, then inserted into the newly
    /// created pane on the chosen edge.
    ///
    /// - Parameters:
    ///   - paneId: Optional target pane to split (defaults to the tab's current pane).
    ///   - orientation: Direction to split (horizontal = side-by-side, vertical = stacked).
    ///   - tabId: The existing tab to move into the new pane.
    ///   - insertFirst: If true, the new pane is inserted first (left/top). Otherwise it is inserted second (right/bottom).
    /// - Returns: The new pane ID, or nil if the tab couldn't be found or the split was vetoed.
    @discardableResult
    public func splitPane(
        _ paneId: PaneID? = nil,
        orientation: SplitOrientation,
        movingTab tabId: TabID,
        insertFirst: Bool
    ) -> PaneID? {
        guard configuration.allowSplits else { return nil }

        // Find the existing tab and its source pane.
        guard let (sourcePane, tabIndex) = findTabInternal(tabId) else { return nil }
        let tabItem = sourcePane.tabs[tabIndex]

        // Default target to the tab's current pane to match edge-drop behavior on the source pane.
        let targetPaneId = paneId ?? sourcePane.id

        // Check with delegate
        if delegate?.splitTabBar(self, shouldSplitPane: targetPaneId, orientation: orientation) == false {
            return nil
        }

        // Remove from source first.
        sourcePane.removeTab(tabItem.id)

        if sourcePane.tabs.isEmpty {
            if sourcePane.id == targetPaneId {
                // Keep a placeholder tab so the original pane isn't left "tabless".
                // This makes the empty side closable via tab close, and avoids apps
                // needing to special-case empty panes.
                sourcePane.addTab(TabItem(title: "Empty", icon: nil), select: true)
            } else if internalController.rootNode.allPaneIds.count > 1 {
                // If the source pane is now empty, close it (unless it's also the split target).
                internalController.closePane(sourcePane.id)
            }
        }

        // Perform split with the moved tab.
        internalController.splitPaneWithTab(
            PaneID(id: targetPaneId.id),
            orientation: orientation,
            tab: tabItem,
            insertFirst: insertFirst
        )
        invalidateSidebarOrderCache()

        let newPaneId = focusedPaneId!

        // Notify delegate
        delegate?.splitTabBar(self, didSplitPane: targetPaneId, newPane: newPaneId, orientation: orientation)

        notifyGeometryChange()

        return newPaneId
    }

    /// Close a specific pane
    /// - Parameter paneId: The pane to close
    /// - Returns: true if the pane was closed, false if vetoed by delegate
    @discardableResult
    public func closePane(_ paneId: PaneID) -> Bool {
        // Don't close if it's the last pane and not allowed
        if !configuration.allowCloseLastPane && internalController.rootNode.allPaneIds.count <= 1 {
            return false
        }

        // Check with delegate
        if delegate?.splitTabBar(self, shouldClosePane: paneId) == false {
            return false
        }

        internalController.closePane(PaneID(id: paneId.id))
        invalidateSidebarOrderCache()

        // Notify delegate
        delegate?.splitTabBar(self, didClosePane: paneId)

        notifyGeometryChange()

        return true
    }

    // MARK: - Focus Management

    /// Currently focused pane ID
    public var focusedPaneId: PaneID? {
        guard let internalId = internalController.focusedPaneId else { return nil }
        return internalId
    }

    /// Focus a specific pane
    public func focusPane(_ paneId: PaneID) {
        internalController.focusPane(PaneID(id: paneId.id))
        delegate?.splitTabBar(self, didFocusPane: paneId)
    }

    /// Navigate focus in a direction
    public func navigateFocus(direction: NavigationDirection) {
        internalController.navigateFocus(direction: direction)
        if let focusedPaneId {
            delegate?.splitTabBar(self, didFocusPane: focusedPaneId)
        }
    }

    /// Find the closest pane in the requested direction from the given pane.
    public func adjacentPane(to paneId: PaneID, direction: NavigationDirection) -> PaneID? {
        internalController.adjacentPane(to: paneId, direction: direction)
    }

    // MARK: - Split Zoom

    /// Currently zoomed pane ID, if any.
    public var zoomedPaneId: PaneID? {
        internalController.zoomedPaneId
    }

    public var isSplitZoomed: Bool {
        internalController.zoomedPaneId != nil
    }

    @discardableResult
    public func clearPaneZoom() -> Bool {
        internalController.clearPaneZoom()
    }

    /// Toggle zoom for a pane. When zoomed, only that pane is rendered in the split area.
    /// Passing nil toggles the currently focused pane.
    @discardableResult
    public func togglePaneZoom(inPane paneId: PaneID? = nil) -> Bool {
        let targetPaneId = paneId ?? focusedPaneId
        guard let targetPaneId else { return false }
        return internalController.togglePaneZoom(targetPaneId)
    }

    // MARK: - Context Menu Shortcut Hints

    /// Keyboard shortcuts to display in tab context menus, keyed by context action.
    /// Set by the host app to sync with its customizable keyboard shortcut settings.
    public var contextMenuShortcuts: [TabContextAction: KeyboardShortcut] = [:]

    // MARK: - Query Methods

    /// Get all tab IDs
    public var allTabIds: [TabID] {
        internalController.rootNode.allPanes.flatMap { pane in
            pane.tabs.map { TabID(id: $0.id) }
        }
    }

    /// Get all pane IDs
    public var allPaneIds: [PaneID] {
        internalController.rootNode.allPaneIds
    }

    /// Get tab metadata by ID
    public func tab(_ tabId: TabID) -> Tab? {
        guard let (pane, tabIndex) = findTabInternal(tabId) else { return nil }
        return Tab(from: pane.tabs[tabIndex])
    }

    /// Get tabs in a specific pane
    public func tabs(inPane paneId: PaneID) -> [Tab] {
        guard let pane = internalController.rootNode.findPane(PaneID(id: paneId.id)) else {
            return []
        }
        return pane.tabs.map { Tab(from: $0) }
    }

    /// Get selected tab in a pane
    public func selectedTab(inPane paneId: PaneID) -> Tab? {
        guard let pane = internalController.rootNode.findPane(PaneID(id: paneId.id)),
              let selected = pane.selectedTab else {
            return nil
        }
        return Tab(from: selected)
    }

    // MARK: - Geometry Query API

    /// Get current layout snapshot with pixel coordinates
    public func layoutSnapshot() -> LayoutSnapshot {
        let containerFrame = internalController.containerFrame
        let paneBounds = internalController.rootNode.computePaneBounds()

        let paneGeometries = paneBounds.map { bounds -> PaneGeometry in
            let pane = internalController.rootNode.findPane(bounds.paneId)
            let pixelFrame = PixelRect(
                x: Double(bounds.bounds.minX * containerFrame.width + containerFrame.origin.x),
                y: Double(bounds.bounds.minY * containerFrame.height + containerFrame.origin.y),
                width: Double(bounds.bounds.width * containerFrame.width),
                height: Double(bounds.bounds.height * containerFrame.height)
            )
            return PaneGeometry(
                paneId: bounds.paneId.id.uuidString,
                frame: pixelFrame,
                selectedTabId: pane?.selectedTabId?.uuidString,
                tabIds: pane?.tabs.map { $0.id.uuidString } ?? []
            )
        }

        return LayoutSnapshot(
            containerFrame: PixelRect(from: containerFrame),
            panes: paneGeometries,
            focusedPaneId: focusedPaneId?.id.uuidString,
            timestamp: Date().timeIntervalSince1970
        )
    }

    /// Get full tree structure for external consumption
    public func treeSnapshot() -> ExternalTreeNode {
        let containerFrame = internalController.containerFrame
        return buildExternalTree(from: internalController.rootNode, containerFrame: containerFrame)
    }

    public var sidebarStructureRevision: Int {
        sidebarOrderRevision
    }

    private func buildExternalTree(from node: SplitNode, containerFrame: CGRect, bounds: CGRect = CGRect(x: 0, y: 0, width: 1, height: 1)) -> ExternalTreeNode {
        switch node {
        case .pane(let paneState):
            let pixelFrame = PixelRect(
                x: Double(bounds.minX * containerFrame.width + containerFrame.origin.x),
                y: Double(bounds.minY * containerFrame.height + containerFrame.origin.y),
                width: Double(bounds.width * containerFrame.width),
                height: Double(bounds.height * containerFrame.height)
            )
            let tabs = paneState.tabs.map { ExternalTab(id: $0.id.uuidString, title: $0.title) }
            let paneNode = ExternalPaneNode(
                id: paneState.id.id.uuidString,
                frame: pixelFrame,
                tabs: tabs,
                selectedTabId: paneState.selectedTabId?.uuidString
            )
            return .pane(paneNode)

        case .split(let splitState):
            let dividerPos = splitState.dividerPosition
            let firstBounds: CGRect
            let secondBounds: CGRect

            switch splitState.orientation {
            case .horizontal:
                firstBounds = CGRect(x: bounds.minX, y: bounds.minY,
                                     width: bounds.width * dividerPos, height: bounds.height)
                secondBounds = CGRect(x: bounds.minX + bounds.width * dividerPos, y: bounds.minY,
                                      width: bounds.width * (1 - dividerPos), height: bounds.height)
            case .vertical:
                firstBounds = CGRect(x: bounds.minX, y: bounds.minY,
                                     width: bounds.width, height: bounds.height * dividerPos)
                secondBounds = CGRect(x: bounds.minX, y: bounds.minY + bounds.height * dividerPos,
                                      width: bounds.width, height: bounds.height * (1 - dividerPos))
            }

            let splitNode = ExternalSplitNode(
                id: splitState.id.uuidString,
                orientation: splitState.orientation == .horizontal ? "horizontal" : "vertical",
                dividerPosition: Double(splitState.dividerPosition),
                first: buildExternalTree(from: splitState.first, containerFrame: containerFrame, bounds: firstBounds),
                second: buildExternalTree(from: splitState.second, containerFrame: containerFrame, bounds: secondBounds)
            )
            return .split(splitNode)
        }
    }

    /// Check if a split exists by ID
    public func findSplit(_ splitId: UUID) -> Bool {
        return internalController.findSplit(splitId) != nil
    }

    // MARK: - Geometry Update API

    /// Set divider position for a split node (0.0-1.0)
    /// - Parameters:
    ///   - position: The new divider position (clamped to 0.1-0.9)
    ///   - splitId: The UUID of the split to update
    ///   - fromExternal: Set to true to suppress outgoing notifications (prevents loops)
    /// - Returns: true if the split was found and updated
    @discardableResult
    public func setDividerPosition(_ position: CGFloat, forSplit splitId: UUID, fromExternal: Bool = false) -> Bool {
        guard let split = internalController.findSplit(splitId) else { return false }

        if fromExternal {
            internalController.isExternalUpdateInProgress = true
        }

        // Clamp position to valid range
        let clampedPosition = min(max(position, 0.1), 0.9)
        split.dividerPosition = clampedPosition

        if fromExternal {
            // Use a slight delay to allow the UI to update before re-enabling notifications
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.internalController.isExternalUpdateInProgress = false
            }
        }

        return true
    }

    /// Update container frame (called when window moves/resizes)
    public func setContainerFrame(_ frame: CGRect) {
        internalController.containerFrame = frame
    }

    /// Notify geometry change to delegate (internal use)
    /// - Parameter isDragging: Whether the change is due to active divider dragging
    internal func notifyGeometryChange(isDragging: Bool = false) {
        guard !internalController.isExternalUpdateInProgress else { return }

        // If dragging, check if delegate wants notifications during drag
        if isDragging {
            let shouldNotify = delegate?.splitTabBar(self, shouldNotifyDuringDrag: true) ?? false
            guard shouldNotify else { return }
        }

        if isDragging {
            // Debounce drag updates to avoid flooding delegates during divider moves.
            let now = Date().timeIntervalSince1970
            let debounceInterval: TimeInterval = 0.05
            guard now - internalController.lastGeometryNotificationTime >= debounceInterval else { return }
            internalController.lastGeometryNotificationTime = now
        }

        let snapshot = layoutSnapshot()
        delegate?.splitTabBar(self, didChangeGeometry: snapshot)
    }

    // MARK: - Private Helpers

    private func findTabInternal(_ tabId: TabID) -> (PaneState, Int)? {
        for pane in internalController.rootNode.allPanes {
            if let index = pane.tabs.firstIndex(where: { $0.id == tabId.id }) {
                return (pane, index)
            }
        }
        return nil
    }

    private func notifyTabSelection() {
        guard let pane = internalController.focusedPane,
              let tabItem = pane.selectedTab else { return }
        let tab = Tab(from: tabItem)
        delegate?.splitTabBar(self, didSelectTab: tab, inPane: pane.id)
    }
}
