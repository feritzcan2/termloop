// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct TerminalAgentActivityRow: View, Equatable {
    let session: TerminalAgentLiveSession
    let branchSummary: String?
    let isSelected: Bool
    let tabManager: TabManager
    let contextMenuSnapshot: ActiveAgentWorkspaceContextMenuSnapshot?
    let onTap: () -> Void
    /// Hard-close action: × opens a "Delete workspace?" popover via the shared
    /// `AgentRowCoreView`; Yes fires this. ActiveAgents always provides it —
    /// Worktree/Ticket do not expose × at all.
    let onCloseWorkspace: () -> Void
    let onCollapseWorkspace: () -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.session == rhs.session &&
            lhs.branchSummary == rhs.branchSummary &&
            lhs.isSelected == rhs.isSelected &&
            lhs.contextMenuSnapshot == rhs.contextMenuSnapshot
    }

    /// ActiveAgents uses its own branch-summary index (not the snapshot
    /// `branchLabel`, which is nil for this panel) + the `session.since`
    /// fallback over `core.since` for first-spawn rows.
    private var coreForRow: AgentRowPresentationSnapshot {
        let resolvedBranch: String? = {
            if let trimmed = branchSummary?.trimmingCharacters(in: .whitespacesAndNewlines),
               !trimmed.isEmpty {
                return trimmed
            }
            return session.core.branchLabel
        }()
        return session.core.with(branchLabel: resolvedBranch, since: session.since)
    }

    var body: some View {
        AgentRowCoreView(
            core: coreForRow,
            isSelected: isSelected,
            trailingSlot: .collapseButton,
            dismissBehavior: .confirmClose(onConfirm: onCloseWorkspace),
            onActivate: onTap,
            onAcknowledgeAttention: { [workspaceId = session.core.workspaceId] in
                TerminalAgentActivityStore.shared.acknowledgeViewedAttention(forWorkspaceId: workspaceId)
            },
            onTrailingSlotTap: onCollapseWorkspace
        )
        .equatable()
        .contextMenu {
            if let snapshot = contextMenuSnapshot {
                ActiveAgentWorkspaceContextMenu(
                    snapshot: snapshot,
                    tabManager: tabManager
                )
            }
        }
    }
}

/// Compact sidebar row for a TermLoop-spawned ability workspace.
///
/// Uses `HStack + .contentShape + .onTapGesture` for the outer hit target,
/// not an outer `Button`. Nested buttons in SwiftUI have unreliable hit-test
/// behavior — the outer button swallows taps meant for the inner close.
@MainActor
struct AbilityAgentRow: View, Equatable {
    let session: AbilityAgentSession
    let branchSummary: String?
    let isSelected: Bool
    let tabManager: TabManager
    let contextMenuSnapshot: ActiveAgentWorkspaceContextMenuSnapshot?
    let onTap: () -> Void
    let onClose: () -> Void
    let onCollapse: () -> Void
    let elapsedLabel: (Date) -> String

    @State private var isHovering = false

    nonisolated static func == (lhs: AbilityAgentRow, rhs: AbilityAgentRow) -> Bool {
        lhs.session == rhs.session &&
            lhs.branchSummary == rhs.branchSummary &&
            lhs.isSelected == rhs.isSelected &&
            lhs.contextMenuSnapshot == rhs.contextMenuSnapshot
    }

    private var title: String {
        // Workspace title for system-starter sessions carries the specific
        // ability slug ("ability-creator: working-with-git") — much more
        // useful than the generic "Rule Creator" kind fallback when
        // multiple system starters are active at once.
        if let ws = AppDelegate.shared?.workspaceFor(tabId: session.workspaceId) {
            let custom = ws.customTitle?.trimmingCharacters(in: .whitespaces) ?? ""
            if !custom.isEmpty { return custom }
            if !ws.title.isEmpty { return ws.title }
        }
        switch session.kind {
        case .abilityCreator:
            return String(
                localized: "agents.panel.abilityCreator.title",
                defaultValue: "Rule Creator",
                table: "TermLoop"
            )
        case .abilityRefiner(let abilityId):
            let template = String(
                localized: "agents.panel.abilityRefiner.title",
                defaultValue: "Rule: %@",
                table: "TermLoop"
            )
            return String(format: template, abilityId)
        case .abilityDiscussion(let abilityId):
            let template = String(
                localized: "agents.panel.abilityDiscussion.title",
                defaultValue: "Rule Chat: %@",
                table: "TermLoop"
            )
            return String(format: template, abilityId)
        }
    }

    private var closeTooltip: String {
        String(
            localized: "agents.panel.close.tooltip",
            defaultValue: "Close agent session",
            table: "TermLoop"
        )
    }

    private var canCollapse: Bool {
        !session.isSystem && tabManager.tabs.contains(where: { $0.id == session.workspaceId })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Text("●")
                    .font(.system(size: 7))
                    .foregroundColor(.orange)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top, spacing: 6) {
                        Text(title)
                            .font(TermLoopSidebarTheme.bodyMonoStrong)
                            .foregroundStyle(Color.primary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 4)
                        if canCollapse {
                            Button(action: onCollapse) {
                                Image(systemName: "archivebox")
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundStyle(TermLoopSidebarTheme.dim)
                                    .padding(.horizontal, 2)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .opacity(isHovering ? 1 : 0.72)
                            .help(String(
                                localized: "agentRow.collapse.tooltip",
                                defaultValue: "Collapse and stop agent",
                                table: "TermLoop"
                            ))
                        }
                        if !session.isSystem && isHovering {
                            Button(action: onClose) {
                                    Image(systemName: "xmark")
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundStyle(TermLoopSidebarTheme.dim)
                                        .padding(.horizontal, 2)
                                        .contentShape(Rectangle())
                                }
                            .buttonStyle(.plain)
                            .help(closeTooltip)
                        }
                    }
                    HStack(spacing: 6) {
                        if let branchSummary, !branchSummary.isEmpty {
                            Text(branchSummary)
                                .font(TermLoopSidebarTheme.tinyMono)
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        if session.isSystem {
                            // Badge tagging system-starter-spawned sessions. These
                            // rows don't render a close button — the user asked for
                            // them to be permanently pinned in the Active Agents
                            // panel (AbilitiesPanel.startSystemCreatorAgent).
                            Text("SYS")
                                .font(TermLoopSidebarTheme.microCaps)
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                        }
                        Spacer(minLength: 4)
                        Text(elapsedLabel(session.spawnedAt))
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                    }
                }
            }
        }
        .padding(.horizontal, isSelected ? 8 : 7)
        .padding(.vertical, isSelected ? 6 : 5)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.16) : Color.orange.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(isSelected ? Color.accentColor.opacity(0.36) : Color.orange.opacity(0.18), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
        .onHover { isHovering = $0 }
        .contextMenu {
            if let snapshot = contextMenuSnapshot {
                ActiveAgentWorkspaceContextMenu(
                    snapshot: snapshot,
                    tabManager: tabManager
                )
            }
        }
    }
}
