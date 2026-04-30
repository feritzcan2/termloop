// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Translates a transport-agnostic `AgentInvocationPlan` into the actual
/// launch components the runner needs: extra argv, an optional prompt
/// prefix prepended to the user's first turn, and the resolved first-turn
/// prompt itself.
///
/// This is the boundary the original plan was fuzzy on. Composer stays
/// transport-unaware (semantic plan only). Adapter knows agent quirks
/// (claude flag vs codex tempfile vs others-prefix) by delegating to
/// `AgentSystemPromptInjector`. New agent backends extend the adapter, not
/// the composer.
enum AgentInvocationTransportAdapter {

    struct Resolution {
        let extraArgv: [String]
        let promptPrefix: String?
        let initialPrompt: String?
        let deliveredSystemInstructions: String?
        let deliveryMode: AgentSystemPromptInjector.DeliveryMode
    }

    static func resolve(_ plan: AgentInvocationPlan) throws -> Resolution {
        try resolve(
            agentId: plan.agentId,
            initialPrompt: plan.resolvedPromptBody,
            systemInstructions: plan.resolvedSystemInstructions
        )
    }

    /// Generic transport projection for callers that need the adapter's
    /// exact delivery view but not the plan's default joined-instructions
    /// semantics. Fresh Quick Action launch preview uses
    /// `resolvedUserSystemPrompt`; restore/socket previews use the joined
    /// `resolvedSystemInstructions`.
    static func resolve(
        agentId: String,
        initialPrompt: String?,
        systemInstructions: String?
    ) throws -> Resolution {
        let systemResolution = try AgentSystemPromptInjector.resolve(
            agentId: agentId,
            systemPrompt: systemInstructions
        )
        return Resolution(
            extraArgv: systemResolution.extraArgv,
            promptPrefix: systemResolution.promptPrefix,
            initialPrompt: initialPrompt,
            deliveredSystemInstructions: systemResolution.deliveredSystemInstructions,
            deliveryMode: systemResolution.deliveryMode
        )
    }

    /// Convenience overload for call-sites that don't hold a full plan yet
    /// (e.g. Runner.prepareLaunch during Phase 4 migration). Routes through
    /// the injector so behavior stays identical; the value add is that the
    /// adapter becomes the single seam every caller goes through. Phase 6
    /// thins the injector once all callers reach it via the adapter.
    static func resolveSystemInstructions(
        agentId: String,
        systemInstructions: String?
    ) throws -> AgentSystemPromptInjector.Resolution {
        try AgentSystemPromptInjector.resolve(
            agentId: agentId,
            systemPrompt: systemInstructions
        )
    }
}
