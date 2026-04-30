# Hooks Inventory

Auto-generated from the `// MARK: termloop-hook` marker blocks present
in upstream-owned Swift files. Regenerate with `scripts/generate-hooks-inventory.py`.

| File | Line | Hook |
|------|------|------|
| `CLI/termloop.swift` | 2189 | `case "list-projects", "current-project", "new-project", "rename-project",` |
| `CLI/termloop.swift` | 2196 | `case "agent":` |
| `CLI/termloop.swift` | 2201 | `case "session":` |
| `CLI/termloop.swift` | 12598 | `if let sessionId = parsedInput.sessionId {` |
| `CLI/termloop.swift` | 12808 | `TermLoopCLICommands.clearClaudeSession(workspaceId: workspaceId, client: client)` |
| `Sources/AppDelegate.swift` | 2537 | `TermLoopHooks.bootstrapBlockedBin()` |
| `Sources/AppDelegate.swift` | 2540 | `TermLoopHooks.installQuickActionHotkey()` |
| `Sources/AppDelegate.swift` | 3002 | `TermLoopHooks.applicationWillTerminate()` |
| `Sources/AppDelegate.swift` | 3780 | `// Bootstrap TermLoop stores from the sidecar (or create a Default` |
| `Sources/AppDelegate.swift` | 3848 | `TermLoopHooks.removeLegacyPersistedWindowGeometryIfPresent(defaults: defaults, keys: legacyPersistedWindowGeometryDefaultsKeys)` |
| `Sources/AppDelegate.swift` | 4523 | `// Save TermLoop sidecar from the same in-memory state that produced` |
| `Sources/AppDelegate.swift` | 4553 | `return TermLoopHooks.shouldSkipSessionSaveDuringStartupRestore(isApplyingStartupSessionRestore: isApplyingStartupSessionRestore, includeScrollback: includeScrollback)` |
| `Sources/AppDelegate.swift` | 4737 | `TermLoopHooks.removeMirroredSessionSnapshotIfNeeded()` |
| `Sources/AppDelegate.swift` | 5363 | `/// Walks window contexts in the same sorted order that` |
| `Sources/AppDelegate.swift` | 6923 | `let activeFeatureId = FolderStore.shared.activeFolderId` |
| `Sources/AppDelegate.swift` | 6927 | `workspace = context.tabManager.addWorkspace(workingDirectory: workingDirectory, select: true, featureId: activeFeatureId)` |
| `Sources/AppDelegate.swift` | 6931 | `workspace = context.tabManager.addWorkspace(select: true, featureId: activeFeatureId)` |
| `Sources/ContentView.swift` | 692 | `termLoopResetForwardingOnExit(sender: sender)` |
| `Sources/ContentView.swift` | 708 | `if let accepted = termLoopTryPrepareForwardedDrop(sender: sender, shouldCapture: shouldCapture) {` |
| `Sources/ContentView.swift` | 745 | `if let result = termLoopTryPerformForwardedDrop(sender: sender, shouldCapture: shouldCapture) {` |
| `Sources/ContentView.swift` | 787 | `termLoopConcludeForwardedDrop(sender: sender)` |
| `Sources/ContentView.swift` | 802 | `if let op = termLoopTryForwardDragUpdate(sender: sender, shouldCapture: shouldCapture) {` |
| `Sources/ContentView.swift` | 2772 | `.overlay(alignment: .bottom) { TermLoopHooks.workspaceFooterExtras(workspace: tab) }` |
| `Sources/ContentView.swift` | 2801 | `TermLoopHooks.mainAreaOverlaySwap {` |
| `Sources/ContentView.swift` | 7326 | `TermLoopHooks.handleNewWorkspacePaletteCommand(tabManager: tabManager)` |
| `Sources/ContentView.swift` | 7340 | `tabManager.addWorkspace(workingDirectory: url.path, featureId: TermLoopSidebar.activeFeatureId)` |
| `Sources/ContentView.swift` | 10166 | `TermLoopSidebar.Root(` |
| `Sources/ContentView.swift` | 11140 | `TermLoopSidebar.FooterButton()` |
| `Sources/ContentView.swift` | 12352 | `tabManager.addWorkspace(placementOverride: .end, featureId: TermLoopSidebar.activeFeatureId)` |
| `Sources/ContentView.swift` | 12819 | `TermLoopSidebar.WorktreeBadge(workspace: tab)` |
| `Sources/ContentView.swift` | 12826 | `TermLoopHooks.sidebarCloseButton(tab: tab, tabManager: tabManager, isEnabled: showCloseButton && !showsWorkspaceShortcutHint, foregroundColor: activeSecondaryColor(0.7), tooltip: closeButtonTooltip)` |
| `Sources/ContentView.swift` | 12843 | `TermLoopHooks.sidebarWorkspaceDescription(markdown: tab.customDescription, isActive: usesInvertedActiveForeground)` |
| `Sources/ContentView.swift` | 12919 | `TermLoopHooks.sidebarBranchDirectoryRow(tab: tab, isActive: isActive, settings: settings)` |
| `Sources/ContentView.swift` | 13104 | `.modifier(TermLoopSidebar.BridgeDropAdapter(workspace: tab))` |
| `Sources/ContentView.swift` | 13193 | `let activeProjectFeatures: [Folder] = TermLoopSidebar.activeProjectFeatures` |
| `Sources/ContentView.swift` | 13197 | `TermLoopHooks.workspaceContextMenuExtras(workspace: tab)` |
| `Sources/ContentView.swift` | 13201 | `TermLoopHooks.workspaceForkMenu(workspace: tab, isMulti: isMulti)` |
| `Sources/ContentView.swift` | 13205 | `TermLoopHooks.workspaceLinkToMenu(workspace: tab, isMulti: isMulti, tabManager: tabManager)` |
| `Sources/ContentView.swift` | 13209 | `if !activeProjectFeatures.isEmpty {` |
| `Sources/ContentView.swift` | 13224 | `TermLoopSidebar.WorktreeMenuItems(targetIds: targetIds, tabManager: tabManager)` |
| `Sources/ContentView.swift` | 13228 | `TermLoopSidebar.RestoreClaudeSessionMenuItem(targetIds: targetIds)` |
| `Sources/ContentView.swift` | 13232 | `TermLoopSidebar.SelectPlanMenuItem(targetIds: targetIds)` |
| `Sources/ContentView.swift` | 14246 | `.modifier(TermLoopHooks.claudeRunningShimmer(entryKey: entry.key, entryValue: entry.value))` |
| `Sources/ContentView.swift` | 14922 | `TermLoopHooks.didReorderSidebarTab(draggedTabId: draggedTabId, targetTabId: targetTabId, tabManager: tabManager)` |
| `Sources/FileExplorerStore.swift` | 979 | `return GitCommandRunner.runOptional(arguments, in: directory, kind: GitCommandRunner.CommandKind.classify(arguments: arguments), caller: "GitStatusProvider")` |
| `Sources/GhosttyTerminalView.swift` | 4224 | `TermLoopHooks.applyManagedGitEnvironment(to: &env, protectedKeys: &protectedStartupEnvironmentKeys)` |
| `Sources/GhosttyTerminalView.swift` | 10486 | `guard !TermLoopHooks.shouldDeferTerminalFocusSteal() else { return }` |
| `Sources/GhosttyTerminalView.swift` | 10703 | `guard !TermLoopHooks.shouldDeferTerminalFocusSteal() else { return }` |
| `Sources/PortScanner.swift` | 58 | `private static let burstOffsets: [Double] = [1, 3, 10]` |
| `Sources/PortScanner.swift` | 272 | `guard TermLoopPortScanThrottle.shouldScan(workspaceId: workspaceId) else { return }` |
| `Sources/TabManager.swift` | 874 | `TermLoopHooks.workspaceSelectionChanged(tabManager: self, selectedTabId: selectedTabId)` |
| `Sources/TabManager.swift` | 1282 | `return WorkspacePullRequestCandidate(workspaceId: workspace.id, panelId: panelId, branch: branch, repoSlugs: PullRequestRepositoryIdentityCache.shared.resolveOrPopulate(directory: gitProbeDirectory(for: workspace, panelId: panelId)))` |
| `Sources/TabManager.swift` | 1939 | `projectId: UUID? = nil,` |
| `Sources/TabManager.swift` | 1995 | `WorkspaceMetadataStore.shared.setProjectId(` |
| `Sources/TabManager.swift` | 2003 | `TermLoopHooks.bindTerminalAgentOnWorkspaceCreate(workspace: newWorkspace, terminalAgentId: terminalAgentId)` |
| `Sources/TabManager.swift` | 2429 | `if let snapshot = TermLoopHooks.initialWorkspaceGitMetadataSnapshot(directory: directory) { return InitialWorkspaceGitMetadataSnapshot(branch: snapshot.branch, isDirty: snapshot.isDirty, changes: snapshot.changes, pullRequest: snapshot.branch == nil ? .notFound : .deferred) }` |
| `Sources/TabManager.swift` | 2455 | `return GitCommandRunner.runOptional(arguments, in: directory, kind: GitCommandRunner.CommandKind.classify(arguments: arguments), caller: "TabManager.gitMetadata")` |
| `Sources/TabManager.swift` | 2957 | `return GitRemoteParser.githubRepositorySlugs(fromRemoteVOutput: output)` |
| `Sources/TabManager.swift` | 3073 | `addWorkspace(` |
| `Sources/TabManager.swift` | 3619 | `TermLoopHooks.workspaceDidClose(workspaceId: workspace.id)` |
| `Sources/TabManager.swift` | 3940 | `if TermLoopHooks.workspaceWillClose(workspace: workspace, completion: { [weak self] shouldClose in if shouldClose { self?.closeWorkspaceIfRunningProcess(workspace, requiresConfirmation: requiresConfirmation) } }) { return }` |
| `Sources/TabManager.swift` | 4118 | `if confirmCloseExitedLastLocalSurface(tab: tab, surfaceId: surfaceId) { return }` |
| `Sources/TabManager.swift` | 6596 | `TermLoopHooks.sessionSnapshot(for: $0, includeScrollback: includeScrollback)` |
| `Sources/TabManager.swift` | 6651 | `TermLoopHooks.beginTabManagerSessionRestore(tabManager: self, selectedWorkspaceIndex: snapshot.selectedWorkspaceIndex, totalWorkspaceCount: snapshot.workspaces.count)` |
| `Sources/TabManager.swift` | 6663 | `TermLoopHooks.restoreWorkspaceSessionSnapshot(workspace: workspace, snapshot: workspaceSnapshot, tabManager: self)` |
| `Sources/TabManager.swift` | 6692 | `TermLoopHooks.didRestoreWorkspaces(workspaces: newTabs)` |
| `Sources/TerminalController.swift` | 1059 | `TermLoopTCPBridge.shared.start { [weak self] fd in` |
| `Sources/TerminalController.swift` | 1195 | `TermLoopTCPBridge.shared.stop()` |
| `Sources/TerminalController.swift` | 1236 | `TermLoopSocketIO.writeText(payload, to: socket)` |
| `Sources/TerminalController.swift` | 1610 | `TermLoopHooks.handleAcceptedClient(socket: socket); defer { TermLoopHooks.handleClientDisconnect(socket: socket) }` |
| `Sources/TerminalController.swift` | 1623 | `TermLoopSocketIO.writeText(msg, to: socket)` |
| `Sources/TerminalController.swift` | 1639 | `TermLoopSocketIO.writeText(msg, to: socket)` |
| `Sources/TerminalController.swift` | 2061 | `TermLoopHooks.refreshV2KnownRefsIfNeeded(method: method) { self.v2MainSync { self.v2RefreshKnownRefs() } }` |
| `Sources/TerminalController.swift` | 2067 | `if let response = v2MainSync({ TermLoopSocketCommands.handle(method: method, params: params, isTcpClient: TermLoopTCPBridge.isCurrentThreadTcpClient()) }) {` |
| `Sources/TerminalController.swift` | 3010 | `// TermLoopSocketCommands returns this type across file boundaries, so it` |
| `Sources/TerminalController.swift` | 3371 | `payload.merge(self.termLoopWorkspaceSummaryFields(for: workspace)) { _, new in new }` |
| `Sources/TerminalController.swift` | 3456 | `let explicitProjectId = v2UUID(params, "project_id")` |
| `Sources/TerminalController.swift` | 3478 | `projectId: explicitProjectId,` |
| `Sources/TerminalController.swift` | 14766 | `TermLoopHooks.captureStatusBeforeWrite(workspaceId: tab.id, key: key, previousValue: tab.statusEntries[key]?.value)` |
| `Sources/TerminalController.swift` | 14779 | `if TerminalAgentRegistry.shared.statusKeys.contains(key) {` |
| `Sources/TerminalController.swift` | 14784 | `TermLoopHooks.publishTurnCompleted(workspaceId: tab.id, previous: TermLoopHooks.consumeCapturedStatus(workspaceId: tab.id), next: value)` |
| `Sources/Update/UpdateTitlebarAccessory.swift` | 411 | `TermLoopHooks.titlebarSettingsButton(config: config)` |
| `Sources/Workspace.swift` | 452 | `TermLoopHooks.ensurePanelDirectoryBeforeSnapshot(workspace: self, panelId: panelId)` |
| `Sources/Workspace.swift` | 9216 | `TermLoopHooks.seedSpawnPanelDirectory(workspace: self, panelId: newPanel.id, directory: workingDirectory)` |
| `Sources/Workspace.swift` | 10413 | `return newTerminalSurface(inPane: focusedPaneId, focus: focus, workingDirectory: termLoopNewTabCwd)` |
| `Sources/WorkspaceContentView.swift` | 396 | `.modifier(TermLoopHooks.submoduleInitGate(for: workspace.id))` |
| `Sources/termloopApp.swift` | 167 | `TermLoopHooks.prepareSharedTaggedBuildState()` |
| `Sources/termloopApp.swift` | 170 | `TermLoopHooks.migrateSidebarWorkSubTabDefaultIfNeeded()` |
| `Sources/termloopApp.swift` | 178 | `TermLoopHooks.migrateAppearanceDarkDefaultIfNeeded()` |
| `Sources/termloopApp.swift` | 425 | `.background(TermLoopTCPBridgeCoordinator())` |
| `Sources/termloopApp.swift` | 429 | `.background(TermLoopRootTickInstrumentation(tabManager: tabManager, notificationStore: notificationStore, sidebarState: sidebarState, sidebarSelectionState: sidebarSelectionState, fileExplorerState: fileExplorerState, cmuxConfigStore: cmuxConfigStore))` |
| `Sources/termloopApp.swift` | 446 | `Button(String(localized: "termloop.settings.menu.label", defaultValue: "TermLoop Settings…", table: "TermLoop")) { TermLoopHooks.openTermLoopSettingsWindow() }.keyboardShortcut(",", modifiers: [.command, .option])` |
| `Sources/termloopApp.swift` | 567 | `Button(String(localized: "termloop.debugEventLog.menu.label", defaultValue: "Debug Event Log…", table: "TermLoop")) { TermLoopHooks.openDebugEventLogWindow() }` |
| `Sources/termloopApp.swift` | 624 | `TermLoopHooks.debugTitlebarControlsStyleMenu(selection: $titlebarControlsStyle)` |
| `Sources/termloopApp.swift` | 642 | `Button(String(localized: "termloop.deleteAllData.menu.label", defaultValue: "Delete All Data (This Build)…", table: "TermLoop")) { TermLoopHooks.promptDeleteAllBuildData() }` |
| `Sources/termloopApp.swift` | 1242 | `"cmux.debugEventLog",` |

Total hook blocks: **96**.
