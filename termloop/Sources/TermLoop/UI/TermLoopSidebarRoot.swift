// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import SwiftUI

/// TermLoop-owned replacement for `VerticalTabsSidebar.body`.
///
/// The upstream `VerticalTabsSidebar` retains its public API, state, and
/// lifecycle (`@StateObject` controllers live there so SwiftUI owns their
/// retention). Its `body` is reduced to a single hook call into this Root,
/// which receives bindings/observed references for everything it needs.
///
/// Keeping the body in TermLoop land lets us redesign the sidebar freely
/// without peppering `ContentView.swift` with marker blocks. Sync-upstream
/// triage surface is limited to the thin shell + the access-widening
/// exception documented in `docs/termloop/exceptions.md`.
extension TermLoopSidebar {
    @MainActor
    struct Root: View {
        // Upstream-owned sidebar state (passed in from VerticalTabsSidebar)
        @ObservedObject var updateViewModel: UpdateViewModel
        @ObservedObject var fileExplorerState: FileExplorerState
        let onSendFeedback: () -> Void

        @EnvironmentObject var tabManager: TabManager
        @EnvironmentObject var notificationStore: TerminalNotificationStore

        @Binding var selection: SidebarSelection
        @Binding var selectedTabIds: Set<UUID>
        @Binding var lastSidebarSelectionIndex: Int?
        @Binding var draggedTabId: UUID?
        @Binding var dropIndicator: SidebarDropIndicator?
        @Binding var frozenTabItemPresentation: SidebarTabItemPresentationSnapshot?

        @ObservedObject var modifierKeyMonitor: SidebarShortcutHintModifierMonitor
        @ObservedObject var dragAutoScrollController: SidebarDragAutoScrollController
        @ObservedObject var dragFailsafeMonitor: SidebarDragFailsafeMonitor
        @ObservedObject var tabItemSettingsStore: SidebarTabItemSettingsStore
        @ObservedObject var keyboardShortcutSettingsObserver: KeyboardShortcutSettingsObserver

        let trafficLightPadding: CGFloat
        let tabRowSpacing: CGFloat
        let hiddenTitlebarControlsLeadingInset: CGFloat
        let isMinimalMode: Bool

        // TermLoop-owned observed stores. Project/folder selection used to
        // live as hook-added properties on VerticalTabsSidebar; owning them
        // here removes those hooks from upstream.
        @ObservedObject private var projectStore = ProjectStore.shared

        @AppStorage(TermLoopSidebarTab.storageKey) private var tabRawValue: String = TermLoopSidebarTab.work.rawValue
        @AppStorage("termloop.workLastWorkspaceId") private var workLastWorkspaceId: String = ""
        @AppStorage(WorkSubTab.storageKey) private var workSubTabRaw: String = WorkSubTab.loop.rawValue
        @AppStorage(WorktreeAgentsPanelState.hiddenKey) private var isWorktreeAgentsHidden: Bool = false
        @AppStorage(ActiveAgentsPanelState.hiddenKey) private var isActiveAgentsHidden: Bool = false
        @State private var askAgentRequest: AskAgentRequest? = nil
        @State private var planPickerRequest: PlanPickerRequest? = nil
        @State private var bridgeKickoffRequest: BridgeKickoffRequest? = nil

        // Narrow subscription: @ObservedObject on the metadata store would
        // rebuild the sidebar on every Claude telemetry event.
        @State private var agentSessionTick: Int = 0
        @State private var projectScopeTick: Int = 0

        private var selectedTab: TermLoopSidebarTab {
            TermLoopSidebarTab(rawValue: tabRawValue) ?? .work
        }

        private var workSubTab: Binding<WorkSubTab> {
            Binding(
                get: { WorkSubTab(rawValue: workSubTabRaw) ?? .loop },
                set: { workSubTabRaw = $0.rawValue }
            )
        }

        private var showsNoProjectEmptyState: Bool {
            projectStore.projects.isEmpty
        }

        private func handleSidebarTabChange(_ newTab: TermLoopSidebarTab) {
            if let currentId = tabManager.selectedTabId,
               tabManager.tabs.contains(where: { $0.id == currentId }) {
                workLastWorkspaceId = currentId.uuidString
            }
            switch newTab {
            case .work:
                if let wid = UUID(uuidString: workLastWorkspaceId),
                   tabManager.tabs.contains(where: { $0.id == wid }) {
                    tabManager.selectedTabId = wid
                } else if let firstWorkspace = tabManager.tabs.first {
                    tabManager.selectedTabId = firstWorkspace.id
                }
            case .agents:
                break
            case .integrations:
                break
            case .plan:
                break
            case .tasks:
                break
            }
        }

        private var activeProjectFolderURL: URL? {
            guard let id = projectStore.activeProjectId,
                  let project = projectStore.project(id: id) else { return nil }
            return URL(fileURLWithPath: project.folderPath, isDirectory: true)
        }

        private func selectFirstWorkspaceForActiveProjectIfNeeded() {
            guard let activeId = projectStore.activeProjectId else { return }
            let tabs = tabManager.tabs
            if let current = tabManager.selectedTabId,
               let tab = tabs.first(where: { $0.id == current }),
               tab.projectId == activeId {
                return
            }
            if let first = tabs.first(where: { $0.projectId == activeId }) {
                tabManager.selectedTabId = first.id
            }
        }

        private func debugShortSidebarTabId(_ id: UUID?) -> String {
            guard let id else { return "nil" }
            return String(id.uuidString.prefix(5))
        }

        var body: some View {
            VStack(spacing: 0) {
                Color.clear.frame(height: trafficLightPadding)
                TermLoopSidebarTabBar(selection: Binding(
                    get: { selectedTab },
                    set: { tabRawValue = $0.rawValue }
                ))
                switch selectedTab {
                case .work:
                    workBody
                case .agents:
                    AgentsSidebarView()
                case .integrations:
                    IntegrationsTab(projectRoot: activeProjectFolderURL)
                case .plan:
                    PlanTab(projectRoot: activeProjectFolderURL)
                case .tasks:
                    TaskSidebarRoot(projectId: projectStore.activeProjectId)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityIdentifier("Sidebar")
            .ignoresSafeArea()
            .background(SidebarBackdrop().ignoresSafeArea())
            .overlay(alignment: .trailing) { SidebarTrailingBorder() }
            .overlay(alignment: .top) {
                WindowDragHandleView()
                    .frame(height: trafficLightPadding)
                    .background(TitlebarDoubleClickMonitorView())
            }
            .overlay(alignment: .topLeading) {
                if isMinimalMode {
                    HiddenTitlebarSidebarControlsView(notificationStore: notificationStore)
                        .padding(.leading, hiddenTitlebarControlsLeadingInset)
                        .padding(.top, 2)
                }
            }
            .overlay(alignment: .topLeading) {
                AskToPopoverAnchor(
                    request: $askAgentRequest,
                    tabManager: tabManager
                )
            }
            .onChange(of: selectedTab) { newTab in
                handleSidebarTabChange(newTab)
            }
            .onReceive(NotificationCenter.default.publisher(for: .termLoopOpenAskTo)) { note in
                askAgentRequest = AskAgentRequest.from(notification: note)
            }
            .onReceive(WorkspaceMetadataStore.shared.$agentSessionVersion) { newValue in
                agentSessionTick = newValue
            }
            .onReceive(WorkspaceMetadataStore.shared.$projectScopeVersion) { newValue in
                projectScopeTick = newValue
            }
            .onReceive(NotificationCenter.default.publisher(for: .termLoopOpenPlanPicker)) { note in
                planPickerRequest = PlanPickerRequest.from(notification: note)
            }
            .onReceive(NotificationCenter.default.publisher(for: .termLoopOpenBridgeKickoff)) { note in
                bridgeKickoffRequest = BridgeKickoffRequest.from(notification: note)
            }
            .sheet(item: $planPickerRequest) { req in
                PlanPickerSheet(
                    request: req,
                    projectRoot: activeProjectFolderURL,
                    tabManager: tabManager
                )
            }
            .sheet(item: $bridgeKickoffRequest) { req in
                BridgeKickoffSheet(request: req, tabManager: tabManager)
            }
            // MARK: termloop-hook
            .onAppear { TermLoopHooks.bootstrapSidebar(tabManager: tabManager) }
            // MARK: /termloop-hook
        }

        @ViewBuilder
        private var workBody: some View {
            // Read the tick so the filter re-runs on role changes.
            let _ = agentSessionTick
            let _ = projectScopeTick
            let projectFiltered = TermLoopSidebar.projectFilteredTabs(allTabs: tabManager.tabs)
            let tabs: [Workspace] = projectFiltered.filter {
                !WorkspaceMetadataStore.shared.isAbilityAgent(workspaceId: $0.id)
            }

            VStack(spacing: 0) {
                TermLoopSidebar.Header()
                if showsNoProjectEmptyState {
                    SidebarProjectOnboardingEmptyState()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    WorkSubTabBar(selection: workSubTab)
                    Group {
                        switch workSubTab.wrappedValue {
                        case .loop:
                            GeometryReader { proxy in
                                ScrollView {
                                    VStack(spacing: 0) {
                                        Spacer(minLength: 0)
                                        SidebarTutorialStack()
                                        if !isWorktreeAgentsHidden {
                                            WorktreeAgentsPanel(showsEmptySections: true)
                                        }
                                        if !isActiveAgentsHidden {
                                            ActiveAgentsPanel()
                                        }
                                    }
                                    .frame(minHeight: proxy.size.height, alignment: .bottom)
                                }
                                .overlay(alignment: .top) {
                                    SidebarTopScrim(height: 20)
                                        .allowsHitTesting(false)
                                }
                                .background(Color.clear)
                                .modifier(ClearScrollBackground())
                                .modifier(SidebarSubtleScrollIndicators())
                            }
                        case .contextBank:
                            ContextBankView(projectRoot: activeProjectFolderURL)
                        case .agents:
                            ScrollView {
                                VStack(spacing: 0) {
                                    AbilitiesPanel()
                                }
                                .frame(maxWidth: .infinity, alignment: .topLeading)
                            }
                            .modifier(ClearScrollBackground())
                            .modifier(SidebarSubtleScrollIndicators())
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    if workSubTab.wrappedValue != .loop {
                        TicketWorktreesPanel()
                    }
                }
                TermLoopSidebar.Footer(
                    updateViewModel: updateViewModel,
                    fileExplorerState: fileExplorerState,
                    onSendFeedback: onSendFeedback,
                    selectedWorkspaceId: tabManager.selectedTabId
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(
                WindowAccessor { window in
                    modifierKeyMonitor.setHostWindow(window)
                }
                .frame(width: 0, height: 0)
            )
            .onAppear {
                modifierKeyMonitor.start()
                draggedTabId = nil
                dropIndicator = nil
                SidebarDragLifecycleNotification.postStateDidChange(
                    tabId: nil,
                    reason: "sidebar_appear"
                )
            }
            .onDisappear {
                modifierKeyMonitor.stop()
                dragAutoScrollController.stop()
                dragFailsafeMonitor.stop()
                draggedTabId = nil
                dropIndicator = nil
                SidebarDragLifecycleNotification.postStateDidChange(
                    tabId: nil,
                    reason: "sidebar_disappear"
                )
            }
            .onChange(of: projectStore.activeProjectId) { _ in
                TermLoopSidebar.handleActiveProjectDidChange()
                selectFirstWorkspaceForActiveProjectIfNeeded()
            }
            .onChange(of: draggedTabId) { newDraggedTabId in
                SidebarDragLifecycleNotification.postStateDidChange(
                    tabId: newDraggedTabId,
                    reason: "drag_state_change"
                )
#if DEBUG
                dlog("sidebar.dragState.sidebar tab=\(debugShortSidebarTabId(newDraggedTabId))")
#endif
                if newDraggedTabId != nil {
                    dragFailsafeMonitor.start {
                        SidebarDragLifecycleNotification.postClearRequest(reason: $0)
                    }
                    return
                }
                dragFailsafeMonitor.stop()
                dragAutoScrollController.stop()
                dropIndicator = nil
            }
            .onChange(of: tabs.map(\.id)) { tabIds in
                let liveIds = Set(tabIds)
                if let draggedTabId, !liveIds.contains(draggedTabId) {
                    self.draggedTabId = nil
                }
                if !selectedTabIds.isSubset(of: liveIds) {
                    selectedTabIds = selectedTabIds.intersection(liveIds)
                }
                if let indicator = dropIndicator,
                   let indicatorTabId = indicator.tabId,
                   !liveIds.contains(indicatorTabId) {
                    dropIndicator = nil
                }
                guard let frozen = frozenTabItemPresentation,
                      !tabIds.contains(frozen.tabId) else { return }
                frozenTabItemPresentation = nil
            }
            .onReceive(NotificationCenter.default.publisher(for: SidebarDragLifecycleNotification.requestClear)) { notification in
                guard draggedTabId != nil else { return }
                let reason = SidebarDragLifecycleNotification.reason(from: notification)
#if DEBUG
                dlog("sidebar.dragClear tab=\(debugShortSidebarTabId(draggedTabId)) reason=\(reason)")
#endif
                draggedTabId = nil
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

private struct SidebarProjectOnboardingEmptyState: View {
    @State private var isHoveringOpenButton = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 28)

            VStack(alignment: .leading, spacing: 14) {
                Text(TermLoopSidebarTheme.caps(String(
                    localized: "project.empty.hero.title",
                    defaultValue: "Open your first project",
                    table: "TermLoop"
                )))
                .font(TermLoopSidebarTheme.headerLabel)
                .foregroundStyle(Color.primary)

                Button {
                    openProjectFromFolder()
                } label: {
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(TermLoopSidebarTheme.caps(String(
                                localized: "project.empty.hero.button",
                                defaultValue: "Open Project",
                                table: "TermLoop"
                            )))
                            .font(TermLoopSidebarTheme.headerLabel)
                            .foregroundStyle(Color.primary)

                            Text(String(
                                localized: "project.empty.hero.button.subtitle",
                                defaultValue: "Pick a folder on disk to open as a project",
                                table: "TermLoop"
                            ))
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                        }

                        Spacer(minLength: 8)

                        Image(systemName: "folder.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(TermLoopSidebarTheme.accent)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 14)
                    .background(
                        Rectangle()
                            .fill(
                                isHoveringOpenButton
                                    ? TermLoopSidebarTheme.activeBg
                                    : TermLoopSidebarTheme.hoverBg
                            )
                    )
                    .overlay(
                        Rectangle()
                            .stroke(
                                isHoveringOpenButton
                                    ? TermLoopSidebarTheme.accent.opacity(0.30)
                                    : TermLoopSidebarTheme.ruleStrong,
                                lineWidth: 1
                            )
                    )
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
                .onHover { isHoveringOpenButton = $0 }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(
                Rectangle()
                    .stroke(TermLoopSidebarTheme.ruleStrong, lineWidth: 1)
            )
            .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.bottom, 18)
    }

    private func openProjectFromFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = String(
            localized: "project.empty.hero.openPanel.prompt",
            defaultValue: "Open",
            table: "TermLoop"
        )
        panel.message = String(
            localized: "project.empty.hero.openPanel.message",
            defaultValue: "Pick a folder to open as a TermLoop project.",
            table: "TermLoop"
        )
        let defaults = UserDefaults.standard
        let lastParent = defaults.string(forKey: ProjectStore.lastParentDirectoryDefaultsKey) ?? ""
        let initialDir = lastParent.isEmpty ? ProjectStore.defaultParentDirectory() : lastParent
        panel.directoryURL = URL(fileURLWithPath: (initialDir as NSString).expandingTildeInPath)
        guard panel.runModal() == .OK, let url = panel.url else { return }

        let store = ProjectStore.shared
        let name = store.uniqueProjectName(from: url.lastPathComponent)
        do {
            _ = try store.create(name: name, folderPath: url.path)
            let parent = url.deletingLastPathComponent().path
            if !parent.isEmpty, parent != "/" {
                defaults.set(parent, forKey: ProjectStore.lastParentDirectoryDefaultsKey)
            }
        } catch {
            ProjectStore.presentError(error)
        }
    }
}

private struct SidebarTutorialStack: View {
    var body: some View {
        VStack(spacing: 8) {
            SidebarAgentHooksWarning()
            SidebarRepoStatusBanner()

            SidebarTutorialBanner(
                id: "worktree-how-it-works",
                iconSystemName: "questionmark.circle",
                title: String(
                    localized: "worktreeHowItWorks.button.title",
                    defaultValue: "How to work with worktrees",
                    table: "TermLoop"
                ),
                subtitle: String(
                    localized: "worktreeHowItWorks.button.subtitle",
                    defaultValue: "See the parallel worktree + agent flow.",
                    table: "TermLoop"
                ),
                tapAction: .popover(
                    help: String(
                        localized: "worktreeHowItWorks.button.help",
                        defaultValue: "Show the worktree workflow guide",
                        table: "TermLoop"
                    ),
                    content: { AnyView(WorktreeHowItWorksPopover()) }
                )
            )

            SidebarTutorialBanner(
                id: "quick-action-shift-shift",
                iconSystemName: "shift.fill",
                title: String(
                    localized: "quickActionTutorial.button.title",
                    defaultValue: "Just Shift+Shift!",
                    table: "TermLoop"
                ),
                subtitle: String(
                    localized: "quickActionTutorial.button.subtitle",
                    defaultValue: "Double-tap Shift to open Quick Action.",
                    table: "TermLoop"
                ),
                tapAction: .perform(
                    help: String(
                        localized: "quickActionTutorial.button.help",
                        defaultValue: "Open Quick Action now",
                        table: "TermLoop"
                    ),
                    action: { QuickActionController.shared.present() }
                ),
                trailingAction: SidebarTutorialBanner.TrailingAction(
                    title: String(
                        localized: "quickActionTutorial.button.try",
                        defaultValue: "Try",
                        table: "TermLoop"
                    ),
                    help: String(
                        localized: "quickActionTutorial.button.try.help",
                        defaultValue: "Open Quick Action now",
                        table: "TermLoop"
                    ),
                    action: { QuickActionController.shared.present() }
                )
            )
        }
        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }
}

private struct SidebarTutorialBanner: View {
    struct TrailingAction {
        let title: String
        let help: String
        let action: () -> Void
    }

    enum TapAction {
        case none
        case perform(help: String, action: () -> Void)
        case popover(help: String, content: () -> AnyView)

        var help: String? {
            switch self {
            case .none:
                return nil
            case .perform(let help, _):
                return help
            case .popover(let help, _):
                return help
            }
        }
    }

    let id: String
    let iconSystemName: String
    let title: String
    let subtitle: String?
    let tapAction: TapAction
    var trailingAction: TrailingAction? = nil

    @ObservedObject private var sessionState = SidebarTutorialSessionState.shared
    @State private var showsPopover = false

    private var isVisible: Bool {
        !sessionState.isDismissed(id: id)
    }

    var body: some View {
        if isVisible {
            HStack(spacing: 8) {
                mainButton

                if let trailingAction {
                    Button(trailingAction.title) {
                        trailingAction.action()
                    }
                    .buttonStyle(.plain)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.accent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(
                        Capsule(style: .continuous)
                            .fill(TermLoopSidebarTheme.accent.opacity(0.10))
                    )
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(TermLoopSidebarTheme.accent.opacity(0.18), lineWidth: 1)
                    )
                    .help(trailingAction.help)
                }

                Button {
                    showsPopover = false
                    sessionState.dismiss(id: id)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(String(
                    localized: "sidebarTutorial.dismiss.help",
                    defaultValue: "Hide until app relaunch",
                    table: "TermLoop"
                ))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(TermLoopSidebarTheme.activeBg.opacity(0.7))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(TermLoopSidebarTheme.accent.opacity(0.18), lineWidth: 1)
            )
            .popover(isPresented: $showsPopover, arrowEdge: .top) {
                if case .popover(_, let content) = tapAction {
                    content()
                }
            }
        }
    }

    private var mainButton: some View {
        Button(action: handleTap) {
            HStack(spacing: 8) {
                Image(systemName: iconSystemName)
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 14)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(TermLoopSidebarTheme.bodyMonoStrong)
                        .lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dimmer)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .foregroundStyle(Color.primary)
        }
        .buttonStyle(.plain)
        .disabled({
            if case .none = tapAction { return true }
            return false
        }())
        .help(tapAction.help ?? "")
    }

    private func handleTap() {
        switch tapAction {
        case .none:
            break
        case .perform(_, let action):
            action()
        case .popover:
            showsPopover = true
        }
    }
}

private struct WorktreeHowItWorksPopover: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(String(
                localized: "worktreeHowItWorks.popover.title",
                defaultValue: "How to work with worktrees",
                table: "TermLoop"
            ))
            .font(TermLoopSidebarTheme.bodyMonoStrong)
            .foregroundStyle(Color.primary)

            ScrollView([.horizontal, .vertical]) {
                Image("WorktreeHowItWorks")
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 960, alignment: .topLeading)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .padding(1)
        }
        .padding(14)
        .frame(minWidth: 840, idealWidth: 1000, maxWidth: 1120, minHeight: 440, idealHeight: 620, maxHeight: 760)
    }
}

@MainActor
final class SidebarTutorialSessionState: ObservableObject {
    static let shared = SidebarTutorialSessionState()

    @Published private var dismissedIds: Set<String> = []

    func isDismissed(id: String) -> Bool {
        dismissedIds.contains(id)
    }

    func dismiss(id: String) {
        dismissedIds.insert(id)
    }
}

private struct SidebarSubtleScrollIndicators: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(SidebarSubtleScrollIndicatorConfigurator())
    }
}

private struct SidebarSubtleScrollIndicatorConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        NSView(frame: .zero)
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            guard let scrollView = findScrollView(startingAt: nsView) else { return }
            configure(scrollView)
        }
    }

    private func findScrollView(startingAt view: NSView) -> NSScrollView? {
        var current: NSView? = view
        while let candidate = current {
            if let scrollView = candidate as? NSScrollView {
                return scrollView
            }
            current = candidate.superview
        }
        return nil
    }

    private func configure(_ scrollView: NSScrollView) {
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay

        if !(scrollView.verticalScroller is SidebarThinOverlayScroller) {
            let scroller = SidebarThinOverlayScroller()
            scroller.controlSize = .small
            scroller.scrollerStyle = .overlay
            scrollView.verticalScroller = scroller
        }

        scrollView.verticalScroller?.alphaValue = 1
        scrollView.verticalScroller?.knobStyle = .default
    }
}

private final class SidebarThinOverlayScroller: NSScroller {
    private static let trackWidth: CGFloat = 7
    private static let knobWidth: CGFloat = 3.5

    override class var isCompatibleWithOverlayScrollers: Bool {
        true
    }

    override class func scrollerWidth(
        for controlSize: NSControl.ControlSize,
        scrollerStyle: NSScroller.Style
    ) -> CGFloat {
        trackWidth
    }

    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {
        // Keep the sidebar quiet: no visible track, only a slim thumb.
    }

    override func drawKnob() {
        let knobRect = rect(for: .knob)
        guard knobRect.width > 0, knobRect.height > 0 else { return }

        let resolvedWidth = min(Self.knobWidth, max(2, bounds.width - 2))
        let x = bounds.midX - resolvedWidth / 2
        let rect = NSRect(
            x: x,
            y: knobRect.minY + 1,
            width: resolvedWidth,
            height: max(8, knobRect.height - 2)
        )

        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let alpha: CGFloat = isHighlighted ? 0.34 : 0.20
        let color = isDark
            ? NSColor.white.withAlphaComponent(alpha)
            : NSColor.black.withAlphaComponent(alpha * 0.85)

        color.setFill()
        NSBezierPath(roundedRect: rect, xRadius: resolvedWidth / 2, yRadius: resolvedWidth / 2).fill()
    }
}
