import SwiftUI
import UniformTypeIdentifiers
import AppKit

/// Drop zone positions for creating splits
public enum DropZone: Equatable {
    case center
    case left
    case right
    case top
    case bottom

    var orientation: SplitOrientation? {
        switch self {
        case .left, .right: return .horizontal
        case .top, .bottom: return .vertical
        case .center: return nil
        }
    }

    var insertsFirst: Bool {
        switch self {
        case .left, .top: return true
        default: return false
        }
    }
}

// MARK: - Environment key for portal-hosted views

/// Environment key so portal-hosted content (e.g. terminal surfaces rendered
/// above SwiftUI via an AppKit portal) can read the active drop zone and show
/// their own overlay, since the SwiftUI placeholder is hidden behind the portal.
private struct ActiveDropZoneKey: EnvironmentKey {
    static let defaultValue: DropZone? = nil
}

public extension EnvironmentValues {
    var paneDropZone: DropZone? {
        get { self[ActiveDropZoneKey.self] }
        set { self[ActiveDropZoneKey.self] = newValue }
    }
}

/// Drop lifecycle state to prevent dropUpdated from re-setting state after performDrop
enum PaneDropLifecycle {
    case idle
    case hovering
}

private struct PaneDropPlaceholderOverlay: View {
    let zone: DropZone?
    let size: CGSize

    private let placeholderColor = Color.accentColor.opacity(0.25)
    private let borderColor = Color.accentColor
    private let padding: CGFloat = 4

    var body: some View {
        let frame = overlayFrame(for: zone, in: size)

        RoundedRectangle(cornerRadius: 8)
            .fill(placeholderColor)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(borderColor, lineWidth: 2)
            )
            .frame(width: frame.width, height: frame.height)
            .offset(x: frame.minX, y: frame.minY)
            .opacity(zone != nil ? 1 : 0)
            .animation(.spring(duration: 0.25, bounce: 0.15), value: zone)
    }

    private func overlayFrame(for zone: DropZone?, in size: CGSize) -> CGRect {
        switch zone {
        case .center, .none:
            return CGRect(
                x: padding,
                y: padding,
                width: size.width - padding * 2,
                height: size.height - padding * 2
            )
        case .left:
            return CGRect(
                x: padding,
                y: padding,
                width: size.width / 2 - padding,
                height: size.height - padding * 2
            )
        case .right:
            return CGRect(
                x: size.width / 2,
                y: padding,
                width: size.width / 2 - padding,
                height: size.height - padding * 2
            )
        case .top:
            return CGRect(
                x: padding,
                y: padding,
                width: size.width - padding * 2,
                height: size.height / 2 - padding
            )
        case .bottom:
            return CGRect(
                x: padding,
                y: size.height / 2,
                width: size.width - padding * 2,
                height: size.height / 2 - padding
            )
        }
    }
}

struct PaneDropInteractionContainer<Content: View, DropLayer: View>: View {
    let activeDropZone: DropZone?
    let content: Content
    let dropLayer: (CGSize) -> DropLayer

    init(
        activeDropZone: DropZone?,
        @ViewBuilder content: () -> Content,
        @ViewBuilder dropLayer: @escaping (CGSize) -> DropLayer
    ) {
        self.activeDropZone = activeDropZone
        self.content = content()
        self.dropLayer = dropLayer
    }

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size

            content
                .frame(width: size.width, height: size.height)
                .overlay {
                    dropLayer(size)
                }
                .overlay(alignment: .topLeading) {
                    PaneDropPlaceholderOverlay(zone: activeDropZone, size: size)
                        .allowsHitTesting(false)
                }
        }
        .clipped()
    }
}

/// Container for a single pane with its tab bar and content area
struct PaneContainerView<Content: View, EmptyContent: View>: View {
    @Environment(BonsplitController.self) private var bonsplitController

    @Bindable var pane: PaneState
    @Bindable var controller: SplitViewController
    let contentBuilder: (TabItem, PaneID) -> Content
    let emptyPaneBuilder: (PaneID) -> EmptyContent
    var showSplitButtons: Bool = true
    var contentViewLifecycle: ContentViewLifecycle = .recreateOnSwitch

    @State private var activeDropZone: DropZone?
    @State private var dropLifecycle: PaneDropLifecycle = .idle

    private var isFocused: Bool {
        controller.focusedPaneId == pane.id
    }

    private var isTabDragActive: Bool {
        controller.draggingTab != nil || controller.activeDragTab != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar
            TabBarView(
                pane: pane,
                isFocused: isFocused,
                showSplitButtons: showSplitButtons
            )

            // Content area with drop zones
            contentAreaWithDropZones
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Clear drop state when drag ends elsewhere (cancelled, dropped in another pane, etc.)
        .onChange(of: controller.draggingTab) { _, newValue in
#if DEBUG
            dlog(
                "pane.dragState pane=\(pane.id.id.uuidString.prefix(5)) " +
                "draggingTab=\(newValue != nil ? 1 : 0) " +
                "activeDragTab=\(controller.activeDragTab != nil ? 1 : 0) " +
                "dropHit=\(isTabDragActive ? 1 : 0)"
            )
#endif
            if newValue == nil {
                activeDropZone = nil
                dropLifecycle = .idle
            }
        }
        .onChange(of: activeDropZone) { oldValue, newValue in
#if DEBUG
            let oldZone = oldValue.map { String(describing: $0) } ?? "none"
            let newZone = newValue.map { String(describing: $0) } ?? "none"
            let selected = pane.selectedTab ?? pane.tabs.first
            let icon = selected?.icon ?? "nil"
            dlog(
                "pane.overlayZone pane=\(pane.id.id.uuidString.prefix(5)) " +
                "old=\(oldZone) new=\(newZone) selectedIcon=\(icon)"
            )
#endif
        }
    }

    // MARK: - Content Area with Drop Zones

    @ViewBuilder
    private var contentAreaWithDropZones: some View {
        PaneDropInteractionContainer(activeDropZone: activeDropZone) {
            contentArea
        } dropLayer: { size in
            // Drop zones layer (above content, receives drops and taps)
            dropZonesLayer(size: size)
        }
    }

    // MARK: - Content Area

    @ViewBuilder
    private var contentArea: some View {
        Group {
            if pane.tabs.isEmpty {
                emptyPaneView
            } else {
                switch contentViewLifecycle {
                case .recreateOnSwitch:
                    // Original behavior: only render selected tab
                    //
                    // `selectedTabId` can be transiently nil (or point at a tab that is being moved/closed)
                    // during rapid split/tab mutations. Rendering nothing for a single SwiftUI update causes
                    // a visible blank flash. If we have tabs, always render a stable fallback.
                    if let selectedTab = pane.selectedTab ?? pane.tabs.first {
                        contentBuilder(selectedTab, pane.id)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            // When the content is an NSViewRepresentable (e.g. WKWebView), it can
                            // sit above SwiftUI overlays and swallow drop events. During tab drags,
                            // disable hit testing for the content so our dropZonesLayer reliably
                            // receives the drag/drop interaction.
                            .allowsHitTesting(!isTabDragActive)
                            // Tab selection is often driven by `withAnimation` in the tab bar;
                            // don't crossfade the content when switching tabs.
                            .transition(.identity)
                            .transaction { tx in
                                tx.animation = nil
                            }
                    }

                case .keepAllAlive:
                    // macOS-like behavior: keep all tab views in hierarchy
                    let effectiveSelectedTabId = pane.selectedTabId ?? pane.tabs.first?.id
                    ZStack {
                        ForEach(pane.tabs) { tab in
                            contentBuilder(tab, pane.id)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .opacity(tab.id == effectiveSelectedTabId ? 1 : 0)
                                .allowsHitTesting(!isTabDragActive && tab.id == effectiveSelectedTabId)
                        }
                    }
                    // Prevent SwiftUI from animating Metal-backed views during tab moves.
                    // This avoids blank content when GhosttyKit terminals are snapshotted.
                    .transaction { tx in
                        tx.disablesAnimations = true
                    }
                }
            }
        }
        // Ensure a tab switch doesn't implicitly animate other animatable properties in this subtree.
        .animation(nil, value: pane.selectedTabId)
        // Expose the active drop zone to portal-hosted content so it can render
        // its own overlay above the AppKit surface.
        .environment(\.paneDropZone, activeDropZone)
    }

    // MARK: - Drop Zones Layer

    @ViewBuilder
    private func dropZonesLayer(size: CGSize) -> some View {
        // Keep tap-to-focus and drag-drop routing as separate layers.
        //
        // Why: SwiftUI state propagation for `isTabDragActive` can lag behind the
        // actual AppKit drag lifecycle (especially over portal-hosted terminals),
        // causing a drag to start while this view is still non-hit-testable.
        // The drop layer therefore stays always available for `.tabTransfer`.
        ZStack {
            Color.clear
                .onTapGesture {
#if DEBUG
                    dlog("pane.focus pane=\(pane.id.id.uuidString.prefix(5))")
#endif
                    controller.focusPane(pane.id)
                }
                .allowsHitTesting(!isTabDragActive)

            Color.clear
                .onDrop(of: [.tabTransfer], delegate: UnifiedPaneDropDelegate(
                    size: size,
                    pane: pane,
                    controller: controller,
                    bonsplitController: bonsplitController,
                    activeDropZone: $activeDropZone,
                    dropLifecycle: $dropLifecycle
                ))
        }
    }

    // MARK: - Empty Pane View

    @ViewBuilder
    private var emptyPaneView: some View {
        emptyPaneBuilder(pane.id)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Unified Pane Drop Delegate

struct UnifiedPaneDropDelegate: DropDelegate {
    let size: CGSize
    let pane: PaneState
    let controller: SplitViewController
    let bonsplitController: BonsplitController
    @Binding var activeDropZone: DropZone?
    @Binding var dropLifecycle: PaneDropLifecycle

    // Calculate zone based on position within the view
    private func zoneForLocation(_ location: CGPoint) -> DropZone {
        let edgeRatio: CGFloat = 0.25
        let horizontalEdge = max(80, size.width * edgeRatio)
        let verticalEdge = max(80, size.height * edgeRatio)

        // Check edges first (left/right take priority at corners)
        if location.x < horizontalEdge {
            return .left
        } else if location.x > size.width - horizontalEdge {
            return .right
        } else if location.y < verticalEdge {
            return .top
        } else if location.y > size.height - verticalEdge {
            return .bottom
        } else {
            return .center
        }
    }

    private func effectiveZone(for info: DropInfo) -> DropZone {
        let defaultZone = zoneForLocation(info.location)
        guard let draggedTab = controller.activeDragTab ?? controller.draggingTab,
              let sourcePaneId = controller.activeDragSourcePaneId ?? controller.dragSourcePaneId else {
            return defaultZone
        }
        guard let adjacentPaneMoveZone = adjacentPaneMoveZone(
            for: draggedTab,
            sourcePaneId: sourcePaneId,
            defaultZone: defaultZone
        ) else {
            return defaultZone
        }
        return adjacentPaneMoveZone
    }

    private func adjacentPaneMoveZone(
        for draggedTab: TabItem,
        sourcePaneId: PaneID,
        defaultZone: DropZone
    ) -> DropZone? {
        guard draggedTab.kind == "terminal",
              sourcePaneId != pane.id else {
            return nil
        }
        if defaultZone == .left,
           bonsplitController.adjacentPane(to: sourcePaneId, direction: .right) == pane.id {
            // Preserve the outer edge as a split affordance while treating the shared edge
            // between adjacent panes as "drop into this pane".
            return .center
        }
        if defaultZone == .right,
           bonsplitController.adjacentPane(to: sourcePaneId, direction: .left) == pane.id {
            return .center
        }
        return nil
    }

    func performDrop(info: DropInfo) -> Bool {
        if !Thread.isMainThread {
            return DispatchQueue.main.sync {
                performDrop(info: info)
            }
        }

        let zone = effectiveZone(for: info)
#if DEBUG
        dlog(
            "pane.drop pane=\(pane.id.id.uuidString.prefix(5)) zone=\(zone) " +
            "source=\(controller.dragSourcePaneId?.id.uuidString.prefix(5) ?? "nil") " +
            "hasDrag=\(controller.draggingTab != nil ? 1 : 0) " +
            "hasActive=\(controller.activeDragTab != nil ? 1 : 0)"
        )
#endif

        // Read from non-observable drag state — @Observable writes from createItemProvider
        // may not have propagated yet when performDrop runs.
        guard let draggedTab = controller.activeDragTab ?? controller.draggingTab,
              let sourcePaneId = controller.activeDragSourcePaneId ?? controller.dragSourcePaneId else {
            guard let transfer = decodeTransfer(from: info),
                  transfer.isFromCurrentProcess else {
                return false
            }
            let destination: BonsplitController.ExternalTabDropRequest.Destination
            if zone == .center {
                destination = .insert(targetPane: pane.id, targetIndex: nil)
            } else if let orientation = zone.orientation {
                destination = .split(
                    targetPane: pane.id,
                    orientation: orientation,
                    insertFirst: zone.insertsFirst
                )
            } else {
                return false
            }

            let request = BonsplitController.ExternalTabDropRequest(
                tabId: TabID(id: transfer.tab.id),
                sourcePaneId: PaneID(id: transfer.sourcePaneId),
                destination: destination
            )
            let handled = bonsplitController.onExternalTabDrop?(request) ?? false
            if handled {
                dropLifecycle = .idle
                activeDropZone = nil
            }
            return handled
        }

        // Clear both observable and non-observable drag state.
        dropLifecycle = .idle
        activeDropZone = nil
        controller.draggingTab = nil
        controller.dragSourcePaneId = nil
        controller.activeDragTab = nil
        controller.activeDragSourcePaneId = nil

        if zone == .center {
            if sourcePaneId != pane.id {
                withTransaction(Transaction(animation: nil)) {
                    _ = bonsplitController.moveTab(
                        TabID(id: draggedTab.id),
                        toPane: pane.id,
                        atIndex: nil
                    )
                }
            }
        } else if let orientation = zone.orientation {
#if DEBUG
            dlog(
                "pane.drop.splitRequest targetPane=\(pane.id.id.uuidString.prefix(5)) " +
                "sourcePane=\(sourcePaneId.id.uuidString.prefix(5)) zone=\(zone) " +
                "orientation=\(orientation) insertFirst=\(zone.insertsFirst ? 1 : 0) " +
                "draggedTab=\(draggedTab.id.uuidString.prefix(5))"
            )
#endif
            let newPaneId = bonsplitController.splitPane(
                pane.id,
                orientation: orientation,
                movingTab: TabID(id: draggedTab.id),
                insertFirst: zone.insertsFirst
            )
#if DEBUG
            dlog(
                "pane.drop.splitResult targetPane=\(pane.id.id.uuidString.prefix(5)) " +
                "newPane=\(newPaneId?.id.uuidString.prefix(5) ?? "nil")"
            )
#endif
        }

        return true
    }

    func dropEntered(info: DropInfo) {
        dropLifecycle = .hovering
        let zone = effectiveZone(for: info)
        activeDropZone = zone
#if DEBUG
        dlog(
            "pane.dropEntered pane=\(pane.id.id.uuidString.prefix(5)) zone=\(zone) " +
            "hasDrag=\(controller.draggingTab != nil ? 1 : 0) " +
            "hasActive=\(controller.activeDragTab != nil ? 1 : 0)"
        )
#endif
    }

    func dropExited(info: DropInfo) {
        dropLifecycle = .idle
        activeDropZone = nil
#if DEBUG
        dlog("pane.dropExited pane=\(pane.id.id.uuidString.prefix(5))")
#endif
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        // Guard against dropUpdated firing after performDrop/dropExited
        guard dropLifecycle == .hovering else {
#if DEBUG
            dlog("pane.dropUpdated.skip pane=\(pane.id.id.uuidString.prefix(5)) reason=lifecycle_idle")
#endif
            return DropProposal(operation: .move)
        }
        let zone = effectiveZone(for: info)
        activeDropZone = zone
#if DEBUG
        dlog("pane.dropUpdated pane=\(pane.id.id.uuidString.prefix(5)) zone=\(zone)")
#endif
        return DropProposal(operation: .move)
    }

    func validateDrop(info: DropInfo) -> Bool {
        // Reject drops on inactive workspaces whose views are kept alive in a ZStack.
        guard controller.isInteractive else {
#if DEBUG
            dlog("pane.validateDrop pane=\(pane.id.id.uuidString.prefix(5)) allowed=0 reason=inactive")
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
            "pane.validateDrop pane=\(pane.id.id.uuidString.prefix(5)) " +
            "allowed=\(hasType ? 1 : 0) hasDrag=\(hasDrag ? 1 : 0) hasActive=\(hasActive ? 1 : 0)"
        )
#endif
        return true
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
