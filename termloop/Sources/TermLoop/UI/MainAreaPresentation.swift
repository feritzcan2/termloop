// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

/// The single TermLoop-owned model for deciding which main-area route owns the
/// window and which already-mounted workspace portals may be visible.
///
/// Scope is intentionally **per window**: every snapshot carries the ContentView
/// `windowId` and is applied against that window's `TabManager`. The policy does
/// not mount or unmount workspaces; upstream `reconcileMountedWorkspaceIds` keeps
/// owning materialization. This layer only drives visibility, input activity,
/// portal priority, and cleanup/handoff intents for workspaces that already have
/// panels/portals in the current window manager.
struct MainAreaPresentationInput: Equatable {
    let windowId: UUID
    let sidebarTab: TermLoopSidebarTab
    let workSubTab: WorkSubTab
    let selectedWorkspaceId: UUID?
    let retiringWorkspaceId: UUID?
    let mountedWorkspaceIds: [UUID]
    let pendingBackgroundWorkspaceLoadIds: Set<UUID>
    let activeProjectId: UUID?
    let workspaceProjectIds: [UUID: UUID]
    let settingsIsOpen: Bool
    let markdownDocumentURL: URL?
    let gitChangesWorkspaceId: UUID?
    let abilityDetailId: String?
    let abilityDetailIsSplit: Bool
    let taskBoardInlineWorkspaceId: UUID?
    let hasCommandPaletteOrFileDropOverlay: Bool
    let handoffGeneration: UInt64

    func replacingSelectedWorkspaceId(_ selectedWorkspaceId: UUID?) -> MainAreaPresentationInput {
        MainAreaPresentationInput(
            windowId: windowId,
            sidebarTab: sidebarTab,
            workSubTab: workSubTab,
            selectedWorkspaceId: selectedWorkspaceId,
            retiringWorkspaceId: retiringWorkspaceId,
            mountedWorkspaceIds: mountedWorkspaceIds,
            pendingBackgroundWorkspaceLoadIds: pendingBackgroundWorkspaceLoadIds,
            activeProjectId: activeProjectId,
            workspaceProjectIds: workspaceProjectIds,
            settingsIsOpen: settingsIsOpen,
            markdownDocumentURL: markdownDocumentURL,
            gitChangesWorkspaceId: gitChangesWorkspaceId,
            abilityDetailId: abilityDetailId,
            abilityDetailIsSplit: abilityDetailIsSplit,
            taskBoardInlineWorkspaceId: taskBoardInlineWorkspaceId,
            hasCommandPaletteOrFileDropOverlay: hasCommandPaletteOrFileDropOverlay,
            handoffGeneration: handoffGeneration
        )
    }
}

enum MainAreaMainPageKind: Equatable {
    case content
    case agents
    case ability(id: String, split: Bool)
    case markdownDocument(URL)
    case gitChanges(UUID)
    case contextBank
    case settings
    case projectEmpty
    case taskBoard(projectId: UUID)

    var isTaskBoard: Bool {
        if case .taskBoard = self { return true }
        return false
    }

    var identity: String {
        switch self {
        case .content:
            return "content"
        case .agents:
            return "agents"
        case let .ability(id, split):
            return "ability:\(id):\(split ? "split" : "full")"
        case let .markdownDocument(url):
            return "markdownDocument:\(url.path)"
        case let .gitChanges(workspaceId):
            return "gitChanges:\(workspaceId.uuidString)"
        case .contextBank:
            return "contextBank"
        case .settings:
            return "settings"
        case .projectEmpty:
            return "projectEmpty"
        case let .taskBoard(projectId):
            return "taskBoard:\(projectId.uuidString)"
        }
    }

    /// Whether the selected workspace content is intentionally part of this
    /// route. Ability split is first-class: the route owns an overlay above the
    /// live workspace content, so the selected workspace remains visible.
    var allowsSelectedWorkspaceContent: Bool {
        switch self {
        case .content:
            return true
        case .ability(_, let split):
            return split
        case .taskBoard:
            return false
        case .agents, .markdownDocument, .gitChanges, .contextBank, .settings, .projectEmpty:
            return false
        }
    }

    /// Same-project retiring handoff is only a content-route affordance. Routes
    /// that own a page/overlay must not keep a second workspace visible behind it.
    var allowsRetiringWorkspaceHandoff: Bool {
        self == .content
    }
}

enum MainAreaHandoffPolicy: Equatable {
    case none
    case sameProjectContentHandoff(generation: UInt64)
    case immediateHideRetiring(generation: UInt64)
    case noMountedWorkspaceYet
}

struct MainAreaWorkspacePresentation: Equatable {
    let workspaceId: UUID
    let isRenderedVisible: Bool
    let isPanelVisible: Bool
    let renderOpacity: Double
    let isInputActive: Bool
    let portalPriority: Int
    let terminalPortalsVisible: Bool
    let browserPortalsVisible: Bool

    static func hidden(workspaceId: UUID, shouldPrimeInBackground: Bool) -> MainAreaWorkspacePresentation {
        MainAreaWorkspacePresentation(
            workspaceId: workspaceId,
            isRenderedVisible: false,
            isPanelVisible: false,
            renderOpacity: shouldPrimeInBackground ? 0.001 : 0,
            isInputActive: false,
            portalPriority: 0,
            terminalPortalsVisible: false,
            browserPortalsVisible: false
        )
    }
}

struct MainAreaPresentationSnapshot: Equatable {
    let windowId: UUID
    let mainPage: MainAreaMainPageKind
    let selectedWorkspaceId: UUID?
    let retiringWorkspaceId: UUID?
    let activeProjectId: UUID?
    let workspacePresentations: [UUID: MainAreaWorkspacePresentation]
    let handoffPolicy: MainAreaHandoffPolicy
    let hasCommandPaletteOrFileDropOverlay: Bool
    let generation: UInt64

    func presentation(for workspaceId: UUID) -> MainAreaWorkspacePresentation? {
        workspacePresentations[workspaceId]
    }

    var shouldReplaySuppressedPortalHides: Bool {
        !mainPage.allowsSelectedWorkspaceContent
    }
}

enum MainAreaPresentationPolicy {
    static func resolve(_ input: MainAreaPresentationInput) -> MainAreaPresentationSnapshot {
        let page = resolveMainPage(input)
        let canShowRetiring = canShowRetiringWorkspace(input, page: page)
        var workspacePresentations: [UUID: MainAreaWorkspacePresentation] = [:]

        for workspaceId in input.mountedWorkspaceIds {
            let isSelected = input.selectedWorkspaceId == workspaceId
            let isRetiring = input.retiringWorkspaceId == workspaceId
            let shouldPrime = input.pendingBackgroundWorkspaceLoadIds.contains(workspaceId)

            let shouldShowSelected = isSelected && page.allowsSelectedWorkspaceContent
            let shouldShowRetiring = isRetiring && canShowRetiring
            let shouldShowTaskBoardInlineTerminal = page.isTaskBoard
                && input.taskBoardInlineWorkspaceId == workspaceId
            let isVisible = shouldShowSelected || shouldShowRetiring
            let portalPriority = shouldShowTaskBoardInlineTerminal ? 3 : (shouldShowSelected ? 2 : (shouldShowRetiring ? 1 : 0))

            workspacePresentations[workspaceId] = MainAreaWorkspacePresentation(
                workspaceId: workspaceId,
                isRenderedVisible: isVisible,
                isPanelVisible: isVisible,
                renderOpacity: isVisible ? 1 : (shouldPrime ? 0.001 : 0),
                isInputActive: shouldShowSelected,
                portalPriority: portalPriority,
                terminalPortalsVisible: isVisible || shouldShowTaskBoardInlineTerminal,
                browserPortalsVisible: isVisible
            )
        }

        return MainAreaPresentationSnapshot(
            windowId: input.windowId,
            mainPage: page,
            selectedWorkspaceId: input.selectedWorkspaceId,
            retiringWorkspaceId: input.retiringWorkspaceId,
            activeProjectId: input.activeProjectId,
            workspacePresentations: workspacePresentations,
            handoffPolicy: resolveHandoffPolicy(input, page: page, canShowRetiring: canShowRetiring),
            hasCommandPaletteOrFileDropOverlay: input.hasCommandPaletteOrFileDropOverlay,
            generation: input.handoffGeneration
        )
    }

    static func resolveMainPage(_ input: MainAreaPresentationInput) -> MainAreaMainPageKind {
        if input.settingsIsOpen {
            return .settings
        }
        if input.sidebarTab == .agents {
            return .agents
        }
        if input.sidebarTab == .work, input.workSubTab == .contextBank {
            return .contextBank
        }
        if let url = input.markdownDocumentURL {
            return .markdownDocument(url)
        }
        if input.sidebarTab == .work,
           input.workSubTab == .agents,
           let abilityId = input.abilityDetailId {
            return .ability(id: abilityId, split: input.abilityDetailIsSplit)
        }
        if let gitWorkspaceId = input.gitChangesWorkspaceId {
            return .gitChanges(gitWorkspaceId)
        }
        if input.sidebarTab == .work,
           input.workSubTab == .tasks,
           let projectId = input.activeProjectId {
            return .taskBoard(projectId: projectId)
        }
        if shouldShowProjectEmptyState(input) {
            return .projectEmpty
        }
        return .content
    }

    static func shouldShowProjectEmptyState(_ input: MainAreaPresentationInput) -> Bool {
        guard let activeProjectId = input.activeProjectId else { return false }
        let activeProjectWorkspaceIds = input.workspaceProjectIds.compactMap { workspaceId, projectId in
            projectId == activeProjectId ? workspaceId : nil
        }
        guard !activeProjectWorkspaceIds.isEmpty else { return true }
        guard let selectedWorkspaceId = input.selectedWorkspaceId else { return true }
        return input.workspaceProjectIds[selectedWorkspaceId] != activeProjectId
    }

    static func allowsSameProjectContentHandoff(
        input: MainAreaPresentationInput,
        oldWorkspaceId: UUID,
        newWorkspaceId: UUID
    ) -> Bool {
        let page = resolveMainPage(input)
        guard page.allowsRetiringWorkspaceHandoff else { return false }
        guard !input.hasCommandPaletteOrFileDropOverlay else { return false }
        return workspaceProjectsMatch(
            oldWorkspaceId,
            newWorkspaceId,
            workspaceProjectIds: input.workspaceProjectIds
        )
    }

    private static func resolveHandoffPolicy(
        _ input: MainAreaPresentationInput,
        page: MainAreaMainPageKind,
        canShowRetiring: Bool
    ) -> MainAreaHandoffPolicy {
        guard input.retiringWorkspaceId != nil else { return .none }
        guard !input.mountedWorkspaceIds.isEmpty else { return .noMountedWorkspaceYet }
        if canShowRetiring {
            return .sameProjectContentHandoff(generation: input.handoffGeneration)
        }
        return .immediateHideRetiring(generation: input.handoffGeneration)
    }

    private static func canShowRetiringWorkspace(
        _ input: MainAreaPresentationInput,
        page: MainAreaMainPageKind
    ) -> Bool {
        guard page.allowsRetiringWorkspaceHandoff else { return false }
        guard !input.hasCommandPaletteOrFileDropOverlay else { return false }
        guard let retiringWorkspaceId = input.retiringWorkspaceId,
              let selectedWorkspaceId = input.selectedWorkspaceId,
              retiringWorkspaceId != selectedWorkspaceId else {
            return false
        }
        return workspaceProjectsMatch(
            retiringWorkspaceId,
            selectedWorkspaceId,
            workspaceProjectIds: input.workspaceProjectIds
        )
    }

    private static func workspaceProjectsMatch(
        _ lhsWorkspaceId: UUID,
        _ rhsWorkspaceId: UUID,
        workspaceProjectIds: [UUID: UUID]
    ) -> Bool {
        let lhs = workspaceProjectIds[lhsWorkspaceId]
        let rhs = workspaceProjectIds[rhsWorkspaceId]
        if lhs == nil && rhs == nil { return true }
        return lhs == rhs
    }
}

extension MainAreaMainPageKind {
    var overlayMode: AgentMainAreaOverlayMode {
        switch self {
        case .content:
            return .content
        case .agents:
            return .agents
        case let .ability(id, _):
            return .ability(id)
        case let .markdownDocument(url):
            return .markdownDocument(url)
        case let .gitChanges(workspaceId):
            return .gitChanges(workspaceId)
        case .contextBank:
            return .contextBank
        case .settings:
            return .settings
        case .projectEmpty:
            return .projectEmpty
        case let .taskBoard(projectId):
            return .taskBoard(projectId)
        }
    }
}

@MainActor
enum MainAreaNavigationEvent: Equatable {
    case workspaceActivation(UUID)
    case abilityActivation(String)
    case sidebarTopTabChanged
    case workSubTabChanged
    case projectChanged
    case workspaceDidClose(UUID)
}

extension Notification.Name {
    static let termLoopMainAreaPresentationRequiresHandoffCompletion = Notification.Name(
        "termloop.mainAreaPresentationRequiresHandoffCompletion"
    )
}

@MainActor
final class MainAreaPresentationCoordinator {
    static let shared = MainAreaPresentationCoordinator()

    private var lastSnapshotsByWindowId: [UUID: MainAreaPresentationSnapshot] = [:]
    private var suppressedPortalHideReplayTasksByWindowId: [UUID: Task<Void, Never>] = [:]

    private init() {}

    static func storedRouteSelection(
        defaults: UserDefaults = .standard
    ) -> (sidebarTab: TermLoopSidebarTab, workSubTab: WorkSubTab) {
        let sidebarTab = TermLoopSidebarTab(
            rawValue: defaults.string(forKey: TermLoopSidebarTab.storageKey)
                ?? TermLoopSidebarTab.work.rawValue
        ) ?? .work
        let workSubTab = WorkSubTab(
            rawValue: defaults.string(forKey: WorkSubTab.storageKey)
                ?? WorkSubTab.loop.rawValue
        ) ?? .loop
        return (sidebarTab, workSubTab)
    }

    func liveInput(
        windowId: UUID,
        tabManager: TabManager,
        sidebarTab: TermLoopSidebarTab,
        workSubTab: WorkSubTab,
        retiringWorkspaceId: UUID? = nil,
        mountedWorkspaceIds: [UUID]? = nil,
        handoffGeneration: UInt64 = 0,
        hasCommandPaletteOrFileDropOverlay: Bool = false
    ) -> MainAreaPresentationInput {
        let tabs = tabManager.tabs
        let workspaceProjectIds = Dictionary(uniqueKeysWithValues: tabs.compactMap { workspace -> (UUID, UUID)? in
            guard let projectId = workspace.projectId else { return nil }
            return (workspace.id, projectId)
        })
        let selectedAbilityId = AbilityDetailUIState.shared.selectedAbilityId
        let abilitySplit = selectedAbilityId.map { abilityId in
            shouldSplitAbilityDetail(
                abilityId: abilityId,
                selectedWorkspaceId: tabManager.selectedTabId
            )
        } ?? false

        return MainAreaPresentationInput(
            windowId: windowId,
            sidebarTab: sidebarTab,
            workSubTab: workSubTab,
            selectedWorkspaceId: tabManager.selectedTabId,
            retiringWorkspaceId: retiringWorkspaceId,
            mountedWorkspaceIds: mountedWorkspaceIds ?? tabs.map(\.id),
            pendingBackgroundWorkspaceLoadIds: tabManager.pendingBackgroundWorkspaceLoadIds,
            activeProjectId: ProjectStore.shared.activeProjectId,
            workspaceProjectIds: workspaceProjectIds,
            settingsIsOpen: TermLoopSettingsPageStore.shared.isOpen,
            markdownDocumentURL: MarkdownDocumentStore.shared.selectedFileURL,
            gitChangesWorkspaceId: GitChangesMainAreaStore.shared.presentation?.workspaceId,
            abilityDetailId: selectedAbilityId,
            abilityDetailIsSplit: abilitySplit,
            taskBoardInlineWorkspaceId: taskBoardInlineWorkspaceId(windowId: windowId, sidebarTab: sidebarTab, workSubTab: workSubTab),
            hasCommandPaletteOrFileDropOverlay: hasCommandPaletteOrFileDropOverlay,
            handoffGeneration: handoffGeneration
        )
    }

    private func taskBoardInlineWorkspaceId(
        windowId: UUID,
        sidebarTab: TermLoopSidebarTab,
        workSubTab: WorkSubTab
    ) -> UUID? {
        guard sidebarTab == .work, workSubTab == .tasks else { return nil }
        return TaskSelectionStoreProvider.shared.store(for: windowId).inlineTerminalWorkspaceId
    }

    func snapshot(
        windowId: UUID,
        tabManager: TabManager,
        sidebarTab: TermLoopSidebarTab,
        workSubTab: WorkSubTab,
        retiringWorkspaceId: UUID? = nil,
        mountedWorkspaceIds: [UUID]? = nil,
        handoffGeneration: UInt64 = 0,
        hasCommandPaletteOrFileDropOverlay: Bool = false
    ) -> MainAreaPresentationSnapshot {
        MainAreaPresentationPolicy.resolve(
            liveInput(
                windowId: windowId,
                tabManager: tabManager,
                sidebarTab: sidebarTab,
                workSubTab: workSubTab,
                retiringWorkspaceId: retiringWorkspaceId,
                mountedWorkspaceIds: mountedWorkspaceIds,
                handoffGeneration: handoffGeneration,
                hasCommandPaletteOrFileDropOverlay: hasCommandPaletteOrFileDropOverlay
            )
        )
    }

    func apply(
        _ snapshot: MainAreaPresentationSnapshot,
        tabManager: TabManager,
        reason: String
    ) {
        let previous = lastSnapshotsByWindowId[snapshot.windowId]
        if previous == snapshot {
            replaySuppressedPortalHideIfNeeded(snapshot, tabManager: tabManager, reason: reason)
            return
        }

        applyPortalDiff(previous: previous, next: snapshot, tabManager: tabManager, reason: reason)
        applyImmediateRetiringHideIfNeeded(snapshot, tabManager: tabManager, reason: reason)

        lastSnapshotsByWindowId[snapshot.windowId] = snapshot
        replaySuppressedPortalHideIfNeeded(snapshot, tabManager: tabManager, reason: reason)

#if DEBUG
        debugValidate(snapshot)
#endif
    }

    func applyCurrent(
        windowId: UUID,
        tabManager: TabManager,
        sidebarTab: TermLoopSidebarTab,
        workSubTab: WorkSubTab,
        reason: String
    ) {
        apply(
            snapshot(
                windowId: windowId,
                tabManager: tabManager,
                sidebarTab: sidebarTab,
                workSubTab: workSubTab
            ),
            tabManager: tabManager,
            reason: reason
        )
    }

    func handleNavigationEvent(
        _ event: MainAreaNavigationEvent,
        tabManager: TabManager? = nil
    ) {
        switch event {
        case .workspaceActivation:
            closeSettingsIfNeeded()
            MainAreaActivation.closeAllMainAreaOverlays()
        case .abilityActivation:
            closeSettingsIfNeeded()
            MarkdownDocumentStore.shared.close()
            GitChangesMainAreaStore.shared.close()
        case .sidebarTopTabChanged:
            closeSettingsIfNeeded()
            MarkdownDocumentStore.shared.close()
            GitChangesMainAreaStore.shared.close()
        case .workSubTabChanged:
            closeSettingsIfNeeded()
            MarkdownDocumentStore.shared.close()
            GitChangesMainAreaStore.shared.close()
        case .projectChanged:
            closeSettingsIfNeeded()
            MainAreaActivation.closeAllMainAreaOverlays()
        case let .workspaceDidClose(workspaceId):
            GitChangesMainAreaStore.shared.closeIfShowing(workspaceId: workspaceId)
            removeClosedWorkspace(workspaceId)
        }

        if let tabManager,
           let windowId = AppDelegate.shared?.windowId(for: tabManager) {
            let routeSelection = Self.storedRouteSelection()
            applyCurrent(
                windowId: windowId,
                tabManager: tabManager,
                sidebarTab: routeSelection.sidebarTab,
                workSubTab: routeSelection.workSubTab,
                reason: "navigation.\(event.debugName)"
            )
        }
    }

    private func applyPortalDiff(
        previous: MainAreaPresentationSnapshot?,
        next: MainAreaPresentationSnapshot,
        tabManager: TabManager,
        reason: String
    ) {
        let previousIds = previous.map { Set($0.workspacePresentations.keys) } ?? []
        let nextIds = Set(next.workspacePresentations.keys)
        let workspaceIds = previousIds.union(nextIds)
        let workspacesById = Dictionary(uniqueKeysWithValues: tabManager.tabs.map { ($0.id, $0) })

        for workspaceId in workspaceIds {
            let oldPresentation = previous?.workspacePresentations[workspaceId]
            let newPresentation = next.workspacePresentations[workspaceId]
                ?? .hidden(workspaceId: workspaceId, shouldPrimeInBackground: false)
            guard let workspace = workspacesById[workspaceId] else { continue }

            if oldPresentation?.terminalPortalsVisible != newPresentation.terminalPortalsVisible {
                workspace.termLoopSetTerminalsVisible(newPresentation.terminalPortalsVisible)
            }
            if oldPresentation?.browserPortalsVisible != newPresentation.browserPortalsVisible ||
                oldPresentation?.portalPriority != newPresentation.portalPriority {
                workspace.termLoopSetBrowserPortalsVisible(
                    newPresentation.browserPortalsVisible,
                    source: "mainArea.\(reason)",
                    zPriority: newPresentation.portalPriority
                )
            }
        }
    }

    private func applyImmediateRetiringHideIfNeeded(
        _ snapshot: MainAreaPresentationSnapshot,
        tabManager: TabManager,
        reason: String
    ) {
        guard case .immediateHideRetiring = snapshot.handoffPolicy,
              let retiringWorkspaceId = snapshot.retiringWorkspaceId else {
            return
        }
        guard let workspace = tabManager.tabs.first(where: { $0.id == retiringWorkspaceId }) else {
#if DEBUG
            dlog(
                "mainArea.policy.missingRetiringWorkspace retiring=\(retiringWorkspaceId.uuidString.prefix(5)) route=\(snapshot.mainPage.identity) reason=\(reason)"
            )
#endif
            return
        }

        // Critical ordering for BrowserPanel portals: hide while the retiring
        // workspace is still known, then let ContentView clear state/unmount.
        workspace.termLoopHideAllPortalsForMainArea(source: "mainArea.immediateRetire.\(reason)")
        NotificationCenter.default.post(
            name: .termLoopMainAreaPresentationRequiresHandoffCompletion,
            object: nil,
            userInfo: [
                "windowId": snapshot.windowId,
                "workspaceId": retiringWorkspaceId,
                "reason": "presentation_policy"
            ]
        )
    }

    private func replaySuppressedPortalHideIfNeeded(
        _ snapshot: MainAreaPresentationSnapshot,
        tabManager: TabManager,
        reason: String
    ) {
        guard snapshot.shouldReplaySuppressedPortalHides else {
            suppressedPortalHideReplayTasksByWindowId[snapshot.windowId]?.cancel()
            suppressedPortalHideReplayTasksByWindowId[snapshot.windowId] = nil
            return
        }

        // Browser/terminal portals are window-level AppKit views. During a
        // SwiftUI route swap, old portal hosts can still deliver late geometry
        // callbacks that re-bind with their previous "visible" coordinator
        // state. Hide once synchronously and replay after the current update
        // cycle so those stale callbacks cannot leave a half-visible portal
        // over Agents/Settings/Context/etc.
        forceHideSuppressedPortals(snapshot, tabManager: tabManager, reason: reason)

        suppressedPortalHideReplayTasksByWindowId[snapshot.windowId]?.cancel()
        suppressedPortalHideReplayTasksByWindowId[snapshot.windowId] = Task { @MainActor [weak tabManager] in
            await Task.yield()
            guard !Task.isCancelled,
                  let tabManager,
                  self.lastSnapshotsByWindowId[snapshot.windowId] == snapshot else {
                return
            }
            self.forceHideSuppressedPortals(snapshot, tabManager: tabManager, reason: "\(reason).replay")

            do {
                try await Task.sleep(nanoseconds: 50_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled,
                  self.lastSnapshotsByWindowId[snapshot.windowId] == snapshot else {
                return
            }
            self.forceHideSuppressedPortals(snapshot, tabManager: tabManager, reason: "\(reason).replayDelayed")
        }
    }

    private func forceHideSuppressedPortals(
        _ snapshot: MainAreaPresentationSnapshot,
        tabManager: TabManager,
        reason: String
    ) {
        let workspacesById = Dictionary(uniqueKeysWithValues: tabManager.tabs.map { ($0.id, $0) })
        for presentation in snapshot.workspacePresentations.values
            where !presentation.terminalPortalsVisible && !presentation.browserPortalsVisible {
            workspacesById[presentation.workspaceId]?.termLoopHideAllPortalsForMainArea(
                source: "mainArea.suppressed.\(reason)"
            )
        }
    }

    private func closeSettingsIfNeeded() {
        guard TermLoopSettingsPageStore.shared.isOpen else { return }
        TermLoopSettingsPageStore.shared.close()
    }

    private func removeClosedWorkspace(_ workspaceId: UUID) {
        for (windowId, snapshot) in lastSnapshotsByWindowId {
            guard snapshot.workspacePresentations[workspaceId] != nil else { continue }
            var presentations = snapshot.workspacePresentations
            presentations.removeValue(forKey: workspaceId)
            lastSnapshotsByWindowId[windowId] = MainAreaPresentationSnapshot(
                windowId: snapshot.windowId,
                mainPage: snapshot.mainPage,
                selectedWorkspaceId: snapshot.selectedWorkspaceId == workspaceId ? nil : snapshot.selectedWorkspaceId,
                retiringWorkspaceId: snapshot.retiringWorkspaceId == workspaceId ? nil : snapshot.retiringWorkspaceId,
                activeProjectId: snapshot.activeProjectId,
                workspacePresentations: presentations,
                handoffPolicy: snapshot.retiringWorkspaceId == workspaceId ? .none : snapshot.handoffPolicy,
                hasCommandPaletteOrFileDropOverlay: snapshot.hasCommandPaletteOrFileDropOverlay,
                generation: snapshot.generation
            )
        }
    }

#if DEBUG
    func resetForTesting() {
        lastSnapshotsByWindowId.removeAll()
        suppressedPortalHideReplayTasksByWindowId.values.forEach { $0.cancel() }
        suppressedPortalHideReplayTasksByWindowId.removeAll()
    }

    func snapshotForTesting(windowId: UUID) -> MainAreaPresentationSnapshot? {
        lastSnapshotsByWindowId[windowId]
    }
#endif

    private func shouldSplitAbilityDetail(abilityId: String, selectedWorkspaceId: UUID?) -> Bool {
        guard let selectedWorkspaceId,
              let session = WorkspaceMetadataStore.shared.abilitySession(forWorkspaceId: selectedWorkspaceId) else {
            return false
        }
        switch session.kind {
        case .abilityRefiner(let id), .abilityDiscussion(let id):
            return id == abilityId
        case .abilityCreator:
            return false
        }
    }

#if DEBUG
    private func debugValidate(_ snapshot: MainAreaPresentationSnapshot) {
        let visibleWorkspaceIds = snapshot.workspacePresentations.values
            .filter { $0.terminalPortalsVisible || $0.browserPortalsVisible }
            .map(\.workspaceId)
        if !snapshot.mainPage.allowsSelectedWorkspaceContent &&
            !snapshot.mainPage.isTaskBoard &&
            !visibleWorkspaceIds.isEmpty {
            dlog(
                "mainArea.policy.violation route=\(snapshot.mainPage.identity) visible=\(visibleWorkspaceIds.map { $0.uuidString.prefix(5) }.joined(separator: ","))"
            )
        }
        if case .immediateHideRetiring = snapshot.handoffPolicy,
           let retiring = snapshot.retiringWorkspaceId,
           let presentation = snapshot.workspacePresentations[retiring],
           presentation.terminalPortalsVisible || presentation.browserPortalsVisible {
            dlog(
                "mainArea.policy.violation crossProjectRetiringVisible retiring=\(retiring.uuidString.prefix(5)) route=\(snapshot.mainPage.identity)"
            )
        }
        if snapshot.mainPage != .settings && TermLoopSettingsPageStore.shared.isOpen {
            dlog("mainArea.policy.violation settingsOpen route=\(snapshot.mainPage.identity)")
        }
    }
#endif
}

private extension MainAreaNavigationEvent {
    var debugName: String {
        switch self {
        case .workspaceActivation:
            return "workspaceActivation"
        case .abilityActivation:
            return "abilityActivation"
        case .sidebarTopTabChanged:
            return "sidebarTopTabChanged"
        case .workSubTabChanged:
            return "workSubTabChanged"
        case .projectChanged:
            return "projectChanged"
        case .workspaceDidClose:
            return "workspaceDidClose"
        }
    }
}
