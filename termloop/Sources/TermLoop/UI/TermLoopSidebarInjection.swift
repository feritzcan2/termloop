// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

private extension Sequence where Element == Workspace {
    func contains(tabId: UUID?) -> Bool {
        guard let id = tabId else { return false }
        return contains(where: { $0.id == id })
    }
}


/// Keeps hover-only sidebar actions mounted in a fixed slot so the trailing
/// controls do not jump away from the pointer while hover state updates.
struct SidebarActionSlot<Content: View>: View {
    let isVisible: Bool
    let width: CGFloat
    let height: CGFloat
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .frame(width: width, height: height)
            .opacity(isVisible ? 1 : 0)
            .allowsHitTesting(isVisible)
            .accessibilityHidden(!isVisible)
    }
}

/// Sidebar injection views owned by TermLoop. `ContentView.swift` references
/// these via marker-wrapped one-liners so upstream's sidebar body stays
/// visually close to `upstream/main`. Each sub-view encapsulates one
/// TermLoop-owned region.
@MainActor
enum TermLoopSidebar {
    private struct ProjectScopedTabsCache {
        var tabIds: [UUID] = []
        var activeProjectId: UUID?
        var projectScopeVersion: Int = -1
        var result: [Workspace] = []
    }

    private struct ProjectFilteredTabsCache {
        var tabIds: [UUID] = []
        var activeProjectId: UUID?
        var projectScopeVersion: Int = -1
        var agentSessionVersion: Int = -1
        var result: [Workspace] = []
    }

    private static var projectScopedTabsCache = ProjectScopedTabsCache()
    private static var projectFilteredTabsCache = ProjectFilteredTabsCache()

    /// Top-of-sidebar region: brutalist project header with an inline DEV tag
    /// in debug builds. The project switcher menu (create / rename / delete /
    /// pick another project) is reached by clicking anywhere on the row. An
    /// optional folder-path subtitle sits on the row below to reinforce which
    /// workspace root you're looking at.
    struct Header: View {
        var body: some View {
            VStack(spacing: 0) {
                ProjectSwitcherStrip()
                TermLoopSidebarRule()
            }
        }
    }

    /// Compact skills/commands + TCP status group — kept as a single entry
    /// point for the footer so the TermLoop-owned footer view can compose it
    /// alongside the help and update pills without knowing the details.
    struct FooterButton: View {
        var body: some View {
            HStack(spacing: 6) {
                SidebarSkillsCommandsButton()
                MobilePairingButton()
                CLISocketStatusChip()
            }
        }
    }

    /// Small capsule shown next to the workspace title when the workspace is
    /// attached to a git branch (i.e. has a worktree). Injected from the
    /// sidebar row via a single-line marker-wrapped hook.
    ///
    /// Shows a secondary orange dot when at least one terminal panel in the
    /// workspace is inside the project folder but not at the worktree path
    /// (shell drifted, or attach-time `cd` missed a busy shell). Hover
    /// tooltip lists the drifted paths so the user can decide whether to
    /// sync or respawn them via `WorktreeMenuItems`.
    struct WorktreeBadge: View {
        @ObservedObject private var metadata = WorkspaceMetadataStore.shared
        @ObservedObject private var changesExpansion = SidebarGitChangesExpansion.shared
        let workspace: Workspace

        var body: some View {
            HStack(spacing: 4) {
                if let branch = metadata.branch(for: workspace) {
                    branchPill(branch: branch)
                }
                if let changes = workspace.aggregatedGitChanges(),
                   changes.count > 0 {
                    Button {
                        GitChangesMainAreaStore.shared.show(
                            WorktreeChangesPresentation(workspace: workspace)
                        )
                    } label: {
                        TermLoopSidebarToken(
                            label: changeCountLabel(changes.count),
                            iconSystemName: "square.and.pencil",
                            tone: .warning,
                            emphasized: true
                        )
                    }
                    .buttonStyle(.plain)
                    .help(gitChangesTooltip(for: changes))
                    SidebarGitChangesChevron(
                        isExpanded: changesExpansion.isExpanded(workspace.id),
                        action: { changesExpansion.toggle(workspace.id) }
                    )
                }
                permissionModePill
            }
        }

        @ViewBuilder
        private func branchPill(branch: String) -> some View {
            let divergent = workspace.divergentPanelPaths
            HStack(spacing: 4) {
                TermLoopSidebarToken(
                    label: branch,
                    iconSystemName: "arrow.triangle.branch",
                    tone: .accent
                )
                if !divergent.isEmpty {
                    TermLoopSidebarToken(
                        label: "DRIFT \(divergent.count)",
                        iconSystemName: "exclamationmark.triangle.fill",
                        tone: .warning,
                        emphasized: true
                    )
                }
            }
            .help(tooltip(branch: branch, divergent: divergent))
        }

        @ViewBuilder
        private var permissionModePill: some View {
            let md = metadata.metadata(forWorkspaceId: workspace.id)
            if let agentId = md.terminalAgentId,
               let option = PermissionModeCatalog.option(
                   forAgentId: agentId,
                   modeRawValue: md.permissionMode
               ) {
                TermLoopSidebarToken(
                    label: option.title.lowercased(),
                    tone: .neutral
                )
                    .help(option.description + "\n" + option.flagPreview)
            }
        }

        private func resolvedPath(branch: String) -> String? {
            WorkspaceMetadataStore.shared.worktreePath(for: workspace)
                ?? workspace.termLoopPresentationCwd()
        }

        private func tooltip(
            branch: String,
            divergent: [(panelId: UUID, path: String)]
        ) -> String {
            let base = resolvedPath(branch: branch) ?? branch
            guard !divergent.isEmpty else { return base }
            let shown = divergent.prefix(4)
                .map { "  • \($0.path)" }
                .joined(separator: "\n")
            let tail = divergent.count > 4
                ? "\n  (+\(divergent.count - 4) more)"
                : ""
            return "\(base)\n\n\(divergent.count) panel(s) outside worktree:\n\(shown)\(tail)"
        }

        private func changeCountLabel(_ count: Int) -> String {
            count == 1 ? "1 change" : "\(count) changes"
        }

        private func gitChangesTooltip(for changes: SidebarGitChangesState) -> String {
            let shown = changes.files.prefix(6).map { file in
                "  • \(file.status.sidebarSymbol) \(file.path)"
            }
            let tailCount = changes.files.count - shown.count
            let tail = tailCount > 0 ? "\n  (+\(tailCount) more)" : ""
            return "\(changeCountLabel(changes.count))\n\n\(shown.joined(separator: "\n"))\(tail)"
        }
    }

    /// Workspace-row context menu entries for attaching/detaching a git
    /// worktree. Uses NSAlert for the input dialogs so we don't need a
    /// separate SwiftUI sheet presenter. When multiple workspaces are
    /// selected, acts on each in turn — detach policy applied per-workspace.
    struct WorktreeMenuItems: View {
        let targetIds: [UUID]
        let tabManager: TabManager

        // Intentionally NOT an @ObservedObject on WorkspaceMetadataStore.shared:
        // that store also publishes on ephemeralClaudeSessions churn (fires on
        // every report_claude_session socket event during an active turn),
        // which would rebuild this view inside the open NSMenu and make macOS
        // dismiss any open submenu. Branch state only changes via attach/
        // detach which close the menu anyway, so a snapshot read at open time
        // is enough.
        private var workspaces: [Workspace] {
            targetIds.compactMap { id in tabManager.tabs.first(where: { $0.id == id }) }
        }

        private var anyAttached: Bool {
            workspaces.contains { WorkspaceMetadataStore.shared.branch(for: $0) != nil }
        }

        /// Total count of panels across every targeted workspace whose cwd
        /// sits under the project folder but not at the worktree path.
        /// Drives the visibility of the "sync" and "reopen" remediation
        /// items — hidden when nothing is drifted.
        private var divergentPanelTotal: Int {
            workspaces.reduce(0) { $0 + $1.divergentPanelPaths.count }
        }

        var body: some View {
            Button(anyAttached
                   ? String(localized: "worktree.menu.switch",
                            defaultValue: "Switch branch…", table: "TermLoop")
                   : String(localized: "worktree.menu.attach",
                            defaultValue: "Attach to branch…", table: "TermLoop")) {
                handleAttach()
            }
            if anyAttached {
                Button(String(localized: "worktree.menu.detach",
                              defaultValue: "Detach from branch", table: "TermLoop")) {
                    handleDetach()
                }
                Button(String(localized: "worktree.menu.reveal",
                              defaultValue: "Reveal worktree in Finder",
                              table: "TermLoop")) {
                    handleReveal()
                }
                let drifted = divergentPanelTotal
                if drifted > 0 {
                    Divider()
                    Button(String(
                        localized: "worktree.menu.syncPanels",
                        defaultValue: "Sync \(drifted) drifted panel(s) (cd if idle)",
                        table: "TermLoop"
                    )) {
                        handleSyncPanels()
                    }
                    Button(String(
                        localized: "worktree.menu.respawnPanels",
                        defaultValue: "Reopen \(drifted) drifted panel(s) in worktree",
                        table: "TermLoop"
                    )) {
                        handleRespawnPanels()
                    }
                }
            }
        }

        private func handleAttach() {
            guard let workspace = workspaces.first else {
                presentError("No workspace selected")
                return
            }

            if !anyAttached, workspaces.count == 1 {
                QuickActionController.shared.present(
                    initialSurface: .worktree,
                    targetWorkspaceId: workspace.id,
                    worktreeIntent: .migrateConversationIfPossible
                )
                return
            }

            let alert = NSAlert()
            alert.messageText = String(localized: "worktree.alert.attachTitle",
                                       defaultValue: "Attach to branch",
                                       table: "TermLoop")
            alert.informativeText = String(localized: "worktree.alert.attachBody",
                                           defaultValue: "New tabs in this session will open in the worktree for this branch. Enter a branch name (existing or new).",
                                           table: "TermLoop")
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
            field.placeholderString = "feat/my-thing"
            alert.accessoryView = field
            alert.addButton(withTitle: String(
                localized: "worktree.alert.attachConfirm",
                defaultValue: "Attach", table: "TermLoop"
            ))
            alert.addButton(withTitle: String(
                localized: "common.cancel",
                defaultValue: "Cancel", table: "TermLoop"
            ))

            DispatchQueue.main.async { field.becomeFirstResponder() }
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            let branch = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !branch.isEmpty else { return }

            for ws in workspaces {
                do {
                    _ = try WorktreeCoordinator.shared.attach(workspace: ws, branch: branch)
                } catch WorktreeError.agentMidTurn {
                    guard confirmForceMigrate(branch: branch) else { return }
                    do {
                        _ = try WorktreeCoordinator.shared.attach(
                            workspace: ws, branch: branch, force: true
                        )
                    } catch {
                        presentError((error as? LocalizedError)?.errorDescription ?? "\(error)")
                        return
                    }
                } catch {
                    presentError((error as? LocalizedError)?.errorDescription ?? "\(error)")
                    return
                }
            }
        }

        private func confirmForceMigrate(branch: String) -> Bool {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = String(localized: "worktree.alert.midTurnTitle",
                                       defaultValue: "Claude is mid-turn",
                                       table: "TermLoop")
            alert.informativeText = String(
                localized: "worktree.alert.midTurnBody",
                defaultValue: "A Claude session is executing a turn in this session. Force-migrating to \(branch) will terminate the turn and re-open Claude with --resume at the worktree path.",
                table: "TermLoop"
            )
            alert.addButton(withTitle: String(localized: "worktree.alert.forceMigrate",
                                              defaultValue: "Force migrate",
                                              table: "TermLoop"))
            alert.addButton(withTitle: String(localized: "common.cancel",
                                              defaultValue: "Cancel",
                                              table: "TermLoop"))
            return alert.runModal() == .alertFirstButtonReturn
        }

        private func handleDetach() {
            let confirm = NSAlert()
            confirm.messageText = String(localized: "worktree.alert.detachTitle",
                                         defaultValue: "Detach from branch",
                                         table: "TermLoop")
            confirm.informativeText = String(localized: "worktree.alert.detachBody",
                                             defaultValue: "Choose how to handle the worktree.",
                                             table: "TermLoop")
            confirm.addButton(withTitle: String(localized: "worktree.alert.detachAuto",
                                                defaultValue: "Auto (remove if clean)",
                                                table: "TermLoop"))
            confirm.addButton(withTitle: String(localized: "worktree.alert.detachKeep",
                                                defaultValue: "Keep worktree",
                                                table: "TermLoop"))
            confirm.addButton(withTitle: String(localized: "common.cancel",
                                                defaultValue: "Cancel", table: "TermLoop"))

            let response = confirm.runModal()
            let policy: WorktreeCoordinator.PrunePolicy
            switch response {
            case .alertFirstButtonReturn:  policy = .auto
            case .alertSecondButtonReturn: policy = .keep
            default: return
            }

            for ws in workspaces {
                do {
                    _ = try WorktreeCoordinator.shared.detach(workspace: ws, prune: policy)
                } catch {
                    presentError((error as? LocalizedError)?.errorDescription ?? "\(error)")
                    return
                }
            }
        }

        private func handleReveal() {
            guard let workspace = workspaces.first,
                  WorkspaceMetadataStore.shared.branch(for: workspace) != nil,
                  let path = WorkspaceMetadataStore.shared.worktreePath(for: workspace)
                    ?? workspace.termLoopPresentationCwd()
            else { return }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        }

        /// Types `cd <worktree>` into every drifted panel's shell (busy
        /// shells are skipped by shell-integration-reported cwd). Non-
        /// destructive; runs synchronously per-workspace.
        private func handleSyncPanels() {
            var total = 0
            for ws in workspaces {
                total += WorktreeCoordinator.shared.respawnMismatchedPanels(workspace: ws)
            }
            if total == 0 {
                // Rare race: the badge showed drift but by the time the menu
                // closed, the shells self-corrected. Surface it so the user
                // doesn't wonder why nothing happened.
                presentInfo(String(
                    localized: "worktree.alert.syncNoop",
                    defaultValue: "No panels needed syncing.",
                    table: "TermLoop"
                ))
            }
        }

        /// Confirms, then close-and-respawns every drifted panel at the
        /// worktree path. Scrollback is lost — the confirm dialog spells
        /// this out. Refuses silently when the workspace isn't attached.
        private func handleRespawnPanels() {
            let drifted = divergentPanelTotal
            guard drifted > 0 else { return }
            let confirm = NSAlert()
            confirm.alertStyle = .warning
            confirm.messageText = String(
                localized: "worktree.alert.respawnTitle",
                defaultValue: "Reopen \(drifted) drifted panel(s)?",
                table: "TermLoop"
            )
            confirm.informativeText = String(
                localized: "worktree.alert.respawnBody",
                defaultValue: "Each drifted panel will be closed and reopened at the worktree path. Shell scrollback is lost. Running processes receive SIGHUP.",
                table: "TermLoop"
            )
            confirm.addButton(withTitle: String(
                localized: "worktree.alert.respawnConfirm",
                defaultValue: "Reopen", table: "TermLoop"
            ))
            confirm.addButton(withTitle: String(
                localized: "common.cancel",
                defaultValue: "Cancel", table: "TermLoop"
            ))
            guard confirm.runModal() == .alertFirstButtonReturn else { return }

            var total = 0
            for ws in workspaces {
                total += WorktreeCoordinator.shared.respawnMismatchedPanels(workspace: ws)
            }
            if total == 0 {
                presentInfo(String(
                    localized: "worktree.alert.respawnNoop",
                    defaultValue: "No panels needed reopening.",
                    table: "TermLoop"
                ))
            }
        }

        private func presentInfo(_ message: String) {
            let alert = NSAlert()
            alert.alertStyle = .informational
            alert.messageText = message
            alert.runModal()
        }

        private func presentError(_ message: String) {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = String(localized: "worktree.alert.errorTitle",
                                       defaultValue: "Worktree error", table: "TermLoop")
            alert.informativeText = message
            alert.runModal()
        }

    }

    /// Invoked from the sidebar's `.onChange(of: activeProjectId)` handler.
    /// Currently a no-op — kept as a hook point for future per-project
    /// reset behavior.
    static func handleActiveProjectDidChange() {
    }

    /// Returns the tab list filtered to the currently active project. When
    /// no project is active, all tabs are returned. Hidden rows are left in;
    /// callers decide whether hidden tabs participate in their own view.
    static func projectScopedTabs(allTabs: [Workspace]) -> [Workspace] {
        let activeProjectId = ProjectStore.shared.activeProjectId
        guard let activeProjectId else {
            return allTabs
        }
        let tabIds = allTabs.map(\.id)
        let projectScopeVersion = WorkspaceMetadataStore.shared.projectScopeVersion
        if projectScopedTabsCache.tabIds == tabIds,
           projectScopedTabsCache.activeProjectId == activeProjectId,
           projectScopedTabsCache.projectScopeVersion == projectScopeVersion {
            return projectScopedTabsCache.result
        }
        let result = allTabs.filter { $0.projectId == activeProjectId }
        projectScopedTabsCache = ProjectScopedTabsCache(
            tabIds: tabIds,
            activeProjectId: activeProjectId,
            projectScopeVersion: projectScopeVersion,
            result: result
        )
        return result
    }

    /// Returns the tab list filtered to the currently active project. When
    /// no project is active, all tabs are returned. Called from the upstream
    /// sidebar body as a single-line hook.
    static func projectFilteredTabs(allTabs: [Workspace]) -> [Workspace] {
        let activeProjectId = ProjectStore.shared.activeProjectId
        let tabIds = allTabs.map(\.id)
        let projectScopeVersion = WorkspaceMetadataStore.shared.projectScopeVersion
        let agentSessionVersion = WorkspaceMetadataStore.shared.agentSessionVersion
        if projectFilteredTabsCache.tabIds == tabIds,
           projectFilteredTabsCache.activeProjectId == activeProjectId,
           projectFilteredTabsCache.projectScopeVersion == projectScopeVersion,
           projectFilteredTabsCache.agentSessionVersion == agentSessionVersion {
            return projectFilteredTabsCache.result
        }
        let visibleTabs = projectScopedTabs(allTabs: allTabs).filter {
            !WorkspaceMetadataStore.shared.isHiddenFromWorkspaceTree(workspaceId: $0.id)
        }
        projectFilteredTabsCache = ProjectFilteredTabsCache(
            tabIds: tabIds,
            activeProjectId: activeProjectId,
            projectScopeVersion: projectScopeVersion,
            agentSessionVersion: agentSessionVersion,
            result: visibleTabs
        )
        return visibleTabs
    }


}
