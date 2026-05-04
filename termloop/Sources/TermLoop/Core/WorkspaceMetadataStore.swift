// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation
import SwiftUI

@MainActor
final class WorkspaceMetadataStore: ObservableObject {
    static let shared = WorkspaceMetadataStore()

    struct AssignedTicket: Equatable, Codable {
        var providerName: String
        var key: String
        var title: String?
    }

    struct Metadata: Equatable, Codable {
        var projectId: UUID?
        var branch: String?
        /// Physical checkout path for the bound branch. This is the
        /// authoritative worktree location once known; branch names are a
        /// logical identity and are not sufficient to reconstruct legacy or
        /// user-renamed or externally moved worktree folders.
        var worktreePath: String?
        /// Immutable HEAD commit recorded when this workspace attached to the
        /// current branch. Used to tell whether the worktree has diverged from
        /// its attach-time baseline even after the working tree becomes clean.
        var worktreeBaselineHead: String?
        /// When true, `TermLoopHooks.workspaceWillClose` skips the
        /// `on_workspace_close` agent prompt for this workspace. Toggled
        /// from the close dialog via "Don't ask again".
        var suppressAgentsOnClose: Bool?
        /// Terminal agent bound to this workspace. Required post-migration;
        /// nil only transiently during v3→v4 sidecar upgrade.
        var terminalAgentId: String?
        /// Permission mode the bound terminal agent was launched with.
        /// Stored as the `AgentTemplate.PermissionMode` raw value (e.g.
        /// "bypassPermissions", "plan", "acceptEdits", "default"). Nil for
        /// pre-feature workspaces — `TerminalAgentRunner` falls back to the
        /// agent's registry default in that case.
        var permissionMode: String?
        /// Persisted agent session used for relaunch restore. This is the
        /// only on-disk source for `resume` metadata (agent/session/cwd).
        var persistedAgentSession: PersistedAgentSession?
        /// Mobile can spawn a blank Claude workspace before Claude has written
        /// a resumable transcript. While this is true, observed session-start
        /// IDs stay live-only until a prompt or transcript proves resumability.
        var deferObservedAgentSessionPersistenceUntilPrompt: Bool?
        /// Unix epoch seconds when the workspace last entered "awaiting input"
        /// state from the agent. Nil means the workspace is not awaiting input.
        /// Used by the mobile quick-reply surface.
        var awaitingInputSince: Int?
        /// Short preview of the last agent message (≤1000 chars), surfaced on
        /// the mobile quick-reply triage list.
        var lastMessagePreview: String?
        /// Raw value of the last `TerminalAgentAttentionKind` recorded for
        /// this workspace (e.g. "completion", "notification", "permission",
        /// "userInput", "error"). Authoritative sticky input to the
        /// presentation reducer. Nil until a producer writes one.
        var lastAttentionKindRaw: String?
        /// Timestamp of the most recent user prompt submission routed to this
        /// workspace (hook `prompt-submit`). Used for Active Agents ordering
        /// so recently user-touched sessions float to the top.
        var lastUserPromptAt: Date?
        /// Tags the workspace as an TermLoop-spawned agent session. Nil for
        /// normal user workspaces. Paired atomically with `agentSpawnedAt`
        /// via `setAgentSession` / `clearAgentSession`.
        var agentKind: AgentWorkspaceKind?
        var agentSpawnedAt: Date?
        /// Persistent ability binding for an ability-owned agent workspace.
        /// Unlike `agentKind`, this survives workspace close so a later
        /// "Discuss" action can reopen and resume the prior session.
        var assignedAbilityId: String?
        /// Ticket binding for worktrees spawned from the Quick Action ticket
        /// picker. This lets sidebar surfaces group worktrees by ticket
        /// without re-querying the external provider.
        var assignedTicket: AssignedTicket?
        /// When true, the workspace stays functional/selectable but is omitted
        /// from the normal sidebar tree. Used for transient helper agents
        /// whose primary UI lives elsewhere (for example an Ask Codex bridge).
        var hideFromWorkspaceTree: Bool?
        /// True when this agent session was spawned from a System Starter
        /// "Agent" button. System sessions are non-dismissible in the
        /// Active Agents panel. Nil/false for user-spawned sessions.
        var isSystemAgent: Bool?
        /// Display title captured when collapsing/hiding a workspace. The live
        /// `Workspace` object is destroyed during collapse, so this preserves
        /// the row/window title for explicit restore. Nil for never-collapsed
        /// workspaces and cleared after restore.
        var collapsedDisplayTitle: String?
        /// True when the user has chosen to "Hide" this workspace. The
        /// workspace tab is closed (full Ghostty/MCP/PortScanner teardown)
        /// while metadata persists so it can be restored later from the
        /// sidebar "Hidden" list. Nil/false means normally visible.
        var isHidden: Bool?
        /// `ClaudeCredentialProfile.id` that the workspace was launched under.
        /// Stamped at launch by `ClaudeCredentialEnvResolver` and preferred
        /// over the project's current default at resume time so a workspace
        /// that started on "work" stays on "work" even if the project later
        /// flips to "personal". Nil for workspaces that did not opt in.
        var resolvedClaudeCredentialProfileId: String?
        /// Sticky bridge stamp. Cleared on bridge dismiss. Travels with the
        /// workspace metadata across restart-time UUID reminting so
        /// `WorkspaceBridgeStore.rebindAfterRestore` can find both endpoints.
        var bridgeMembership: BridgeMembership?
    }

    @Published private(set) var byWorkspaceId: [UUID: Metadata] = [:]

    /// Incremented only when a branch binding changes (attach/detach).
    /// Views that need branch state can subscribe to `$branchVersion`
    /// instead of the full `objectWillChange`, which also fires on
    /// ephemeral-session churn many times per second during active
    /// Claude turns and would dismiss any open NSMenu.
    @Published private(set) var branchVersion: Int = 0

    /// Incremented when a workspace ticket binding changes.
    @Published private(set) var ticketBindingVersion: Int = 0

    /// Incremented when a workspace moves into or out of a project scope.
    /// Sidebar project filters use this narrow signal instead of observing all
    /// metadata churn.
    @Published private(set) var projectScopeVersion: Int = 0

    /// Incremented only when agent-session role changes (set or clear).
    /// Narrow subscription channel for the sidebar's Active Agents panel
    /// and the upper-list filter — avoids re-rendering on ephemeral-session
    /// churn that fires the full `objectWillChange` many times per second
    /// during active Claude turns.
    @Published private(set) var agentSessionVersion: Int = 0

    /// Incremented whenever an ability-driven binding is written for any
    /// worktree. Lets the worktree panel subscribe to chip changes the
    /// same way it subscribes to link chip changes.
    @Published private(set) var reportedBindingsVersion: Int = 0

    /// Incremented only when `isHidden` flips for any workspace. Lets the
    /// WorktreeAgentsPanel's "Hidden" footer subscribe narrowly instead of
    /// re-rendering on every metadata write.
    @Published private(set) var hiddenVersion: Int = 0

    /// Incremented when a workspace's visible title changes. Sidebar panels
    /// use this narrow signal because `TabManager.tabs` does not republish
    /// when a referenced `Workspace` mutates its own `@Published` title.
    @Published private(set) var titleVersion: Int = 0

    /// Incremented whenever any presentation-relevant metadata field actually
    /// changes for a workspace (terminal agent id, persisted session,
    /// awaiting-input state, preview, attention kind, last prompt). Feeds
    /// `TerminalAgentActivityStore.markPresentationDirty(_:)` through a
    /// subscription, so consumers never observe this directly.
    @Published private(set) var agentPresentationVersion: Int = 0

    /// Per-workspace narrow signal paired with `agentPresentationVersion`.
    /// `TerminalAgentActivityStore` subscribes to this to mark the affected
    /// workspace dirty for the next coalesced presentation flush. Fires in
    /// addition to the global version bump; does not replace it.
    let agentPresentationDidChange = PassthroughSubject<UUID, Never>()

    private func bumpAgentPresentation(for id: UUID) {
        agentPresentationVersion &+= 1
        agentPresentationDidChange.send(id)
    }

    private var observedWorkspaceTitlesById: [UUID: String] = [:]

    func noteWorkspaceTitleDidChange(workspaceId: UUID, displayTitle: String) {
        guard observedWorkspaceTitlesById[workspaceId] != displayTitle else { return }
        observedWorkspaceTitlesById[workspaceId] = displayTitle
        titleVersion &+= 1
    }

    func forgetObservedWorkspaceTitle(workspaceId: UUID) {
        observedWorkspaceTitlesById.removeValue(forKey: workspaceId)
    }

    struct EphemeralClaudeSession: Equatable {
        let sessionId: String
        let cwd: String?
        let pid: pid_t?
        let startedAt: Date
    }

    /// Per-workspace active Claude Code session, populated by
    /// `cmux claude-hook session-start`, cleared on `session-end`. RAM-only
    /// for the *live* session (pid/startedAt only make sense for a running
    /// process). Persisted relaunch state lives separately in
    /// `Metadata.persistedAgentSession`.
    @Published private(set) var ephemeralClaudeSessions: [String: EphemeralClaudeSession] = [:]

    /// Reverse index: `sessionId → workspaceIdString`. Kept in sync with
    /// `ephemeralClaudeSessions` in `setClaudeSession` / `clearClaudeSession`
    /// so quick-reply hook lookups are O(1) instead of O(#workspaces).
    private var workspaceIdBySessionId: [String: String] = [:]

    private struct PendingNativeFork: Equatable {
        let agentId: String
        let parentSessionId: String
    }

    /// Transient fork-guard state for native same-agent conversation forks.
    /// While present, hook/session-start updates that repeat the parent
    /// session id are ignored until a child session id is observed.
    private var pendingNativeForkByWorkspaceId: [UUID: PendingNativeFork] = [:]

    private init() {}

    func metadata(for workspace: Workspace) -> Metadata {
        byWorkspaceId[workspace.id, default: Metadata()]
    }

    /// Id-based metadata reader used by hook handlers that only have a
    /// workspace UUID (no reconstructed `Workspace` object).
    func metadata(forWorkspaceId id: UUID) -> Metadata {
        byWorkspaceId[id, default: Metadata()]
    }

    /// True iff the store has a real metadata record for `id`. Distinct from
    /// `metadata(forWorkspaceId:)`, which auto-vivifies an empty struct for
    /// unknown ids.
    ///
    /// Note: this is *not* a workspace-liveness predicate — closed workspaces
    /// keep their metadata row for restore. Socket handlers that need to
    /// drop late callbacks for closed workspaces should use
    /// `AppDelegate.shared?.workspaceFor(tabId:)` instead.
    func hasMetadata(forWorkspaceId id: UUID) -> Bool {
        byWorkspaceId[id] != nil
    }

    /// Pure slice consumed by `TerminalAgentPresentationReducer`. Returns an
    /// empty snapshot for unknown workspace ids so the reducer still emits a
    /// deterministic result (nil presentation).
    func presentationSnapshot(forWorkspaceId id: UUID) -> TerminalAgentMetadataSnapshot {
        guard let meta = byWorkspaceId[id] else { return .empty }
        return TerminalAgentMetadataSnapshot(
            terminalAgentId: meta.terminalAgentId,
            persistedAgentSessionAgentId: meta.persistedAgentSession?.agentId,
            persistedAgentSessionUpdatedAt: meta.persistedAgentSession?.updatedAt,
            awaitingInputSince: meta.awaitingInputSince,
            lastMessagePreview: meta.lastMessagePreview,
            lastAttentionKindRaw: meta.lastAttentionKindRaw,
            lastUserPromptAt: meta.lastUserPromptAt
        )
    }

    func setProjectId(_ id: UUID?, for workspace: Workspace) {
        setProjectId(id, forWorkspaceId: workspace.id)
    }

    /// Id-based setter used by bridge validation tests and any other flow
    /// that has a workspace UUID but no reconstructed `Workspace` object.
    func setProjectId(_ id: UUID?, forWorkspaceId workspaceId: UUID) {
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        guard current.projectId != id else { return }
        current.projectId = id
        byWorkspaceId[workspaceId] = current
        projectScopeVersion &+= 1
    }

    func projectId(forWorkspaceId workspaceId: UUID) -> UUID? {
        byWorkspaceId[workspaceId]?.projectId
    }

    /// Workspace ids that belong to the given project. Used by
    /// `ProjectStore.setClaudeCredentialProfileId` to invalidate per-workspace
    /// credential stamps when the project's default account changes.
    func workspaceIds(inProject projectId: UUID) -> [UUID] {
        byWorkspaceId.compactMap { id, meta in
            meta.projectId == projectId ? id : nil
        }
    }

    func setBranch(_ branch: String?, for workspace: Workspace) {
        setBranch(branch, forWorkspaceId: workspace.id)
    }

    func setBranch(_ branch: String?, worktreePath: String?, for workspace: Workspace) {
        setBranch(branch, worktreePath: worktreePath, forWorkspaceId: workspace.id)
    }

    /// Id-based setter used by restore-time reconcilers that only have a
    /// UUID (no reconstructed `Workspace` object yet).
    func setBranch(_ branch: String?, forWorkspaceId id: UUID) {
        setBranchCore(branch, worktreePath: nil, hasExplicitWorktreePath: false, forWorkspaceId: id)
    }

    /// Id-based setter that records both the logical branch and the physical
    /// checkout location. Prefer this for every code path that already knows
    /// the worktree path from `git worktree list`, worktree creation, or a
    /// live workspace cwd.
    func setBranch(_ branch: String?, worktreePath: String?, forWorkspaceId id: UUID) {
        setBranchCore(branch, worktreePath: worktreePath, hasExplicitWorktreePath: true, forWorkspaceId: id)
    }

    private func setBranchCore(
        _ branch: String?,
        worktreePath: String?,
        hasExplicitWorktreePath: Bool,
        forWorkspaceId id: UUID
    ) {
        var current = byWorkspaceId[id, default: Metadata()]
        let normalized = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let newBranch = (normalized?.isEmpty ?? true) ? nil : normalized
        let newWorktreePath: String? = {
            guard newBranch != nil else { return nil }
            guard hasExplicitWorktreePath else {
                return current.branch == newBranch ? current.worktreePath : nil
            }
            return normalizeWorktreePath(worktreePath)
        }()
        let didChangeBranch = current.branch != newBranch
        let didChangeWorktreePath = current.worktreePath != newWorktreePath
        guard didChangeBranch || didChangeWorktreePath else { return }
        let didClearAssignedTicket = didChangeBranch && current.assignedTicket != nil
        current.branch = newBranch
        current.worktreePath = newWorktreePath
        current.worktreeBaselineHead = nil
        if didChangeBranch {
            current.assignedTicket = nil
        }
        byWorkspaceId[id] = current
        branchVersion &+= 1
        if didClearAssignedTicket {
            ticketBindingVersion &+= 1
        }
    }

    /// Read-only snapshot of every workspace id + its recorded branch/path.
    /// Empty `branch` entries are excluded. Used by startup reconciliation
    /// to walk attached workspaces without needing `Workspace` objects.
    func branchBindings() -> [(workspaceId: UUID, projectId: UUID?, branch: String, worktreePath: String?)] {
        byWorkspaceId.compactMap { (id, meta) in
            guard let branch = meta.branch else { return nil }
            return (id, meta.projectId, branch, meta.worktreePath)
        }
    }

    func branch(for workspace: Workspace) -> String? {
        byWorkspaceId[workspace.id]?.branch
    }

    func worktreePath(for workspace: Workspace) -> String? {
        byWorkspaceId[workspace.id]?.worktreePath
    }

    func worktreePath(forWorkspaceId id: UUID) -> String? {
        byWorkspaceId[id]?.worktreePath
    }

    func worktreeBaselineHead(for workspace: Workspace) -> String? {
        byWorkspaceId[workspace.id]?.worktreeBaselineHead
    }

    func setWorktreeBaselineHead(_ head: String?, forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        let normalized = head?.trimmingCharacters(in: .whitespacesAndNewlines)
        let newValue = (normalized?.isEmpty ?? true) ? nil : normalized
        guard current.worktreeBaselineHead != newValue else { return }
        current.worktreeBaselineHead = newValue
        byWorkspaceId[id] = current
    }

    /// Returns workspace ids whose branch matches. Pass `projectId: nil`
    /// for callers that don't have one (e.g. a Claude session launched
    /// from a generic terminal where `setProjectId` was never invoked).
    func workspaceIds(withBranch branch: String, projectId: UUID? = nil) -> [UUID] {
        byWorkspaceId.compactMap { (wsId, meta) in
            guard meta.branch == branch else { return nil }
            if let projectId, meta.projectId != projectId { return nil }
            return wsId
        }
    }

    func removeMetadata(for workspace: Workspace) {
        let removed = byWorkspaceId.removeValue(forKey: workspace.id)
        pendingNativeForkByWorkspaceId.removeValue(forKey: workspace.id)
        if removed?.projectId != nil {
            projectScopeVersion &+= 1
        }
    }

    /// UUID-keyed removal for flows whose live `Workspace` object is gone
    /// (for example, the unhide path which purges the stale id after the
    /// metadata has been re-keyed onto a fresh workspace).
    @discardableResult
    func removeMetadataForId(_ id: UUID) -> Bool {
        pendingNativeForkByWorkspaceId.removeValue(forKey: id)
        guard let removed = byWorkspaceId.removeValue(forKey: id) else { return false }
        if removed.projectId != nil {
            projectScopeVersion &+= 1
        }
        if removed.isHidden == true {
            hiddenVersion &+= 1
        }
        return true
    }

    func terminalAgentId(for workspaceId: UUID) -> String? {
        byWorkspaceId[workspaceId]?.terminalAgentId
    }

    @discardableResult
    func setTerminalAgentId(_ id: String?, for workspaceId: UUID) -> Bool {
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        guard current.terminalAgentId != id else { return false }
        current.terminalAgentId = id
        byWorkspaceId[workspaceId] = current
        bumpAgentPresentation(for: workspaceId)
        return true
    }

    func assignedTicket(for workspaceId: UUID) -> AssignedTicket? {
        byWorkspaceId[workspaceId]?.assignedTicket
    }

    func assignedTicket(for workspace: Workspace) -> AssignedTicket? {
        byWorkspaceId[workspace.id]?.assignedTicket
    }

    func setAssignedTicket(_ ticket: AssignedTicket?, for workspace: Workspace) {
        setAssignedTicket(ticket, forWorkspaceId: workspace.id)
    }

    func setAssignedTicket(_ ticket: AssignedTicket?, forWorkspaceId workspaceId: UUID) {
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        guard current.assignedTicket != ticket else { return }
        current.assignedTicket = ticket
        byWorkspaceId[workspaceId] = current
        ticketBindingVersion &+= 1
    }

    func permissionMode(for workspaceId: UUID) -> String? {
        byWorkspaceId[workspaceId]?.permissionMode
    }

    func resolvedClaudeCredentialProfileId(for workspaceId: UUID) -> String? {
        byWorkspaceId[workspaceId]?.resolvedClaudeCredentialProfileId
    }

    func setResolvedClaudeCredentialProfileId(_ profileId: String?, for workspaceId: UUID) {
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        let normalized = profileId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let newValue = (normalized?.isEmpty ?? true) ? nil : normalized
        guard current.resolvedClaudeCredentialProfileId != newValue else { return }
        current.resolvedClaudeCredentialProfileId = newValue
        byWorkspaceId[workspaceId] = current
    }

    func setPermissionMode(_ mode: String?, for workspaceId: UUID) {
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        let normalized = mode?.trimmingCharacters(in: .whitespacesAndNewlines)
        let newValue = (normalized?.isEmpty ?? true) ? nil : normalized
        guard current.permissionMode != newValue else { return }
        current.permissionMode = newValue
        byWorkspaceId[workspaceId] = current
    }

    func restoreMetadata(_ metadata: Metadata, forWorkspaceId workspaceId: UUID) {
        let previous = byWorkspaceId[workspaceId]
        guard previous != metadata else { return }
        byWorkspaceId[workspaceId] = metadata
        if previous?.projectId != metadata.projectId {
            projectScopeVersion &+= 1
        }
        if previous?.branch != metadata.branch || previous?.worktreePath != metadata.worktreePath {
            branchVersion &+= 1
        }
        if previous?.assignedTicket != metadata.assignedTicket {
            ticketBindingVersion &+= 1
        }
        let previousAgentSession =
            previous?.agentKind != nil
            || previous?.agentSpawnedAt != nil
            || previous?.hideFromWorkspaceTree != nil
            || previous?.isSystemAgent != nil
        let nextAgentSession =
            metadata.agentKind != nil
            || metadata.agentSpawnedAt != nil
            || metadata.hideFromWorkspaceTree != nil
            || metadata.isSystemAgent != nil
        if previousAgentSession != nextAgentSession
            || previous?.agentKind != metadata.agentKind
            || previous?.agentSpawnedAt != metadata.agentSpawnedAt
            || previous?.hideFromWorkspaceTree != metadata.hideFromWorkspaceTree
            || previous?.isSystemAgent != metadata.isSystemAgent {
            agentSessionVersion &+= 1
        }
        if previous?.isHidden != metadata.isHidden {
            hiddenVersion &+= 1
        }
        let presentationChanged =
            previous?.terminalAgentId != metadata.terminalAgentId
            || previous?.persistedAgentSession != metadata.persistedAgentSession
            || previous?.awaitingInputSince != metadata.awaitingInputSince
            || previous?.lastMessagePreview != metadata.lastMessagePreview
            || previous?.lastAttentionKindRaw != metadata.lastAttentionKindRaw
            || previous?.lastUserPromptAt != metadata.lastUserPromptAt
        if presentationChanged {
            bumpAgentPresentation(for: workspaceId)
        }
    }

    func persistedAgentSession(for workspaceId: UUID) -> PersistedAgentSession? {
        byWorkspaceId[workspaceId]?.persistedAgentSession
    }

    @discardableResult
    func setPersistedAgentSession(
        agentId: String,
        sessionId: String,
        cwd: String?,
        updatedAt: Date = Date(),
        for workspaceId: UUID
    ) -> Bool {
        let normalizedAgentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedCwd = normalizePath(cwd)
        guard !normalizedAgentId.isEmpty, !normalizedSessionId.isEmpty else { return false }
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        let prior = current.persistedAgentSession
        let effectiveCwd: String? = {
            guard let prior,
                  prior.agentId == normalizedAgentId,
                  prior.sessionId == normalizedSessionId,
                  normalizedCwd == nil else {
                return normalizedCwd
            }
            return prior.cwd
        }()
        let next = PersistedAgentSession(
            agentId: normalizedAgentId,
            sessionId: normalizedSessionId,
            cwd: effectiveCwd,
            updatedAt: updatedAt
        )
        if let prior,
           prior.agentId == next.agentId,
           prior.sessionId == next.sessionId,
           prior.cwd == next.cwd,
           current.deferObservedAgentSessionPersistenceUntilPrompt == nil {
            return false
        }
        current.persistedAgentSession = next
        current.deferObservedAgentSessionPersistenceUntilPrompt = nil
        byWorkspaceId[workspaceId] = current
        bumpAgentPresentation(for: workspaceId)
        return true
    }

    @discardableResult
    func setPersistedAgentSession(
        _ session: PersistedAgentSession?,
        for workspaceId: UUID
    ) -> Bool {
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        guard current.persistedAgentSession != session
            || current.deferObservedAgentSessionPersistenceUntilPrompt != nil else {
            return false
        }
        current.persistedAgentSession = session
        current.deferObservedAgentSessionPersistenceUntilPrompt = nil
        byWorkspaceId[workspaceId] = current
        bumpAgentPresentation(for: workspaceId)
        return true
    }

    @discardableResult
    func clearPersistedAgentSession(for workspaceId: UUID) -> Bool {
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        guard current.persistedAgentSession != nil
            || current.deferObservedAgentSessionPersistenceUntilPrompt != nil else {
            return false
        }
        current.persistedAgentSession = nil
        current.deferObservedAgentSessionPersistenceUntilPrompt = nil
        byWorkspaceId[workspaceId] = current
        pendingNativeForkByWorkspaceId.removeValue(forKey: workspaceId)
        bumpAgentPresentation(for: workspaceId)
        return true
    }

    func shouldDeferObservedAgentSessionPersistenceUntilPrompt(
        forWorkspaceId workspaceId: UUID
    ) -> Bool {
        byWorkspaceId[workspaceId]?.deferObservedAgentSessionPersistenceUntilPrompt == true
    }

    @discardableResult
    func setDeferObservedAgentSessionPersistenceUntilPrompt(
        _ deferPersistence: Bool,
        forWorkspaceId workspaceId: UUID
    ) -> Bool {
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        let next: Bool? = deferPersistence ? true : nil
        guard current.deferObservedAgentSessionPersistenceUntilPrompt != next else {
            return false
        }
        current.deferObservedAgentSessionPersistenceUntilPrompt = next
        byWorkspaceId[workspaceId] = current
        return true
    }

    func beginPendingNativeFork(
        agentId: String,
        parentSessionId: String,
        forWorkspaceId workspaceId: UUID
    ) {
        let normalizedAgentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSessionId = parentSessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedAgentId.isEmpty, !normalizedSessionId.isEmpty else { return }
        pendingNativeForkByWorkspaceId[workspaceId] = PendingNativeFork(
            agentId: normalizedAgentId,
            parentSessionId: normalizedSessionId
        )
    }

    func clearPendingNativeFork(forWorkspaceId workspaceId: UUID) {
        pendingNativeForkByWorkspaceId.removeValue(forKey: workspaceId)
    }

    func pendingNativeFork(forWorkspaceId workspaceId: UUID) -> (agentId: String, parentSessionId: String)? {
        guard let pending = pendingNativeForkByWorkspaceId[workspaceId] else { return nil }
        return (pending.agentId, pending.parentSessionId)
    }

    /// Filters observed session ids during a native fork. Repeated reports of
    /// the parent session are ignored until the child session id arrives.
    func acceptedObservedSessionId(
        agentId: String,
        sessionId: String?,
        forWorkspaceId workspaceId: UUID
    ) -> String? {
        let normalizedAgentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSessionId = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let normalizedSessionId, !normalizedSessionId.isEmpty else { return nil }
        guard let pending = pendingNativeForkByWorkspaceId[workspaceId] else {
            return normalizedSessionId
        }
        if pending.agentId != normalizedAgentId {
            pendingNativeForkByWorkspaceId.removeValue(forKey: workspaceId)
            return normalizedSessionId
        }
        if pending.parentSessionId == normalizedSessionId {
            return nil
        }
        pendingNativeForkByWorkspaceId.removeValue(forKey: workspaceId)
        return normalizedSessionId
    }

    @discardableResult
    func movePersistedAgentSession(for workspaceId: UUID, toCwd: String?) -> Bool {
        guard let prior = persistedAgentSession(for: workspaceId) else { return false }
        let normalizedCwd = normalizePath(toCwd)
        guard prior.cwd != normalizedCwd else { return false }
        return setPersistedAgentSession(
            PersistedAgentSession(
                agentId: prior.agentId,
                sessionId: prior.sessionId,
                cwd: normalizedCwd,
                updatedAt: Date()
            ),
            for: workspaceId
        )
    }

    func agentKind(forWorkspaceId id: UUID) -> AgentWorkspaceKind? {
        byWorkspaceId[id]?.agentKind
    }

    func agentSpawnedAt(forWorkspaceId id: UUID) -> Date? {
        byWorkspaceId[id]?.agentSpawnedAt
    }

    func isAbilityAgent(workspaceId id: UUID) -> Bool {
        byWorkspaceId[id]?.agentKind != nil
    }

    func isHiddenFromWorkspaceTree(workspaceId id: UUID) -> Bool {
        byWorkspaceId[id]?.hideFromWorkspaceTree == true
    }

    /// Composite view of an agent session. Returns nil for normal workspaces.
    /// Saves callers from reading `agentKind` and `agentSpawnedAt` separately
    /// and keeps the (kind, spawnedAt) atomicity visible at the type level.
    func abilitySession(forWorkspaceId id: UUID) -> AbilityAgentSession? {
        guard let meta = byWorkspaceId[id],
              let kind = meta.agentKind,
              let spawnedAt = meta.agentSpawnedAt else { return nil }
        return AbilityAgentSession(
            workspaceId: id,
            kind: kind,
            spawnedAt: spawnedAt,
            isSystem: meta.isSystemAgent ?? false
        )
    }

    func setAgentSession(
        kind: AgentWorkspaceKind,
        spawnedAt: Date,
        isSystem: Bool = false,
        forWorkspaceId id: UUID
    ) {
        var current = byWorkspaceId[id, default: Metadata()]
        let systemFlag: Bool? = isSystem ? true : nil
        let unchanged =
            current.agentKind == kind
            && current.agentSpawnedAt == spawnedAt
            && current.isSystemAgent == systemFlag
        guard !unchanged else { return }
        current.agentKind = kind
        current.agentSpawnedAt = spawnedAt
        if let abilityId = kind.abilityId {
            current.assignedAbilityId = abilityId
        }
        current.isSystemAgent = systemFlag
        byWorkspaceId[id] = current
        agentSessionVersion &+= 1
    }

    func clearAgentSession(forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        let hadAnything = current.agentKind != nil
            || current.agentSpawnedAt != nil
            || current.hideFromWorkspaceTree != nil
            || current.isSystemAgent != nil
        guard hadAnything else { return }
        current.agentKind = nil
        current.agentSpawnedAt = nil
        current.hideFromWorkspaceTree = nil
        current.isSystemAgent = nil
        byWorkspaceId[id] = current
        agentSessionVersion &+= 1
    }

    func isHidden(forWorkspaceId id: UUID) -> Bool {
        byWorkspaceId[id]?.isHidden == true
    }

    func setCollapsedDisplayTitle(_ title: String?, forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = (trimmed?.isEmpty ?? true) ? nil : trimmed
        guard current.collapsedDisplayTitle != normalized else { return }
        current.collapsedDisplayTitle = normalized
        byWorkspaceId[id] = current
    }

    @discardableResult
    func setHidden(_ hidden: Bool, forWorkspaceId id: UUID) -> Bool {
        var current = byWorkspaceId[id, default: Metadata()]
        let newValue: Bool? = hidden ? true : nil
        guard current.isHidden != newValue else { return false }
        current.isHidden = newValue
        byWorkspaceId[id] = current
        hiddenVersion &+= 1
        return true
    }

    /// Snapshot of every workspace id currently flagged `isHidden`, paired
    /// with its full metadata. Used by the sidebar's "Hidden" footer which
    /// must list workspaces that no longer have a live tab.
    func hiddenWorkspaces() -> [(id: UUID, metadata: Metadata)] {
        byWorkspaceId.compactMap { pair in
            pair.value.isHidden == true ? (pair.key, pair.value) : nil
        }
    }

    func setHideFromWorkspaceTree(_ hidden: Bool, forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        let newValue: Bool? = hidden ? true : nil
        guard current.hideFromWorkspaceTree != newValue else { return }
        current.hideFromWorkspaceTree = newValue
        byWorkspaceId[id] = current
        agentSessionVersion &+= 1
    }

    func setBridgeMembership(_ value: BridgeMembership?, forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        guard current.bridgeMembership != value else { return }
        current.bridgeMembership = value
        byWorkspaceId[id] = current
        agentSessionVersion &+= 1
    }

    /// Sets or clears the "awaiting input since" epoch timestamp for the
    /// given workspace. Nil means the workspace is no longer awaiting input.
    func setAwaitingInputSince(_ value: Int?, forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        guard current.awaitingInputSince != value else { return }
        current.awaitingInputSince = value
        byWorkspaceId[id] = current
        bumpAgentPresentation(for: id)
    }

    func setLastMessagePreview(_ value: String?, forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        guard current.lastMessagePreview != value else { return }
        current.lastMessagePreview = value
        byWorkspaceId[id] = current
        bumpAgentPresentation(for: id)
    }

    /// Ability-driven binding setter. Takes a workspace id, resolves the
    /// reported-state path internally (binding storage is path-keyed because a
    /// binding belongs to the checkout/cwd, not the workspace UUID).
    /// Pass `nil` to clear.
    ///
    /// Returns an outcome the socket handler can map to its response: this is
    /// the only safe place to dedupe, because every caller that bumps the
    /// version drives a panel rebuild for every workspace in the snapshot.
    @discardableResult
    func setReportedBinding(
        _ value: AgentReportedStateStore.AgentReportedBinding?,
        abilityId: String,
        bindingId: String,
        forWorkspaceId id: UUID,
        fallbackPath: String? = nil
    ) -> ReportedBindingOutcome {
        guard let path = reportedStatePath(forWorkspaceId: id, fallbackPath: fallbackPath) else {
            return .noWorktree
        }
        let prior = AgentReportedStateStore.shared.binding(
            abilityId: abilityId,
            bindingId: bindingId,
            forPath: path
        )
        guard !AgentReportedStateStore.AgentReportedBinding
            .sameMaterial(prior, value) else { return .noChange }
        AgentReportedStateStore.shared.setBinding(
            value,
            abilityId: abilityId,
            bindingId: bindingId,
            forPath: path
        )
        reportedBindingsVersion &+= 1
        bumpAgentPresentation(for: id)
        return .wrote
    }

    enum ReportedBindingOutcome {
        case wrote
        case noChange
        case noWorktree
    }

    /// Atomic full-replace of every reported binding under one ability for
    /// this workspace's worktree. Bindings in `values` are written; existing
    /// bindings under `abilityId` not in `values` are cleared. Used by the
    /// `set_run_targets` MCP tool: agent re-publishes its full state each
    /// call, so anything dropped from the array disappears from the chip.
    @discardableResult
    func replaceReportedBindings(
        underAbilityId abilityId: String,
        with values: [AgentReportedStateStore.AgentReportedBinding],
        forWorkspaceId id: UUID,
        fallbackPath: String? = nil
    ) -> ReportedBindingOutcome {
        guard let path = reportedStatePath(forWorkspaceId: id, fallbackPath: fallbackPath) else {
            return .noWorktree
        }
        let didChange = AgentReportedStateStore.shared.replaceBindings(
            underAbilityId: abilityId,
            with: values,
            forPath: path
        )
        guard didChange else { return .noChange }
        reportedBindingsVersion &+= 1
        bumpAgentPresentation(for: id)
        return .wrote
    }

    func copyReportedBindingsIfNeeded(
        fromPath sourcePath: String?,
        toPath destinationPath: String,
        forWorkspaceId id: UUID
    ) {
        guard let sourcePath = canonicalReportedPath(sourcePath),
              let destinationPath = canonicalReportedPath(destinationPath),
              sourcePath != destinationPath else { return }
        guard AgentReportedStateStore.shared.copyMissingBindings(
            fromPath: sourcePath,
            toPath: destinationPath
        ) else { return }
        reportedBindingsVersion &+= 1
        bumpAgentPresentation(for: id)
    }

    func setLastUserPromptAt(_ value: Date?, forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        guard current.lastUserPromptAt != value else { return }
        current.lastUserPromptAt = value
        byWorkspaceId[id] = current
        bumpAgentPresentation(for: id)
    }

    /// Authoritative sticky input for the presentation reducer. Stored as
    /// the raw value of `TerminalAgentAttentionKind`.
    func setLastAttentionKindRaw(_ value: String?, forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        let newValue = (normalized?.isEmpty ?? true) ? nil : normalized
        guard current.lastAttentionKindRaw != newValue else { return }
        current.lastAttentionKindRaw = newValue
        byWorkspaceId[id] = current
        bumpAgentPresentation(for: id)
    }

    /// Atomically writes all attention-state fields in one dictionary mutation.
    func setAttentionState(
        since: Int,
        preview: String,
        attentionKind: TerminalAgentAttentionKind?,
        forWorkspaceId id: UUID
    ) {
        var current = byWorkspaceId[id, default: Metadata()]
        let kindRaw = attentionKind?.rawValue
        guard current.awaitingInputSince != since
           || current.lastMessagePreview != preview
           || current.lastAttentionKindRaw != kindRaw else { return }
        current.awaitingInputSince = since
        current.lastMessagePreview = preview
        current.lastAttentionKindRaw = kindRaw
        byWorkspaceId[id] = current
        bumpAgentPresentation(for: id)
    }

    /// Atomically clears all attention-state fields.
    func clearAttentionState(forWorkspaceId id: UUID) {
        var current = byWorkspaceId[id, default: Metadata()]
        guard current.awaitingInputSince != nil
           || current.lastMessagePreview != nil
           || current.lastAttentionKindRaw != nil else { return }
        current.awaitingInputSince = nil
        current.lastMessagePreview = nil
        current.lastAttentionKindRaw = nil
        byWorkspaceId[id] = current
        bumpAgentPresentation(for: id)
    }

    /// Reads the per-workspace "don't prompt for on_workspace_close agents"
    /// flag. Missing entries default to `false`.
    func suppressAgentsOnClose(_ workspaceId: UUID) -> Bool {
        byWorkspaceId[workspaceId]?.suppressAgentsOnClose ?? false
    }

    /// Writes the per-workspace "don't prompt for on_workspace_close agents"
    /// flag; the change is persisted the next time the sidecar snapshot
    /// writes.
    func setSuppressAgentsOnClose(_ workspaceId: UUID, _ value: Bool) {
        var current = byWorkspaceId[workspaceId, default: Metadata()]
        let normalized: Bool? = value ? true : nil
        guard current.suppressAgentsOnClose != normalized else { return }
        current.suppressAgentsOnClose = normalized
        byWorkspaceId[workspaceId] = current
    }

    func setClaudeSession(workspaceId: String, sessionId: String, cwd: String?, pid: pid_t? = nil) {
        let trimmed = workspaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let normalizedCwd = normalizePath(cwd)
        let normalizedPid: pid_t? = pid.flatMap { $0 > 0 ? $0 : nil }
        if let prior = ephemeralClaudeSessions[trimmed] {
            workspaceIdBySessionId.removeValue(forKey: prior.sessionId)
        }
        ephemeralClaudeSessions[trimmed] = EphemeralClaudeSession(
            sessionId: sessionId,
            cwd: normalizedCwd,
            pid: normalizedPid,
            startedAt: Date()
        )
        workspaceIdBySessionId[sessionId] = trimmed
    }

    func clearClaudeSession(workspaceId: String) {
        let trimmed = workspaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if let prior = ephemeralClaudeSessions.removeValue(forKey: trimmed) {
            workspaceIdBySessionId.removeValue(forKey: prior.sessionId)
        }
    }

    func moveClaudeSession(workspaceId: String, toCwd: String?) {
        let trimmed = workspaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let prior = ephemeralClaudeSessions[trimmed] else { return }
        let normalizedCwd = normalizePath(toCwd)
        guard prior.cwd != normalizedCwd else { return }
        ephemeralClaudeSessions[trimmed] = EphemeralClaudeSession(
            sessionId: prior.sessionId,
            cwd: normalizedCwd,
            pid: prior.pid,
            startedAt: prior.startedAt
        )
    }

    func claudeSession(workspaceId: String) -> EphemeralClaudeSession? {
        ephemeralClaudeSessions[workspaceId.trimmingCharacters(in: .whitespacesAndNewlines)]
    }

    /// Reverse-lookup: given a Claude session ID, return the workspace UUID
    /// that currently owns it. O(1) via `workspaceIdBySessionId` reverse
    /// index maintained in `setClaudeSession` / `clearClaudeSession`.
    func workspaceIdForClaudeSession(sessionId: String) -> UUID? {
        let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let wsIdStr = workspaceIdBySessionId[trimmed] else { return nil }
        return UUID(uuidString: wsIdStr)
    }

    func snapshot() -> [String: Metadata] {
        Dictionary(uniqueKeysWithValues: byWorkspaceId.map { ($0.key.uuidString, $0.value) })
    }

    func restore(_ data: [String: Metadata]) {
        byWorkspaceId = Dictionary(uniqueKeysWithValues: data.compactMap { pair in
            guard let id = UUID(uuidString: pair.key) else { return nil }
            return (id, pair.value)
        })
        ephemeralClaudeSessions = [:]
        workspaceIdBySessionId = [:]
        pendingNativeForkByWorkspaceId = [:]
    }

    func reassignProject(from oldId: UUID, to newId: UUID?) {
        for (wsId, meta) in byWorkspaceId where meta.projectId == oldId {
            var updated = meta
            updated.projectId = newId
            byWorkspaceId[wsId] = updated
        }
    }

    private func normalizePath(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func normalizeWorktreePath(_ value: String?) -> String? {
        guard let trimmed = normalizePath(value) else { return nil }
        return URL(fileURLWithPath: trimmed).standardizedFileURL.path
    }

    // MARK: - Worktree-scoped reported state

    /// Canonical (symlink-resolved) physical checkout path for the workspace's
    /// bound branch. Reads `Metadata.worktreePath` (persisted by
    /// `WorktreeCoordinator.attach`/`detach`) only when the workspace still has
    /// a branch binding, then applies filesystem-level symlink resolution so
    /// the value matches the canonical key the reported-state store writes
    /// under.
    ///
    /// Pure dictionary lookup + a `realpath()` syscall — no git, no
    /// subprocess, safe to call from SwiftUI body. Workspaces without a
    /// persisted branch + `worktreePath` (pre-attach, generic-shell, or
    /// fork-target before bind) return nil; their reported-state slot stays
    /// unhydrated unless a caller supplies a live cwd fallback through
    /// `reportedStatePath(forWorkspaceId:fallbackPath:)`.
    func worktreeRootPath(forWorkspaceId id: UUID) -> String? {
        guard let meta = byWorkspaceId[id],
              let branch = meta.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
              !branch.isEmpty,
              let raw = meta.worktreePath,
              !raw.isEmpty else { return nil }
        return canonicalReportedPath(raw)
    }

    /// Path key for ability-reported state. Prefer the stored worktree path
    /// when TermLoop owns one; otherwise use a caller-supplied live cwd /
    /// presentation cwd so normal project-root sessions can still surface
    /// run-target and ticket chips.
    func reportedStatePath(forWorkspaceId id: UUID, fallbackPath: String? = nil) -> String? {
        if let path = worktreeRootPath(forWorkspaceId: id) {
            return path
        }
        return canonicalReportedPath(fallbackPath)
    }

    /// Reverse lookup: find the workspace whose canonical worktree root
    /// equals or is an ancestor of `cwd`. Powers MCP fallbacks where the
    /// agent process didn't inherit `TERMLOOP_WORKSPACE_ID` (e.g. user
    /// launched Claude Code from a plain login shell that just `cd`-ed
    /// into a worktree). Picks the longest matching worktree root so a
    /// nested worktree wins over its parent.
    func workspaceId(forCwd cwd: String) -> UUID? {
        let normalized = URL(fileURLWithPath: cwd).resolvingSymlinksInPath().path
        guard !normalized.isEmpty else { return nil }
        var best: (id: UUID, length: Int)?
        for (id, meta) in byWorkspaceId {
            guard let branch = meta.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !branch.isEmpty,
                  let raw = meta.worktreePath,
                  !raw.isEmpty else { continue }
            let root = URL(fileURLWithPath: raw).resolvingSymlinksInPath().path
            guard !root.isEmpty else { continue }
            let inside = normalized == root || normalized.hasPrefix(root + "/")
            guard inside else { continue }
            if best == nil || root.count > best!.length {
                best = (id, root.count)
            }
        }
        return best?.id
    }

    private func canonicalReportedPath(_ value: String?) -> String? {
        guard let raw = normalizePath(value) else { return nil }
        return URL(fileURLWithPath: raw).resolvingSymlinksInPath().path
    }

}

@MainActor
enum TerminalAgentSessionPersistencePolicy {
    static func shouldPersistObservedSession(
        workspaceId: UUID,
        agentId: String,
        sessionId: String?,
        cwd: String?,
        userPromptSubmitted: Bool,
        claudeScanner: ClaudeSessionScanner = .shared
    ) -> Bool {
        let normalizedAgentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedAgentId == TerminalAgent.claudeId else {
            return true
        }
        guard WorkspaceMetadataStore.shared
            .shouldDeferObservedAgentSessionPersistenceUntilPrompt(forWorkspaceId: workspaceId) else {
            return true
        }
        guard let normalizedSessionId = sessionId?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !normalizedSessionId.isEmpty else {
            return false
        }
        if userPromptSubmitted {
            return true
        }
        return claudeScanner.sessionFileURL(sessionId: normalizedSessionId, cwd: cwd) != nil
    }

    static func clearDeferredPersistenceIfNeeded(workspaceId: UUID, agentId: String) {
        let normalizedAgentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedAgentId == TerminalAgent.claudeId else { return }
        _ = WorkspaceMetadataStore.shared
            .setDeferObservedAgentSessionPersistenceUntilPrompt(false, forWorkspaceId: workspaceId)
    }
}
