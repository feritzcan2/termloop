import Foundation

// MARK: - AgentInvocationSource

/// Where an agent run was initiated from. Typed enum so call-sites and UI
/// rows can switch on intent without parsing strings. Use `reasonTag` on
/// `AgentInvocationRequest` for free-form supplementary classification
/// (e.g. `"quickAction.freePrompt"`).
enum AgentInvocationSource: Equatable, Hashable {
    case quickAction
    case quickActionFreePrompt
    case manualWorkspaceCreate
    case workspaceFork
    case claudeNativeFork
    case codexNativeFork
    case workspaceRestore
    case worktreeMigrationRelaunch
    case bridgeKickoff
    case askAgent
    case abilityCreator
    case abilityRefiner
    case socket
}

extension AgentInvocationSource {
    var isForkLike: Bool {
        switch self {
        case .workspaceFork, .claudeNativeFork, .codexNativeFork:
            return true
        default:
            return false
        }
    }

    var isNativeFork: Bool {
        switch self {
        case .claudeNativeFork, .codexNativeFork:
            return true
        default:
            return false
        }
    }

    var usesSourceWorkspaceLaunch: Bool {
        switch self {
        case .workspaceFork,
             .claudeNativeFork,
             .codexNativeFork,
             .bridgeKickoff,
             .askAgent:
            return true
        default:
            return false
        }
    }
}

// MARK: - AgentModelOption

/// Agent capability-side model identity. The catalog decides whether a given
/// option is valid for the chosen agent; templates only suggest a model.
enum AgentModelOption: String, Equatable, Hashable, Codable {
    case `default`
    case opus
    case sonnet
    case gpt56Sol = "gpt-5.6-sol"
    case gpt56Terra = "gpt-5.6-terra"
    case gpt56Luna = "gpt-5.6-luna"
    case gpt55 = "gpt-5.5"
    case gpt54 = "gpt-5.4"
    case gpt54Mini = "gpt-5.4-mini"
    case gpt53Codex = "gpt-5.3-codex"
    case gpt53CodexSpark = "gpt-5.3-codex-spark"
    case gpt52 = "gpt-5.2"
}

extension AgentModelOption {
    var displayLabel: String {
        switch self {
        case .default: return rawValue
        case .gpt56Sol: return "gpt-5.6-sol"
        case .gpt56Terra: return "gpt-5.6-terra"
        case .gpt56Luna: return "gpt-5.6-luna"
        case .gpt55: return "gpt-5.5"
        case .gpt54: return "gpt-5.4"
        case .gpt54Mini: return "GPT-5.4-Mini"
        case .gpt53Codex: return "gpt-5.3-codex"
        case .gpt53CodexSpark: return "GPT-5.3-Codex-Spark"
        case .gpt52: return "gpt-5.2"
        case .opus, .sonnet: return rawValue
        }
    }

    static let allVisibleCases: [AgentModelOption] = [
        .default,
        .sonnet,
        .opus,
        .gpt56Sol,
        .gpt56Terra,
        .gpt56Luna,
        .gpt55,
        .gpt54,
        .gpt54Mini,
        .gpt53Codex,
        .gpt53CodexSpark,
        .gpt52,
    ]
}

// MARK: - AgentReasoningOption

/// Provider-side reasoning-effort identity. Like model options, the catalog
/// owns which values are valid for which agent and can downgrade or drop
/// unsupported requests.
enum AgentReasoningOption: String, Equatable, Hashable, Codable {
    case `default`
    case low
    case medium
    case high
    case xhigh
    case max

    static let allVisibleCases: [AgentReasoningOption] = [.default, .low, .medium, .high, .xhigh, .max]
}

// MARK: - ProjectInstructionSnapshot

/// Resolved instruction view for a single run. Held inside an
/// `AgentInvocationPlan`. Built by `ProjectInstructionStore` (Phase 2),
/// composed by `AgentInvocationComposer` (Phase 3).
struct ProjectInstructionSnapshot: Equatable {
    /// Abilities whose activation matched this run; their full bodies are
    /// rendered into `composedAppendSystemPrompt`.
    let activeAbilities: [Ability]
    /// Abilities surfaced as "available on demand" — names listed but
    /// bodies not injected.
    let listedAbilities: [Ability]
    /// Full file list for the project, including `.off` and worktree-
    /// dormant abilities that `activeAbilities` / `listedAbilities`
    /// filtered out. Preview UIs render chips for these.
    let allAbilities: [Ability]
    /// Skills required by active/on-demand abilities. The composed prompt
    /// points agents at these files; launch adapters may also materialize
    /// canonical `.termloop/skills` entries into native skill catalogs.
    let referencedSkills: [SkillEntry]
    /// The fully-rendered system-reminder block for active + listed
    /// abilities, ready to feed into the agent. `nil` when no abilities
    /// resolved.
    let composedAppendSystemPrompt: String?
    /// Generated instruction fragments disabled for this sheet-scoped run.
    /// Ability partitions stay visible, but the composer and launch-time
    /// skill materializer must not emit these generated fragments.
    let disabledGeneratedParts: Set<InstructionRunOverrides.GeneratedPartKind>
    /// True when a sheet-scoped override changed what the wrapper would
    /// otherwise fetch from the socket. Launch must then skip wrapper-side
    /// context fetch even if the composed prompt is empty.
    let hasRunOverrides: Bool
    /// Whether the run's cwd sits under `.termloop-worktrees/`. Preview
    /// overrides re-format the ability block without re-detecting this.
    let isWorktree: Bool

    static let empty = ProjectInstructionSnapshot(
        activeAbilities: [],
        listedAbilities: [],
        allAbilities: [],
        referencedSkills: [],
        composedAppendSystemPrompt: nil,
        disabledGeneratedParts: [],
        hasRunOverrides: false,
        isWorktree: false
    )
}

// MARK: - AgentInvocationRequest

/// Caller-owned input to `AgentInvocationComposer`. Describes *what the user
/// asked for* — not what the agent will receive. The composer turns this
/// into an `AgentInvocationPlan`.
struct AgentInvocationRequest {
    /// Explicit terminal-agent id. `nil` lets the composer derive one via
    /// the agent-resolution chain (template → workspace → default).
    let agentId: String?
    /// Template id when running from the catalog. `nil` for free-prompt runs.
    let templateId: String?
    /// User-facing first turn body. Free-prompt runs put text here; template
    /// runs may also override the template body.
    let userPrompt: String?
    let workspaceId: UUID?
    let projectId: UUID?
    let runCwd: URL?
    let branchName: String?
    let repoRootPath: String?
    /// Optional reusable prompt-document selection for this run. Composer
    /// resolves the id into text before producing a plan.
    let promptDocumentIdOverride: String?
    /// Override for the user-defined append-system-prompt (replaces the
    /// global Settings value for this single run).
    let systemPromptOverride: String?
    /// Optional reusable system-prompt document selection for this run.
    let systemPromptDocumentIdOverride: String?
    let permissionOverride: AgentTemplate.PermissionMode?
    let modelOverride: AgentModelOption?
    let reasoningOverride: AgentReasoningOption?
    /// Resolved variable substitutions for `{{var}}` placeholders.
    let variableValues: [String: String]
    let source: AgentInvocationSource
    /// Free-form supplementary classifier. Composer/UI may inspect for
    /// secondary routing (e.g. `"quickAction.freePrompt"`). Most callers
    /// leave this `nil`.
    let reasonTag: String?

    init(
        agentId: String? = nil,
        templateId: String? = nil,
        userPrompt: String? = nil,
        workspaceId: UUID? = nil,
        projectId: UUID? = nil,
        runCwd: URL? = nil,
        branchName: String? = nil,
        repoRootPath: String? = nil,
        promptDocumentIdOverride: String? = nil,
        systemPromptOverride: String? = nil,
        systemPromptDocumentIdOverride: String? = nil,
        permissionOverride: AgentTemplate.PermissionMode? = nil,
        modelOverride: AgentModelOption? = nil,
        reasoningOverride: AgentReasoningOption? = nil,
        variableValues: [String: String] = [:],
        source: AgentInvocationSource,
        reasonTag: String? = nil
    ) {
        self.agentId = agentId
        self.templateId = templateId
        self.userPrompt = userPrompt
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.runCwd = runCwd
        self.branchName = branchName
        self.repoRootPath = repoRootPath
        self.promptDocumentIdOverride = promptDocumentIdOverride
        self.systemPromptOverride = systemPromptOverride
        self.systemPromptDocumentIdOverride = systemPromptDocumentIdOverride
        self.permissionOverride = permissionOverride
        self.modelOverride = modelOverride
        self.reasoningOverride = reasoningOverride
        self.variableValues = variableValues
        self.source = source
        self.reasonTag = reasonTag
    }
}

// MARK: - AgentInvocationPlan

/// Composer-owned semantic launch payload. Transport-agnostic by design:
/// no `extraArgv`, no `promptPrefix`, no agent-specific delivery
/// directives. The transport adapter (Phase 3.5) is responsible for
/// translating these semantic fields into the agent's actual CLI invocation.
///
/// Preview UIs read this same plan and render `previewSummary` rather than
/// re-deriving labels.
struct AgentInvocationPlan: Equatable {
    /// Resolved terminal-agent id (`claude`, `codex`, `gemini`, ...).
    let agentId: String
    /// Resolved model the catalog approved for this agent. Catalog can
    /// downgrade a request (e.g. `.opus` for an agent that only supports
    /// `.default`) — the plan reflects what will actually run.
    let resolvedModel: AgentModelOption
    /// Resolved reasoning effort the catalog approved for this agent.
    /// `nil` means the selected provider does not expose a reasoning knob.
    let resolvedReasoning: AgentReasoningOption?
    /// Resolved Claude-CLI permission mode. `nil` means "caller did not
    /// request an explicit permission" — Runner must then fall through to
    /// `agent.argv` defaults rather than forcing `.default` (which would
    /// emit `--permission-mode default` and override the registry's
    /// `--dangerously-skip-permissions`). Non-nil means the caller
    /// explicitly asked; Runner maps it to per-agent flags.
    let resolvedPermission: AgentTemplate.PermissionMode?
    /// Template the run resolved to. `nil` for free-prompt runs.
    let template: AgentTemplate?
    /// Final user-visible first-turn body, with variables substituted.
    /// `nil` means "no synthetic first turn" (e.g. plain shell launch).
    let resolvedPromptBody: String?
    /// User-scoped system prompt override after variable substitution.
    /// Excludes the ability block and reporting prefix. Fresh-launch
    /// consumers read this.
    let resolvedUserSystemPrompt: String?
    /// User override joined with the ability block. Restore / worktree /
    /// socket preview paths (which expect ability injection) read this.
    /// Adapter decides delivery (claude flag, codex tempfile, others
    /// prompt-prefix).
    let resolvedSystemInstructions: String?
    /// Semantic reported-context block (Jira ticket, build link, ...).
    /// Already part of `resolvedSystemInstructions`; exposed separately so
    /// alternate transport paths (wrapper-script live fetch, socket previews)
    /// can reuse the snapshot without recomposing it. Transport delivery is
    /// agent-specific and lives outside the composer (invariant 1).
    let reportedContextBlock: String?
    /// Worktree-only `<system-reminder>` carrying the branch + worktree path.
    /// `nil` outside worktrees. Already part of `resolvedSystemInstructions`;
    /// exposed separately for preview surfaces.
    let worktreeContextBlock: String?
    /// Resolved instruction snapshot for this run.
    let instructions: ProjectInstructionSnapshot
    /// Run context passed through to lifecycle / runner.
    let runCwd: URL?
    let workspaceId: UUID?
    let projectId: UUID?
    let branchName: String?
    let repoRootPath: String?
    /// Provenance for telemetry, row formatting, transcript headers.
    let source: AgentInvocationSource
    let reasonTag: String?
    /// Display-friendly summary for UI rows / preview chips. Single
    /// projection of the plan so preview and launch never disagree.
    let previewSummary: PreviewSummary

    struct PreviewSummary: Equatable {
        let title: String
        let snippet: String?
        let injectedAbilityNames: [String]
        let listedAbilityNames: [String]
        let referencedSkillNames: [String]
    }

    /// Pair with `launchProvidedFullContext` when handing to lifecycle: the
    /// wrapper script skips its own socket fetch only when the joined form
    /// (`resolvedSystemInstructions`) was really inlined, not when we fell
    /// back to user-only.
    var launchSystemInstructions: String? {
        resolvedSystemInstructions ?? resolvedUserSystemPrompt
    }

    var launchProvidedFullContext: Bool {
        resolvedSystemInstructions != nil || instructions.hasRunOverrides
    }
}
