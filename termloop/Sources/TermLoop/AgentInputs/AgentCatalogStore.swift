import Combine
import Foundation

/// Truth owner for runtime-capable terminal agents and their capabilities.
///
/// Phase 2 wraps `TerminalAgentRegistry` so callers can migrate gradually.
/// The composer (Phase 3) reads agent identity, model validity, and
/// status keys from here. Adding a new built-in agent should change this
/// file, not the registry.
@MainActor
final class AgentCatalogStore: ObservableObject {
    static let shared = AgentCatalogStore()
    static let codexId = "codex"
    private static let defaultOnlyModels: Set<AgentModelOption> = [.default]
    private static let claudeModels: Set<AgentModelOption> = [.default, .opus, .sonnet]
    private static let codexModels: Set<AgentModelOption> = [
        .default,
        .gpt55,
        .gpt54,
        .gpt54Mini,
        .gpt53Codex,
        .gpt53CodexSpark,
        .gpt52,
    ]
    private static let noReasoningOptions: Set<AgentReasoningOption> = []
    private static let claudeReasoning: Set<AgentReasoningOption> = [.default, .low, .medium, .high, .xhigh, .max]
    private static let codexReasoning: Set<AgentReasoningOption> = [.default, .low, .medium, .high, .xhigh]

    @Published private(set) var agents: [TerminalAgent]

    private init() {
        self.agents = TerminalAgentRegistry.builtIn
    }

    func agent(id: String) -> TerminalAgent? {
        agents.first { $0.id == id }
    }

    var statusKeys: Set<String> {
        Set(agents.map(\.statusKey))
    }

    /// Returns the model option that should actually run, given a request +
    /// the chosen agent. Catalog has the final say: a template can suggest
    /// `.opus` but if the agent only supports `.default`, the catalog
    /// downgrades. This is the boundary the plan explicitly calls out
    /// ("model truth belongs to the agent catalog").
    func resolveModel(_ requested: AgentModelOption?, for agentId: String) -> AgentModelOption {
        let want = requested ?? .default
        guard supportedModels(for: agentId).contains(want) else { return .default }
        return want
    }

    /// Returns the reasoning effort that should actually run for the chosen
    /// agent. `nil` means the provider does not expose a reasoning selector.
    func resolveReasoning(
        _ requested: AgentReasoningOption?,
        for agentId: String
    ) -> AgentReasoningOption? {
        let supported = supportedReasoningOptions(for: agentId)
        guard !supported.isEmpty else { return nil }
        let want = requested ?? .default
        return supported.contains(want) ? want : .default
    }

    /// Models the catalog considers valid for the given agent. Today only
    /// Claude has model alternates; other CLIs accept `.default` only. When
    /// codex/gemini gain explicit model selection here is the single place
    /// to teach the catalog.
    func supportedModels(for agentId: String) -> Set<AgentModelOption> {
        switch agentId {
        case TerminalAgent.claudeId:
            return Self.claudeModels
        case Self.codexId:
            return Self.codexModels
        default:
            return Self.defaultOnlyModels
        }
    }

    func orderedModelOptions(for agentId: String) -> [AgentModelOption] {
        let supported = supportedModels(for: agentId)
        return AgentModelOption.allVisibleCases.filter { supported.contains($0) }
    }

    /// Current runtime-verified reasoning support by provider:
    /// - Claude Code exposes `--effort low|medium|high|xhigh|max`
    /// - Codex uses `-c model_reasoning_effort="…"` and supports up to xhigh
    /// - Gemini/OpenCode currently expose no reasoning-effort selector
    func supportedReasoningOptions(for agentId: String) -> Set<AgentReasoningOption> {
        switch agentId {
        case TerminalAgent.claudeId:
            return Self.claudeReasoning
        case Self.codexId:
            return Self.codexReasoning
        default:
            return Self.noReasoningOptions
        }
    }

    func orderedReasoningOptions(for agentId: String) -> [AgentReasoningOption] {
        let supported = supportedReasoningOptions(for: agentId)
        return AgentReasoningOption.allVisibleCases.filter { supported.contains($0) }
    }
}
