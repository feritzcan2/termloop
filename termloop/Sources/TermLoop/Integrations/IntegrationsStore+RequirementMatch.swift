// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

extension IntegrationsStore {

    /// Resolution of an `AbilityMCPRequirement` against the current MCP
    /// integration items. Encapsulates the alias-walk + per-agent union
    /// that the Setup card and any other "is this ability ready?"
    /// consumer needs, so the rendering site doesn't re-derive readiness
    /// state from raw items.
    struct RequirementMatch {
        let requirement: AbilityMCPRequirement
        /// First matched item (canonical id wins, aliases fall back).
        /// Drives status icon + summary text.
        let primaryItem: IntegrationItem?
        /// Union of every matched item's `availableForAgents` — i.e.
        /// every agent family that has any accepted server registered.
        let registeredAgents: Set<AbilityAgentFamily>

        var neededAgents: Set<AbilityAgentFamily> {
            Set(requirement.requiredFor)
        }

        var missingAgents: Set<AbilityAgentFamily> {
            neededAgents.subtracting(registeredAgents)
        }

        var satisfiedAgents: Set<AbilityAgentFamily> {
            neededAgents.intersection(registeredAgents)
        }

        /// Fully ready: every requested agent has a registered match AND
        /// the matched item's connection has been verified.
        var ready: Bool {
            !neededAgents.isEmpty
                && missingAgents.isEmpty
                && (primaryItem?.status.isReady ?? false)
        }

        /// Some — but not all — requested agents have a registered match.
        /// Used to render the "partial" badge instead of "missing".
        var partial: Bool {
            !satisfiedAgents.isEmpty && !missingAgents.isEmpty
        }

        func hasRegistered(_ agent: AbilityAgentFamily) -> Bool {
            registeredAgents.contains(agent)
        }
    }

    /// Match an MCP requirement against the current integration snapshot.
    /// Walks `requirement.matchableIds` (canonical id + aliases) so a
    /// `jira-mcp` config still satisfies an `atlassian` requirement.
    func match(requirement: AbilityMCPRequirement) -> RequirementMatch {
        let matched = requirement.matchableIds
            .compactMap { item(id: IntegrationItem.makeId(kind: .mcp, name: $0)) }
        let registered = matched.reduce(into: Set<AbilityAgentFamily>()) {
            $0.formUnion($1.availableForAgents)
        }
        return RequirementMatch(
            requirement: requirement,
            primaryItem: matched.first,
            registeredAgents: registered
        )
    }
}
