// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct WorkspaceSessionReference: Equatable {
    let agentId: String
    let agentDisplayName: String
    let sessionId: String
    let cwd: String?
}

@MainActor
enum WorkspaceSessionReferenceResolver {
    static func resolve(for workspace: Workspace) -> WorkspaceSessionReference? {
        if let activity = TerminalAgentActivityStore.shared.state(forWorkspaceId: workspace.id),
           let live = makeReference(
               agentId: activity.agentId,
               sessionId: activity.sessionId,
               cwd: activity.cwd ?? normalized(workspace.currentDirectory)
           ) {
            return live
        }

        let metadata = WorkspaceMetadataStore.shared
        if let liveClaude = metadata.claudeSession(workspaceId: workspace.id.uuidString),
           let reference = makeReference(
               agentId: "claude",
               sessionId: liveClaude.sessionId,
               cwd: liveClaude.cwd ?? normalized(workspace.currentDirectory)
           ) {
            return reference
        }

        if let persistedAgent = metadata.persistedAgentSession(for: workspace.id),
           let reference = makeReference(
               agentId: persistedAgent.agentId,
               sessionId: persistedAgent.sessionId,
               cwd: persistedAgent.cwd ?? normalized(workspace.currentDirectory)
           ) {
            return reference
        }

        return nil
    }

    private static func makeReference(
        agentId: String,
        sessionId: String?,
        cwd: String?
    ) -> WorkspaceSessionReference? {
        let normalizedAgentId = normalized(agentId) ?? "claude"
        guard let normalizedSessionId = normalized(sessionId) else { return nil }
        let normalizedCwd = normalized(cwd)
        let displayName = TerminalAgentRegistry.shared.agent(id: normalizedAgentId)?.displayName
            ?? normalizedAgentId
        return WorkspaceSessionReference(
            agentId: normalizedAgentId,
            agentDisplayName: displayName,
            sessionId: normalizedSessionId,
            cwd: normalizedCwd
        )
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

@MainActor
enum WorkspaceTranscriptResolver {
    static func resolve(
        for sessionReference: WorkspaceSessionReference,
        scanner: ClaudeSessionScanner = .shared
    ) -> URL? {
        guard sessionReference.agentId == "claude" else { return nil }
        return scanner.sessionFileURL(
            sessionId: sessionReference.sessionId,
            cwd: sessionReference.cwd
        )
    }

    static func resolve(
        for workspace: Workspace,
        scanner: ClaudeSessionScanner = .shared
    ) -> URL? {
        guard let sessionReference = WorkspaceSessionReferenceResolver.resolve(for: workspace) else {
            return nil
        }
        return resolve(for: sessionReference, scanner: scanner)
    }
}

@MainActor
enum ConversationWorktreeMigrationResolver {
    static func request(for workspace: Workspace) -> NewWorkspaceWithWorktreeRequest? {
        guard WorkspaceMetadataStore.shared.branch(for: workspace) == nil else { return nil }
        guard let sessionReference = WorkspaceSessionReferenceResolver.resolve(for: workspace) else {
            return nil
        }
        guard TerminalAgentRunner.supportsResume(agentId: sessionReference.agentId) else {
            return nil
        }
        guard !TerminalAgentActivityStore.shared.isAgentRunning(
            forWorkspace: workspace,
            agentId: sessionReference.agentId
        ) else {
            return nil
        }

        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspace.id)
        guard let projectId = metadata.projectId ?? workspace.projectId else { return nil }

        return NewWorkspaceWithWorktreeRequest(
            projectId: projectId,
            terminalAgentId: sessionReference.agentId,
            sourceWorkspaceId: workspace.id,
            migrationSessionReference: sessionReference
        )
    }
}

/// Session-copy submenu rendered inside the workspace row context menu.
/// Deliberately does not expose the internal workspace UUID; only the
/// user-relevant agent session id/path can be copied from here.
struct CopyWorkspaceIdMenu: View {
    let workspace: Workspace

    private var sessionReference: WorkspaceSessionReference? {
        WorkspaceSessionReferenceResolver.resolve(for: workspace)
    }

    var body: some View {
        Menu(String(
            localized: "copyId.menu.title",
            defaultValue: "Copy Session",
            table: "TermLoop"
        )) {
            if let sessionReference {
                Button(String(
                    localized: "copyId.agentSessionId",
                    defaultValue: "\(sessionReference.agentDisplayName) Session ID",
                    table: "TermLoop"
                )) {
                    Self.copy(sessionReference.sessionId)
                }

                if sessionReference.agentId == "claude" {
                    Button(String(
                        localized: "copyId.agentSessionPath",
                        defaultValue: "\(sessionReference.agentDisplayName) Session Path",
                        table: "TermLoop"
                    )) {
                        guard let transcriptURL = WorkspaceTranscriptResolver.resolve(
                            for: sessionReference
                        ) else { return }
                        Self.copy(transcriptURL.path)
                    }
                }
            } else {
                Button(String(
                    localized: "copyId.sessionUnavailable",
                    defaultValue: "No Tracked Session",
                    table: "TermLoop"
                )) { }
                .disabled(true)
            }
        }
    }

    private static func copy(_ value: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(value, forType: .string)
    }
}
