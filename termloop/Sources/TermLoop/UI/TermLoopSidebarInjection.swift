// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import CoreImage.CIFilterBuiltins
import Darwin
import SwiftUI

private enum TermLoopPasteboard {
    static func copy(_ string: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(string, forType: .string)
    }
}

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
            }
        }
    }

    /// Opens a mobile pairing sheet. TCP stays off by default; this button
    /// enables the mobile bridge on demand and creates a short-lived QR token.
    struct MobilePairingButton: View {
        private static let refreshInterval: TimeInterval = 5.0
        @EnvironmentObject private var tabManager: TabManager
        @State private var status: TermLoopTCPBridge.StatusSnapshot =
            TermLoopTCPBridge.shared.currentStatus()
        @State private var showingSheet = false
        private let timer = Timer.publish(
            every: refreshInterval,
            on: .main,
            in: .common
        ).autoconnect()

        private var label: String {
            status.isRunning ? "mobile:\(status.port)" : "Connect Mobile"
        }

        var body: some View {
            Button {
                enableMobileBridge()
                showingSheet = true
            } label: {
                pill
            }
            .buttonStyle(.plain)
            .help(status.isRunning
                  ? "Pair a mobile app. Mobile bridge listening on \(status.bindHost):\(status.port)."
                  : "Enable the mobile bridge and show a pairing QR code.")
            .sheet(isPresented: $showingSheet) {
                MobilePairingSheet()
            }
            .onReceive(timer) { _ in
                let nextStatus = TermLoopTCPBridge.shared.currentStatus()
                guard nextStatus != status else { return }
                status = nextStatus
            }
        }

        private var pill: some View {
            HStack(spacing: 4) {
                Circle()
                    .fill(status.isRunning ? Color.green : Color.blue.opacity(0.85))
                    .frame(width: 5, height: 5)
                Text(verbatim: label)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .overlay(
                Rectangle()
                    .stroke(TermLoopSidebarTheme.rule, lineWidth: 1)
            )
        }

        private func enableMobileBridge() {
            UserDefaults.standard.set(Int(SocketControlSettings.tcpPortDefault),
                                      forKey: SocketControlSettings.tcpPortDefaultsKey)
            UserDefaults.standard.set(true, forKey: SocketControlSettings.tcpBindAllDefaultsKey)
            UserDefaults.standard.set(SocketControlMode.password.rawValue,
                                      forKey: SocketControlSettings.appStorageKey)
            TerminalController.shared.stop()
            TerminalController.shared.start(
                tabManager: tabManager,
                socketPath: SocketControlSettings.socketPath(),
                accessMode: .password
            )
            TermLoopTCPBridge.shared.reload()
            status = TermLoopTCPBridge.shared.currentStatus()
        }
    }

    private struct MobilePairingSheet: View {
        @Environment(\.dismiss) private var dismiss
        @State private var pairing: PairingDisplay?
        @State private var errorMessage: String?

        var body: some View {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Connect Mobile")
                            .font(.title2.weight(.semibold))
                        Text("Scan this QR from the TermLoop mobile app.")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Done") { dismiss() }
                        .keyboardShortcut(.defaultAction)
                }

                Group {
                    if let pairing {
                        HStack(alignment: .top, spacing: 18) {
                            if let image = pairing.qrImage {
                                Image(nsImage: image)
                                    .interpolation(.none)
                                    .resizable()
                                    .frame(width: 220, height: 220)
                                    .background(Color.white)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            VStack(alignment: .leading, spacing: 8) {
                                Text(pairing.serverName)
                                    .font(.headline)
                                Text("\(pairing.host):\(pairing.port)")
                                    .font(.system(.body, design: .monospaced))
                                Text("Expires in about 2 minutes. Keep this window open while pairing.")
                                    .foregroundStyle(.secondary)
                                Button("Copy pairing payload") {
                                    TermLoopPasteboard.copy(pairing.payloadString)
                                }
                            }
                        }
                    } else if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    } else {
                        ProgressView()
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(22)
            .frame(width: 560, height: 330)
            .onAppear(perform: createPairing)
        }

        private func createPairing() {
            let serverName = Host.current().localizedName ?? "TermLoop Mac"
            let result = TermLoopMobilePairingStore.createPairing(params: [
                "server_name": serverName
            ])
            guard case .ok(let rawPayload) = result,
                  let payload = rawPayload as? [String: Any],
                  let token = payload["token"] as? String,
                  let expiresAt = payload["expires_at"] as? TimeInterval else {
                errorMessage = "Could not create a mobile pairing token."
                return
            }
            let host = Self.localIPv4Address() ?? "127.0.0.1"
            let port = Int(SocketControlSettings.resolvedTcpPort() ?? SocketControlSettings.tcpPortDefault)
            let qrPayload: [String: Any] = [
                "type": "termloop.pairing",
                "version": 1,
                "server_name": serverName,
                "host": host,
                "port": port,
                "token": token,
                "expires_at": expiresAt
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: qrPayload, options: []),
                  let payloadString = String(data: data, encoding: .utf8) else {
                errorMessage = "Could not encode the pairing QR payload."
                return
            }
            pairing = PairingDisplay(
                serverName: serverName,
                host: host,
                port: port,
                payloadString: payloadString,
                qrImage: Self.qrImage(for: payloadString)
            )
        }

        private static func qrImage(for string: String) -> NSImage? {
            let filter = CIFilter.qrCodeGenerator()
            filter.message = Data(string.utf8)
            filter.correctionLevel = "M"
            guard let output = filter.outputImage else { return nil }
            let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
            let rep = NSCIImageRep(ciImage: scaled)
            let image = NSImage(size: rep.size)
            image.addRepresentation(rep)
            return image
        }

        private static func localIPv4Address() -> String? {
            var ifaddr: UnsafeMutablePointer<ifaddrs>?
            guard getifaddrs(&ifaddr) == 0 else { return nil }
            defer { freeifaddrs(ifaddr) }

            var pointer = ifaddr
            while pointer != nil {
                defer { pointer = pointer?.pointee.ifa_next }
                guard let interface = pointer?.pointee,
                      interface.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
                let name = String(cString: interface.ifa_name)
                guard name == "en0" || name == "en1" || name.hasPrefix("utun") else { continue }
                var addr = interface.ifa_addr.pointee
                var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                let result = getnameinfo(
                    &addr,
                    socklen_t(interface.ifa_addr.pointee.sa_len),
                    &hostname,
                    socklen_t(hostname.count),
                    nil,
                    0,
                    NI_NUMERICHOST
                )
                guard result == 0 else { continue }
                let ip = String(cString: hostname)
                if ip != "127.0.0.1" {
                    return ip
                }
            }
            return nil
        }

        private struct PairingDisplay {
            let serverName: String
            let host: String
            let port: Int
            let payloadString: String
            let qrImage: NSImage?
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
