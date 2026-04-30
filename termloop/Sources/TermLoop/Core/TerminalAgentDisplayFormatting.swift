// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
enum TerminalAgentDisplayFormatter {
    static func presentation(
        forPhase phase: TerminalAgentActivityPhase,
        attentionKind: TerminalAgentAttentionKind?
    ) -> TerminalAgentDisplayPresentation {
        presentation(
            for: TerminalAgentPresentationReducer.mapDisplayState(
                phase: phase,
                attentionKind: attentionKind
            )
        )
    }

    static func presentation(for displayState: TerminalAgentDisplayState) -> TerminalAgentDisplayPresentation {
        TerminalAgentDisplayPresentation(
            state: displayState,
            label: displayState.sidebarLabel,
            icon: displayState.sidebarIcon,
            colorHex: displayState.sidebarColorHex
        )
    }

    static func agentDisplayLabel(agentId: String?, fallback: String = "—") -> String {
        guard let agentId else { return fallback }
        return TerminalAgentRegistry.shared.agent(id: agentId)?.displayName ?? agentId
    }

    static func stateText(for displayState: TerminalAgentDisplayState, preview: String? = nil) -> String {
        switch displayState {
        case .ready:      return "ready"
        case .running:    return "running"
        case .needsInput: return "needs input"
        case .completed:  return "done"
        case .error:
            if let preview,
               preview.range(of: "resume failed", options: .caseInsensitive) != nil
                || preview.range(of: "restore failed", options: .caseInsensitive) != nil {
                return "restore failed"
            }
            return "error"
        case .idle:       return "idle"
        }
    }
}
