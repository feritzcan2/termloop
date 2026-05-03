# Hooks Inventory

Auto-generated from the `// MARK: termloop-hook` marker blocks present
in upstream-owned Swift files. Regenerate with `scripts/generate-hooks-inventory.py`.

| File | Line | Hook |
|------|------|------|
| `CLI/termloop.swift` | 2246 | `case "list-projects", "current-project", "new-project", "rename-project",` |
| `CLI/termloop.swift` | 2253 | `case "agent":` |
| `CLI/termloop.swift` | 2258 | `case "session":` |
| `CLI/termloop.swift` | 12718 | `if let sessionId = parsedInput.sessionId {` |
| `CLI/termloop.swift` | 12918 | `TermLoopCLICommands.clearClaudeSession(workspaceId: workspaceId, client: client)` |
| `Sources/AppDelegate.swift` | 2542 | `TermLoopHooks.bootstrapBlockedBin()` |
| `Sources/AppDelegate.swift` | 2545 | `TermLoopHooks.installQuickActionHotkey()` |
| `Sources/AppDelegate.swift` | 3007 | `TermLoopHooks.applicationWillTerminate()` |
| `Sources/AppDelegate.swift` | 3787 | `// Bootstrap TermLoop stores from the sidecar (or create a Default` |
| `Sources/AppDelegate.swift` | 3855 | `TermLoopHooks.removeLegacyPersistedWindowGeometryIfPresent(defaults: defaults, keys: legacyPersistedWindowGeometryDefaultsKeys)` |
| `Sources/AppDelegate.swift` | 4620 | `// Save TermLoop sidecar from the same in-memory state that produced` |
| `Sources/AppDelegate.swift` | 4650 | `return TermLoopHooks.shouldSkipSessionSaveDuringStartupRestore(isApplyingStartupSessionRestore: isApplyingStartupSessionRestore, includeScrollback: includeScrollback)` |
| `Sources/AppDelegate.swift` | 4834 | `TermLoopHooks.removeMirroredSessionSnapshotIfNeeded()` |
| `Sources/AppDelegate.swift` | 5460 | `/// Walks window contexts in the same sorted order that` |
| `Sources/ContentView.swift` | 692 | `termLoopResetForwardingOnExit(sender: sender)` |
| `Sources/ContentView.swift` | 708 | `if let accepted = termLoopTryPrepareForwardedDrop(sender: sender, shouldCapture: shouldCapture) {` |
| `Sources/ContentView.swift` | 745 | `if let result = termLoopTryPerformForwardedDrop(sender: sender, shouldCapture: shouldCapture) {` |
| `Sources/ContentView.swift` | 787 | `termLoopConcludeForwardedDrop(sender: sender)` |
| `Sources/ContentView.swift` | 802 | `if let op = termLoopTryForwardDragUpdate(sender: sender, shouldCapture: shouldCapture) {` |
| `Sources/ContentView.swift` | 2772 | `.overlay(alignment: .bottom) { TermLoopHooks.workspaceFooterExtras(workspace: tab) }` |
| `Sources/ContentView.swift` | 2801 | `TermLoopHooks.mainAreaOverlaySwap {` |
| `Sources/ContentView.swift` | 7326 | `TermLoopHooks.handleNewWorkspacePaletteCommand(tabManager: tabManager)` |
| `Sources/ContentView.swift` | 10164 | `TermLoopSidebar.Root(` |
| `Sources/ContentView.swift` | 11138 | `TermLoopSidebar.FooterButton()` |
| `Sources/ContentView.swift` | 12815 | `TermLoopSidebar.WorktreeBadge(workspace: tab)` |
| `Sources/ContentView.swift` | 12822 | `TermLoopHooks.sidebarCloseButton(tab: tab, tabManager: tabManager, isEnabled: showCloseButton && !showsWorkspaceShortcutHint, foregroundColor: activeSecondaryColor(0.7), tooltip: closeButtonTooltip)` |
| `Sources/ContentView.swift` | 12839 | `TermLoopHooks.sidebarWorkspaceDescription(markdown: tab.customDescription, isActive: usesInvertedActiveForeground)` |
| `Sources/ContentView.swift` | 12915 | `TermLoopHooks.sidebarBranchDirectoryRow(tab: tab, isActive: isActive, settings: settings)` |
| `Sources/ContentView.swift` | 13188 | `TermLoopHooks.workspaceContextMenuExtras(workspace: tab)` |
| `Sources/ContentView.swift` | 13192 | `TermLoopHooks.workspaceForkMenu(workspace: tab, isMulti: isMulti)` |
| `Sources/ContentView.swift` | 13196 | `TermLoopHooks.workspaceLinkToMenu(workspace: tab, isMulti: isMulti, tabManager: tabManager)` |
| `Sources/ContentView.swift` | 13200 | `TermLoopSidebar.WorktreeMenuItems(targetIds: targetIds, tabManager: tabManager)` |
| `Sources/ContentView.swift` | 13204 | `TermLoopSidebar.RestoreClaudeSessionMenuItem(targetIds: targetIds)` |
| `Sources/ContentView.swift` | 13208 | `TermLoopSidebar.SelectPlanMenuItem(targetIds: targetIds)` |
| `Sources/ContentView.swift` | 14222 | `.modifier(TermLoopHooks.claudeRunningShimmer(entryKey: entry.key, entryValue: entry.value))` |
| `Sources/FileExplorerStore.swift` | 979 | `return GitCommandRunner.runOptional(arguments, in: directory, kind: GitCommandRunner.CommandKind.classify(arguments: arguments), caller: "GitStatusProvider")` |
| `Sources/GhosttyTerminalView.swift` | 4242 | `TermLoopHooks.applyManagedGitEnvironment(to: &env, protectedKeys: &protectedStartupEnvironmentKeys)` |
| `Sources/GhosttyTerminalView.swift` | 10499 | `guard !TermLoopHooks.shouldDeferTerminalFocusSteal() else { return }` |
| `Sources/GhosttyTerminalView.swift` | 10716 | `guard !TermLoopHooks.shouldDeferTerminalFocusSteal() else { return }` |
| `Sources/PortScanner.swift` | 63 | `private static let burstOffsets: [Double] = [1, 3, 10]` |
| `Sources/PortScanner.swift` | 307 | `guard TermLoopPortScanThrottle.shouldScan(workspaceId: workspaceId) else { return }` |
| `Sources/TabManager.swift` | 876 | `TermLoopHooks.workspaceSelectionChanged(tabManager: self, selectedTabId: selectedTabId)` |
| `Sources/TabManager.swift` | 1015 | `TermLoopHooks.registerSidebarProjectRefreshBridge(tabManager: self, scheduleGitMetadata: { [weak self] workspaceId, panelId, reason in self?.scheduleWorkspaceGitMetadataRefreshIfPossible(workspaceId: workspaceId, panelId: panelId, reason: reason) }, schedulePullRequest: { [weak self] workspaceId, panelId, reason in self?.scheduleWorkspacePullRequestRefresh(workspaceId: workspaceId, panelId: panelId, reason: reason) })` |
| `Sources/TabManager.swift` | 1287 | `return WorkspacePullRequestCandidate(workspaceId: workspace.id, panelId: panelId, branch: branch, repoSlugs: PullRequestRepositoryIdentityCache.shared.resolveOrPopulate(directory: gitProbeDirectory(for: workspace, panelId: panelId)))` |
| `Sources/TabManager.swift` | 1962 | `projectId: UUID? = nil,` |
| `Sources/TabManager.swift` | 2017 | `WorkspaceMetadataStore.shared.setProjectId(` |
| `Sources/TabManager.swift` | 2024 | `TermLoopHooks.bindTerminalAgentOnWorkspaceCreate(workspace: newWorkspace, terminalAgentId: terminalAgentId)` |
| `Sources/TabManager.swift` | 2450 | `if let snapshot = TermLoopHooks.initialWorkspaceGitMetadataSnapshot(directory: directory) { return InitialWorkspaceGitMetadataSnapshot(branch: snapshot.branch, isDirty: snapshot.isDirty, changes: snapshot.changes, pullRequest: snapshot.branch == nil ? .notFound : .deferred) }` |
| `Sources/TabManager.swift` | 2476 | `return GitCommandRunner.runOptional(arguments, in: directory, kind: GitCommandRunner.CommandKind.classify(arguments: arguments), caller: "TabManager.gitMetadata")` |
| `Sources/TabManager.swift` | 2980 | `return GitRemoteParser.githubRepositorySlugs(fromRemoteVOutput: output)` |
| `Sources/TabManager.swift` | 3639 | `TermLoopHooks.workspaceDidClose(workspaceId: workspace.id)` |
| `Sources/TabManager.swift` | 3960 | `if TermLoopHooks.workspaceWillClose(workspace: workspace, completion: { [weak self] shouldClose in if shouldClose { self?.closeWorkspaceIfRunningProcess(workspace, requiresConfirmation: requiresConfirmation) } }) { return }` |
| `Sources/TabManager.swift` | 4138 | `if confirmCloseExitedLastLocalSurface(tab: tab, surfaceId: surfaceId) { return }` |
| `Sources/TabManager.swift` | 6616 | `TermLoopHooks.sessionSnapshot(for: $0, includeScrollback: includeScrollback)` |
| `Sources/TabManager.swift` | 6671 | `TermLoopHooks.beginTabManagerSessionRestore(tabManager: self, selectedWorkspaceIndex: snapshot.selectedWorkspaceIndex, totalWorkspaceCount: snapshot.workspaces.count)` |
| `Sources/TabManager.swift` | 6683 | `TermLoopHooks.restoreWorkspaceSessionSnapshot(workspace: workspace, snapshot: workspaceSnapshot, tabManager: self)` |
| `Sources/TabManager.swift` | 6712 | `TermLoopHooks.didRestoreWorkspaces(workspaces: newTabs)` |
| `Sources/TerminalController.swift` | 1060 | `TermLoopTCPBridge.shared.start { [weak self] fd in` |
| `Sources/TerminalController.swift` | 1198 | `TermLoopTCPBridge.shared.stop()` |
| `Sources/TerminalController.swift` | 1275 | `TermLoopSocketIO.writeText(payload, to: socket)` |
| `Sources/TerminalController.swift` | 1678 | `TermLoopHooks.handleAcceptedClient(socket: socket); defer { TermLoopHooks.handleClientDisconnect(socket: socket) }` |
| `Sources/TerminalController.swift` | 1691 | `TermLoopSocketIO.writeText(msg, to: socket)` |
| `Sources/TerminalController.swift` | 1707 | `TermLoopSocketIO.writeText(msg, to: socket)` |
| `Sources/TerminalController.swift` | 2129 | `TermLoopHooks.refreshV2KnownRefsIfNeeded(method: method) { self.v2MainSync { self.v2RefreshKnownRefs() } }` |
| `Sources/TerminalController.swift` | 2135 | `let socketFd = TermLoopTCPBridge.currentSocketFd()` |
| `Sources/TerminalController.swift` | 3094 | `// TermLoopSocketCommands returns this type across file boundaries, so it` |
| `Sources/TerminalController.swift` | 3455 | `payload.merge(self.termLoopWorkspaceSummaryFields(for: workspace)) { _, new in new }` |
| `Sources/TerminalController.swift` | 3540 | `let explicitProjectId = v2UUID(params, "project_id")` |
| `Sources/TerminalController.swift` | 3574 | `projectId: explicitProjectId ?? termLoopWorkspaceCreateContext.projectId,` |
| `Sources/TerminalController.swift` | 3579 | `self.termLoopFinishWorkspaceCreate(launch: termLoopWorkspaceAgentLaunch, context: termLoopWorkspaceCreateContext, workspace: ws)` |
| `Sources/TerminalController.swift` | 6049 | `/// Narrow bridge for the mobile streaming backend. The stream registry` |
| `Sources/TerminalController.swift` | 14904 | `if TerminalAgentRegistry.shared.statusKeys.contains(key) {` |
| `Sources/Update/UpdateTitlebarAccessory.swift` | 411 | `TermLoopHooks.titlebarSettingsButton(config: config)` |
| `Sources/Workspace.swift` | 454 | `TermLoopHooks.ensurePanelDirectoryBeforeSnapshot(workspace: self, panelId: panelId)` |
| `Sources/Workspace.swift` | 7637 | `TermLoopHooks.workspaceTitleDidChange(workspace: self)` |
| `Sources/Workspace.swift` | 7668 | `TermLoopHooks.workspaceTitleDidChange(workspace: self)` |
| `Sources/Workspace.swift` | 8045 | `TermLoopHooks.workspaceTitleDidChange(workspace: self)` |
| `Sources/Workspace.swift` | 9263 | `TermLoopHooks.seedSpawnPanelDirectory(workspace: self, panelId: newPanel.id, directory: workingDirectory)` |
| `Sources/Workspace.swift` | 10460 | `return newTerminalSurface(inPane: focusedPaneId, focus: focus, workingDirectory: termLoopNewTabCwd)` |
| `Sources/WorkspaceContentView.swift` | 396 | `.modifier(TermLoopHooks.submoduleInitGate(for: workspace.id))` |
| `Sources/termloopApp.swift` | 167 | `TermLoopHooks.prepareSharedTaggedBuildState()` |
| `Sources/termloopApp.swift` | 170 | `TermLoopHooks.migrateSidebarWorkSubTabDefaultIfNeeded()` |
| `Sources/termloopApp.swift` | 178 | `TermLoopHooks.migrateAppearanceDarkDefaultIfNeeded()` |
| `Sources/termloopApp.swift` | 407 | `TermLoopMobilePairingStore.restoreBridgeSettingsForPairedDevicesIfNeeded()` |
| `Sources/termloopApp.swift` | 428 | `.background(TermLoopTCPBridgeCoordinator())` |
| `Sources/termloopApp.swift` | 432 | `.background(TermLoopRootTickInstrumentation(tabManager: tabManager, notificationStore: notificationStore, sidebarState: sidebarState, sidebarSelectionState: sidebarSelectionState, fileExplorerState: fileExplorerState, cmuxConfigStore: cmuxConfigStore))` |
| `Sources/termloopApp.swift` | 449 | `Button(String(localized: "termloop.settings.menu.label", defaultValue: "TermLoop Settings…", table: "TermLoop")) { TermLoopHooks.openTermLoopSettingsWindow() }.keyboardShortcut(",", modifiers: [.command, .option])` |
| `Sources/termloopApp.swift` | 570 | `Button(String(localized: "termloop.debugEventLog.menu.label", defaultValue: "Debug Event Log…", table: "TermLoop")) { TermLoopHooks.openDebugEventLogWindow() }` |
| `Sources/termloopApp.swift` | 627 | `TermLoopHooks.debugTitlebarControlsStyleMenu(selection: $titlebarControlsStyle)` |
| `Sources/termloopApp.swift` | 645 | `Button(String(localized: "termloop.deleteAllData.menu.label", defaultValue: "Delete All Data (This Build)…", table: "TermLoop")) { TermLoopHooks.promptDeleteAllBuildData() }` |
| `Sources/termloopApp.swift` | 1245 | `"cmux.debugEventLog",` |

Total hook blocks: **91**.
