// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
enum ForkHandoffPromptDefaults {
    static let defaultTemplateBody: String = {
        let fmt = String(
            localized: "forkHandoff.handoffTemplate",
            defaultValue: """
                I was working with %@ on this project. My previous session log is at:

                    %@

                Read it to understand what I was doing, then continue.

                ---

                """,
            table: "TermLoop"
        )
        return String(format: fmt, "{{agent_display_name}}", "{{session_jsonl_path}}")
    }()

    static func templateBody(agentDisplayName: String, transcriptPath: String) -> String {
        let projectFolderPath = ProjectStore.shared.activeProjectId.flatMap { ProjectStore.shared.project(id: $0)?.folderPath }
        let template = AgentPromptStore.body(
            id: AgentPromptStore.forkHandoffDocumentID,
            projectFolderPath: projectFolderPath
        ) ?? defaultTemplateBody
        return AgentPromptStore.render(
            template: template,
            replacements: [
                "agent_display_name": agentDisplayName,
                "session_jsonl_path": transcriptPath
            ]
        )
    }

    static func prompt(for source: Workspace?) -> String {
        guard let source else { return "" }
        guard let sessionReference = WorkspaceSessionReferenceResolver.resolve(for: source),
              sessionReference.agentId == "claude",
              let jsonl = WorkspaceTranscriptResolver.resolve(for: sessionReference)
        else { return "" }
        return templateBody(
            agentDisplayName: sessionReference.agentDisplayName,
            transcriptPath: jsonl.path
        )
    }
}
