// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Sidecar session snapshot written alongside upstream's `session-*.json` so
/// TermLoop-specific state (projects, workspace metadata) survives
/// restarts without mutating the upstream snapshot schema.
///
/// Visible workspace metadata is restored positionally. The upstream session
/// snapshot does not round-trip workspace UUIDs, so every relaunch remints
/// them; indexing by window/workspace position keeps visible restore stable.
/// Collapsed/hidden workspaces have no upstream tab to position against, so
/// those are persisted separately by their preserved metadata UUID.
struct TermLoopSessionSnapshot: Codable {
    var version: Int = 7
    var projects: [SessionProjectSnapshot] = []
    var activeProjectId: String?
    var openProjectIds: [String] = []
    /// Positional metadata. Outer index = window index (matches
    /// `AppSessionSnapshot.windows`), inner index = workspace index within
    /// that window's `SessionTabManagerSnapshot.workspaces`.
    var workspaceMetadataByPosition: [[WorkspaceMetadataStore.Metadata]]?
    /// Optional richer positional restore entries. This supplements
    /// `workspaceMetadataByPosition` with lightweight workspace fingerprint
    /// hints (title + cwd) so restart-time matching can recover when upstream
    /// remints the same window/workspace set in a different order.
    var workspaceRestoreStampsByPosition: [[WorkspaceRestoreStamp]]?
    /// Metadata for user-collapsed workspaces. These workspaces are fully
    /// removed from the upstream session snapshot, so positional restore would
    /// otherwise drop them on the next sidecar save/restart.
    var hiddenWorkspaceMetadataById: [String: WorkspaceMetadataStore.Metadata]?

    private enum CodingKeys: String, CodingKey {
        case version
        case projects
        case activeProjectId
        case openProjectIds
        case workspaceMetadataByPosition
        case workspaceRestoreStampsByPosition
        case hiddenWorkspaceMetadataById
    }

    init(
        version: Int = 7,
        projects: [SessionProjectSnapshot] = [],
        activeProjectId: String? = nil,
        openProjectIds: [String] = [],
        workspaceMetadataByPosition: [[WorkspaceMetadataStore.Metadata]]? = nil,
        workspaceRestoreStampsByPosition: [[WorkspaceRestoreStamp]]? = nil,
        hiddenWorkspaceMetadataById: [String: WorkspaceMetadataStore.Metadata]? = nil
    ) {
        self.version = version
        self.projects = projects
        self.activeProjectId = activeProjectId
        self.openProjectIds = openProjectIds
        self.workspaceMetadataByPosition = workspaceMetadataByPosition
        self.workspaceRestoreStampsByPosition = workspaceRestoreStampsByPosition
        self.hiddenWorkspaceMetadataById = hiddenWorkspaceMetadataById
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 7
        projects = try container.decodeIfPresent([SessionProjectSnapshot].self, forKey: .projects) ?? []
        activeProjectId = try container.decodeIfPresent(String.self, forKey: .activeProjectId)
        openProjectIds = try container.decodeIfPresent([String].self, forKey: .openProjectIds) ?? []
        workspaceMetadataByPosition = try container.decodeIfPresent(
            [[WorkspaceMetadataStore.Metadata]].self,
            forKey: .workspaceMetadataByPosition
        )
        workspaceRestoreStampsByPosition = try container.decodeIfPresent(
            [[WorkspaceRestoreStamp]].self,
            forKey: .workspaceRestoreStampsByPosition
        )
        hiddenWorkspaceMetadataById = try container.decodeIfPresent(
            [String: WorkspaceMetadataStore.Metadata].self,
            forKey: .hiddenWorkspaceMetadataById
        )
    }
}

struct WorkspaceRestoreStamp: Codable, Equatable {
    var metadata: WorkspaceMetadataStore.Metadata
    var processTitle: String
    var customTitle: String?
    var currentDirectory: String
    var termLoopRestoreId: UUID? = nil
}

/// Per-workspace agent session persisted to the TermLoop sidecar so relaunch
/// restore can resume the same CLI in the same directory.
struct PersistedAgentSession: Codable, Equatable {
    var agentId: String
    var sessionId: String
    var cwd: String?
    var updatedAt: Date?
}

extension TermLoopSessionSnapshot {
    /// Computes the sidecar path for a given upstream session file URL.
    /// Example: `.../termloop/session-com.termloop.json` ->
    /// `.../termloop/termloop-session-com.termloop.json`.
    static func sidecarURL(for sessionURL: URL) -> URL {
        let dir = sessionURL.deletingLastPathComponent()
        let base = sessionURL.deletingPathExtension().lastPathComponent
        return dir.appendingPathComponent("termloop-\(base).json")
    }
}
