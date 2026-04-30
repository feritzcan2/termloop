// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Click-anchored replacement for the sidebar workspace X button.
///
/// Shows a SwiftUI popover attached to the button instead of the center-
/// screen `NSAlert` confirmation path when the workspace needs a warning
/// (pinned, or agent/terminal running). Non-confirmation closes fall
/// through to the existing close flow so nothing changes when there's
/// nothing to confirm.
struct TermLoopSidebarCloseButton: View {
    let tab: Workspace
    weak var tabManager: TabManager?
    let isEnabled: Bool
    let foregroundColor: Color
    let tooltip: String

    @State private var showConfirmation = false

    var body: some View {
        Button(action: handleClick) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(foregroundColor)
        }
        .buttonStyle(.plain)
        .safeHelp(tooltip)
        .frame(width: SidebarTrailingAccessoryWidthPolicy.closeButtonWidth, height: 16, alignment: .center)
        .opacity(isEnabled ? 1 : 0)
        .allowsHitTesting(isEnabled)
        .popover(isPresented: $showConfirmation, arrowEdge: .trailing) {
            TermLoopSidebarCloseConfirmationPopover(
                tab: tab,
                onConfirm: {
                    showConfirmation = false
                    // Let the popover tear down before its anchor row is removed.
                    DispatchQueue.main.async {
                        tabManager?.closeWorkspaceFromSidebarPopover(tab)
                    }
                },
                onCancel: {
                    showConfirmation = false
                }
            )
        }
    }

    private func handleClick() {
        if needsConfirmation {
            showConfirmation = true
        } else {
            tabManager?.closeWorkspaceFromSidebarPopover(tab)
        }
    }

    private var needsConfirmation: Bool {
        tab.isPinned || tab.needsConfirmClose()
    }
}

/// Compact confirmation body shown inside the popover anchored to the X
/// button. Mirrors the wording of the `NSAlert` paths it replaces (pinned
/// warning / running-process warning) so users see the same intent.
private struct TermLoopSidebarCloseConfirmationPopover: View {
    let tab: Workspace
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(titleText)
                .font(.system(size: 13, weight: .semibold))
            Text(messageText)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer()
                Button(cancelLabel) { onCancel() }
                    .keyboardShortcut(.cancelAction)
                Button(role: .destructive) { onConfirm() } label: {
                    Text(closeLabel)
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .frame(minWidth: 260, idealWidth: 280, maxWidth: 320, alignment: .leading)
    }

    private var titleText: String {
        if tab.isPinned {
            return String(
                localized: "dialog.closePinnedWorkspace.title",
                defaultValue: "Close pinned workspace?"
            )
        }
        return String(
            localized: "dialog.closeWorkspace.title",
            defaultValue: "Close workspace?"
        )
    }

    private var messageText: String {
        if tab.isPinned {
            return String(
                localized: "dialog.closePinnedWorkspace.message",
                defaultValue: "This workspace is pinned. Closing it will close the workspace and all of its panels."
            )
        }
        return String(
            localized: "dialog.closeWorkspace.message",
            defaultValue: "This will close the workspace and all of its panels."
        )
    }

    private var closeLabel: String {
        String(localized: "dialog.closeTab.close", defaultValue: "Close")
    }

    private var cancelLabel: String {
        String(localized: "dialog.closeTab.cancel", defaultValue: "Cancel")
    }
}

extension TermLoopHooks {
    @MainActor
    @ViewBuilder
    static func sidebarCloseButton(
        tab: Workspace,
        tabManager: TabManager?,
        isEnabled: Bool,
        foregroundColor: Color,
        tooltip: String
    ) -> some View {
        TermLoopSidebarCloseButton(
            tab: tab,
            tabManager: tabManager,
            isEnabled: isEnabled,
            foregroundColor: foregroundColor,
            tooltip: tooltip
        )
    }
}

/// Coordinator for the "Hide workspace" flow.
///
/// Hide fully tears down the workspace's live tab — Ghostty surface, pty,
/// MCP subprocess, PortScanner registration — while preserving its metadata
/// (branch, persisted agent session, ticket binding, …) so the user can
/// bring it back later from the sidebar's "Hidden" section.
///
/// Compared with `TabManager.closeWorkspaceFromSidebarPopover`:
/// * Close removes the workspace and forgets about it after agent-close
///   prompts. Next cold boot doesn't resurrect it.
/// * Hide *suppresses* the agent-close prompt (we don't want to nag the
///   user when they're explicitly asking to stash state), closes the tab,
///   and leaves metadata in `WorkspaceMetadataStore` with `isHidden = true`.
///
/// Unhide creates a fresh workspace tab via `tabManager.addWorkspace` using
/// the persisted cwd / agent / folder binding, copies remaining metadata
/// fields onto the new workspace id, removes the old metadata entry, and
/// kicks `ClaudeRestoreCoordinator` so the terminal agent resumes from the
/// stored session id once its surface is ready — mirroring the cold-boot
/// `didRestoreWorkspaces` restore path.
@MainActor
enum WorkspaceHideCoordinator {
    @discardableResult
    static func confirmAndCollapse(
        workspace: Workspace,
        tabManager: TabManager,
        targetName: String? = nil
    ) -> Bool {
        confirmAndCollapse(
            workspaces: [workspace],
            tabManager: tabManager,
            targetName: targetName
        )
    }

    @discardableResult
    static func confirmAndCollapse(
        workspaces: [Workspace],
        tabManager: TabManager,
        targetName: String?
    ) -> Bool {
        let liveWorkspaces = workspaces.filter { workspace in
            tabManager.tabs.contains(where: { $0.id == workspace.id })
        }
        guard !liveWorkspaces.isEmpty else { return false }
        guard confirmCollapse(targetName: targetName, workspaceCount: liveWorkspaces.count) else { return false }
        ensureFallbackWorkspaceIfNeeded(
            collapsingWorkspaceIds: Set(liveWorkspaces.map(\.id)),
            tabManager: tabManager
        )
        for workspace in liveWorkspaces {
            guard tabManager.tabs.contains(where: { $0.id == workspace.id }) else { continue }
            hide(workspace: workspace, tabManager: tabManager, saveCriticalState: false)
        }
        TermLoopHooks.saveCriticalAgentRestoreStateSync()
        return true
    }

    private static func ensureFallbackWorkspaceIfNeeded(
        collapsingWorkspaceIds: Set<UUID>,
        tabManager: TabManager
    ) {
        let remainingIds = Set(tabManager.tabs.map(\.id)).subtracting(collapsingWorkspaceIds)
        guard remainingIds.isEmpty else { return }
        _ = tabManager.addWorkspace(
            select: false,
            autoWelcomeIfNeeded: false,
            projectId: ProjectStore.shared.activeProjectId
        )
    }

    private static func confirmCollapse(targetName: String?, workspaceCount: Int) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        if let name = targetName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            let format = String(
                localized: "workspaceCollapse.confirm.namedTitle",
                defaultValue: "Collapse %@?",
                table: "TermLoop"
            )
            alert.messageText = String.localizedStringWithFormat(format, name)
        } else {
            alert.messageText = String(
                localized: "workspaceCollapse.confirm.title",
                defaultValue: "Collapse agent?",
                table: "TermLoop"
            )
        }

        if workspaceCount == 1 {
            alert.informativeText = String(
                localized: "workspaceCollapse.confirm.singleBody",
                defaultValue: "This will stop the terminal process and move it to the bottom of the sidebar. You can restore it later; saved agent sessions auto-resume.",
                table: "TermLoop"
            )
        } else {
            let format = String(
                localized: "workspaceCollapse.confirm.multipleBody",
                defaultValue: "This will stop terminal processes for %d workspaces and move them to the bottom of the sidebar. You can restore them later; saved agent sessions auto-resume.",
                table: "TermLoop"
            )
            alert.informativeText = String.localizedStringWithFormat(format, workspaceCount)
        }
        alert.addButton(withTitle: String(
            localized: "workspaceCollapse.confirm.collapse",
            defaultValue: "Collapse",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    static func hide(
        workspace: Workspace,
        tabManager: TabManager,
        saveCriticalState: Bool = true
    ) {
        let workspaceId = workspace.id
        let customTitle = workspace.customTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayTitle = (customTitle?.isEmpty == false) ? customTitle : workspace.title
        WorkspaceMetadataStore.shared.setCollapsedDisplayTitle(displayTitle, forWorkspaceId: workspaceId)
        WorkspaceMetadataStore.shared.setHidden(true, forWorkspaceId: workspaceId)
        if saveCriticalState {
            TermLoopHooks.saveCriticalAgentRestoreStateSync()
        }
        // `closeWorkspace` is a no-op when this is the only tab in the
        // window, so we mirror the single-tab behavior of the sidebar X
        // popover (close the window) to keep teardown consistent.
        if tabManager.tabs.count > 1 {
            tabManager.closeWorkspace(workspace)
        } else if let window = tabManager.window {
            window.performClose(nil)
        } else {
            AppDelegate.shared?.closeMainWindowContainingTabId(workspaceId)
        }
    }

    struct HiddenWorkspaceSummary: Identifiable {
        let id: UUID
        let branch: String?
        let cwd: String?
        let agentId: String?
        let title: String?
        let projectId: UUID?
    }

    static func hiddenSummaries() -> [HiddenWorkspaceSummary] {
        WorkspaceMetadataStore.shared.hiddenWorkspaces().map { pair in
            HiddenWorkspaceSummary(
                id: pair.id,
                branch: pair.metadata.branch,
                cwd: pair.metadata.persistedAgentSession?.cwd,
                agentId: pair.metadata.persistedAgentSession?.agentId ?? pair.metadata.terminalAgentId,
                title: pair.metadata.collapsedDisplayTitle,
                projectId: pair.metadata.projectId
            )
        }
        .sorted { lhs, rhs in
            (lhs.branch ?? "") < (rhs.branch ?? "")
        }
    }

    @discardableResult
    static func unhide(workspaceId oldId: UUID, tabManager: TabManager) -> Workspace? {
        TerminalAgentLifecycle.reopenHiddenWorkspace(
            oldWorkspaceId: oldId,
            tabManager: tabManager
        )
    }
}

