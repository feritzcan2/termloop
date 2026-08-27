use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssistantLaunchDefaults {
    pub model: &'static str,
    pub permission: &'static str,
    pub reasoning: &'static str,
}

/// The explicit launch selection used when a persistent Steward or Worker is
/// first created for a provider. Once stored, each field remains user-owned.
pub fn default_assistant_launch_selection(
    agent_id: &str,
) -> Result<AssistantLaunchDefaults, InvocationError> {
    let defaults = match agent_id {
        "claude" => AssistantLaunchDefaults {
            model: "sonnet",
            permission: "bypassPermissions",
            reasoning: "medium",
        },
        "codex" => AssistantLaunchDefaults {
            model: "gpt-5.6-luna",
            permission: "bypassPermissions",
            reasoning: "medium",
        },
        _ => return Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    };
    validate_agent_configuration(
        agent_id,
        defaults.model,
        defaults.permission,
        defaults.reasoning,
    )?;
    Ok(defaults)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutorRole {
    Steward,
    Worker,
    SlackTracker,
    JiraTracker,
    RuntimeTracker,
    DeliveryTracker,
    CiPrTracker,
    /// One delivery-pipeline stage, evaluated for one focused Task per run.
    StepCheckTracker,
    CustomTracker,
}

impl ExecutorRole {
    pub(crate) fn template(self) -> &'static PromptTemplate {
        match self {
            Self::Steward => &STEWARD_EXECUTOR_TEMPLATE,
            Self::Worker => &WORKER_EXECUTOR_TEMPLATE,
            Self::SlackTracker => &SLACK_TRACKER_TEMPLATE,
            Self::JiraTracker => &JIRA_TRACKER_TEMPLATE,
            Self::RuntimeTracker => &RUNTIME_TRACKER_TEMPLATE,
            Self::DeliveryTracker => &DELIVERY_TRACKER_TEMPLATE,
            Self::CiPrTracker => &CI_PR_TRACKER_TEMPLATE,
            Self::StepCheckTracker => &STEP_CHECK_TRACKER_TEMPLATE,
            Self::CustomTracker => &CUSTOM_TRACKER_TEMPLATE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvenancedPrompt {
    provenance: Provenance,
    preview: String,
}

impl ProvenancedPrompt {
    pub fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    pub fn authored_preview(&self) -> &str {
        &self.preview
    }

    pub fn delivered_preview(&self) -> &str {
        &self.preview
    }
}

/// Composes a closed built-in Steward/Tracker role prompt. Runtime check data
/// arrives later through capability-scoped tools; this constructor deliberately
/// accepts no arbitrary prompt string or repository path binding.
pub fn executor_prompt(role: ExecutorRole) -> Result<ProvenancedPrompt, InvocationError> {
    let template = role.template();
    validate_template_asset(template)?;
    Ok(ProvenancedPrompt {
        provenance: Provenance {
            template_ref: template.id.to_owned(),
            template_version: template.version,
        },
        preview: template.authored_body.to_owned(),
    })
}

const RETIRED_STEWARD_EXECUTOR_DEFAULTS: &[&str] = &[
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v2.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v3.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v4.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v5.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v6.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v7.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v8.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v9.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v10.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v11.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v12.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v13.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v14.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v15.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v16.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v17.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v18.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v22.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v23.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v24.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v25.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v26.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v27.md"),
    include_str!("../../../resources/prompts/retired/builtin.steward.executor.v28.md"),
];

pub fn resolved_steward_system_prompt(configured: &str) -> &str {
    let configured = editable_steward_system_prompt(configured);
    if configured.is_empty() {
        default_steward_system_prompt()
    } else {
        configured
    }
}

pub fn editable_steward_system_prompt(configured: &str) -> &str {
    let configured = configured.trim();
    let is_default = configured == default_steward_system_prompt()
        || RETIRED_STEWARD_EXECUTOR_DEFAULTS.iter().any(|asset| {
            asset
                .splitn(3, "\n\n")
                .nth(2)
                .expect("retired Steward prompt has metadata and instructions")
                .trim()
                == configured
        });
    if is_default { "" } else { configured }
}

pub fn default_steward_system_prompt() -> &'static str {
    STEWARD_EXECUTOR_TEMPLATE
        .authored_body
        .splitn(3, "\n\n")
        .nth(2)
        .expect("Steward prompt asset has metadata and instructions")
        .trim()
}

pub fn effective_steward_system_prompt(configured: &str) -> String {
    let configured = editable_steward_system_prompt(configured);
    let built_in = default_steward_system_prompt();
    if configured.is_empty() {
        built_in.to_owned()
    } else {
        format!("{built_in}\n\n{}", configured.trim())
    }
}

pub fn effective_worker_prompt(worker_prompt: &str, system_prompt: &str) -> String {
    let mut effective = WORKER_EXECUTOR_TEMPLATE.authored_body.trim().to_owned();
    let worker_prompt = worker_prompt.trim();
    let system_prompt = system_prompt.trim();
    match (worker_prompt.is_empty(), system_prompt.is_empty()) {
        (true, true) => {}
        // A single configured value is the complete editable suffix. This is
        // the current one-editor representation and must round-trip without
        // invocation adding its own visible text.
        (true, false) => {
            effective.push_str("\n\n");
            effective.push_str(system_prompt);
        }
        (false, true) => {
            effective.push_str("\n\n");
            effective.push_str(worker_prompt);
        }
        // Preserve the visible ordering and precedence of configurations that
        // still contain both independently stored fields.
        (false, false) => {
            effective.push_str("\n\n## Configured Worker prompt\n\n");
            effective.push_str(worker_prompt);
            effective.push_str("\n\n## Configured System prompt\n\n");
            effective.push_str(system_prompt);
        }
    }
    effective
}

pub fn editable_steward_system_prompt_from_effective(effective: &str) -> Option<&str> {
    let effective = effective.trim();
    let suffix = effective.strip_prefix(default_steward_system_prompt())?;
    if suffix.is_empty() {
        Some("")
    } else {
        Some(suffix.strip_prefix("\n\n")?.trim())
    }
}

pub(super) fn validate_template_asset(template: &PromptTemplate) -> Result<(), InvocationError> {
    if template.authored_body.trim().is_empty() {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    let mut ids = vec![];
    let mut versions = vec![];
    for (index, line) in template.authored_body.lines().enumerate() {
        let line = line.trim();
        if let Some(value) = metadata_value(line, "- id: `") {
            ids.push((index, value));
        }
        if let Some(value) = metadata_value(line, "- version: `") {
            versions.push((index, value));
        }
    }
    if ids.len() != 1
        || ids[0].0 >= 8
        || ids[0].1 != template.id
        || versions.len() != 1
        || versions[0].0 >= 8
        || versions[0].1.parse::<u32>().ok() != Some(template.version)
    {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    Ok(())
}

fn metadata_value<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.strip_prefix(prefix)?.strip_suffix('`')
}

/// Returns the exact visible built-in instructions delivered for a Tracker
/// assignment. Trackers do not own a launch or terminal; their role prompt is
/// embedded into a wake sent to the selected Worker.
pub fn tracker_assignment_prompt(role: ExecutorRole) -> Result<ProvenancedPrompt, InvocationError> {
    if matches!(role, ExecutorRole::Steward | ExecutorRole::Worker) {
        return Err(InvocationError::InvalidAssistantConfiguration);
    }
    let template = role.template();
    validate_template_asset(template)?;
    let instructions = template
        .authored_body
        .splitn(3, "\n\n")
        .nth(2)
        .filter(|body| !body.trim().is_empty())
        .ok_or(InvocationError::UnprovenancedPrompt)?;
    Ok(ProvenancedPrompt {
        provenance: Provenance {
            template_ref: template.id.to_owned(),
            template_version: template.version,
        },
        preview: instructions.trim().to_owned(),
    })
}

pub fn assistant_activation_message(
    role: ExecutorRole,
) -> Result<ProvenancedPrompt, InvocationError> {
    validate_template_asset(&ASSISTANT_ACTIVATION_TEMPLATE)?;
    let (role_name, instructions) = match role {
        ExecutorRole::Steward => (
            "Project Steward",
            "Follow the **Initial activation** row in the visible Steward wake protocol, including its mutation-receipt and silent-idle rules.",
        ),
        ExecutorRole::Worker => (
            "Project Worker",
            "Call `worker_get_next_routine`, finish a step assignment through `worker_report_step_verdicts` with one verdict, finish another claimed Routine through `worker_complete_routine`, use `worker_report_routine_problem` when required configuration or access is missing, and repeat until get-next returns idle.",
        ),
        _ => return Err(InvocationError::InvalidAssistantConfiguration),
    };
    let delivered = ASSISTANT_ACTIVATION_TEMPLATE
        .authored_body
        .replace("{{ROLE}}", role_name)
        .replace("{{INSTRUCTIONS}}", instructions);
    if delivered.contains("{{") || delivered.len() > 4 * 1024 {
        return Err(InvocationError::InvalidAssistantConfiguration);
    }
    Ok(ProvenancedPrompt {
        provenance: Provenance {
            template_ref: ASSISTANT_ACTIVATION_TEMPLATE.id.into(),
            template_version: ASSISTANT_ACTIVATION_TEMPLATE.version,
        },
        preview: delivered,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssistantWakeReason {
    StewardUserMessage,
    StewardPipelineMoved,
    StewardPipelineMovedAndRoutineFinding,
    StewardRoutineFinding,
    StewardConfigurationChanged,
    StewardStartupRefresh,
    ScheduledCheck,
}

impl AssistantWakeReason {
    fn label(self) -> &'static str {
        match self {
            Self::StewardUserMessage => "user message",
            Self::StewardPipelineMoved => "delivery pipeline moved",
            Self::StewardPipelineMovedAndRoutineFinding => {
                "delivery pipeline moved and a new factual Routine finding is ready"
            }
            Self::StewardRoutineFinding => "new factual Routine finding",
            Self::StewardConfigurationChanged => "Steward configuration changed",
            Self::StewardStartupRefresh => "daemon startup refresh",
            Self::ScheduledCheck => "scheduled check",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantWakeMessage {
    provenance: Provenance,
    delivered: String,
    terminal_input_sequence: Vec<Vec<u8>>,
}

impl AssistantWakeMessage {
    pub fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    pub fn delivered_bytes(&self) -> &[u8] {
        self.delivered.as_bytes()
    }

    pub fn delivered_preview(&self) -> &str {
        &self.delivered
    }

    pub fn terminal_submission(&self) -> GeneratedTerminalSubmission {
        GeneratedTerminalSubmission::from_sequence(
            self.provenance.clone(),
            &self.terminal_input_sequence,
        )
    }
}

pub fn assistant_wake_message(
    role: ExecutorRole,
    reason: AssistantWakeReason,
    check_id: Option<&str>,
    configured_task_prompt: Option<&str>,
) -> Result<AssistantWakeMessage, InvocationError> {
    validate_template_asset(&ASSISTANT_WAKE_TEMPLATE)?;
    let tracker = matches!(
        role,
        ExecutorRole::SlackTracker
            | ExecutorRole::JiraTracker
            | ExecutorRole::RuntimeTracker
            | ExecutorRole::DeliveryTracker
            | ExecutorRole::CiPrTracker
            | ExecutorRole::CustomTracker
    );
    let worker_batch =
        role == ExecutorRole::Worker && reason == AssistantWakeReason::ScheduledCheck;
    let steward_reason = matches!(
        reason,
        AssistantWakeReason::StewardUserMessage
            | AssistantWakeReason::StewardPipelineMoved
            | AssistantWakeReason::StewardPipelineMovedAndRoutineFinding
            | AssistantWakeReason::StewardRoutineFinding
            | AssistantWakeReason::StewardConfigurationChanged
            | AssistantWakeReason::StewardStartupRefresh
    );
    if tracker
        != check_id.is_some_and(|value| {
            value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        || (tracker || worker_batch) != (reason == AssistantWakeReason::ScheduledCheck)
        || (role == ExecutorRole::Steward) != steward_reason
        || tracker
            != configured_task_prompt
                .is_some_and(|prompt| !prompt.trim().is_empty() && prompt.len() <= 8 * 1024)
    {
        return Err(InvocationError::InvalidAssistantConfiguration);
    }
    let role_name = match role {
        ExecutorRole::Steward => "Project Steward",
        ExecutorRole::Worker => "Project Worker",
        ExecutorRole::SlackTracker => "Slack Tracker",
        ExecutorRole::JiraTracker => "Jira Issue Synchronizer",
        ExecutorRole::RuntimeTracker => "Runtime Tracker",
        ExecutorRole::DeliveryTracker => "Delivery Tracker",
        ExecutorRole::CiPrTracker => "CI/PR Tracker",
        ExecutorRole::StepCheckTracker => "Pipeline Step Check",
        ExecutorRole::CustomTracker => "Custom Routine",
    };
    let check = check_id.map_or_else(
        || {
            if worker_batch {
                "Claim the next Routine through worker_get_next_routine.".into()
            } else {
                "No check ID is required for this Steward wake.".into()
            }
        },
        |value| format!("Check ID: {value}"),
    );
    let instructions = if worker_batch {
        "Call `worker_get_next_routine`, execute the one claimed Routine using its visible context, finish a step assignment through `worker_report_step_verdicts` with one verdict, finish another Routine through `worker_complete_routine`, use `worker_report_routine_problem` when required configuration or access is missing, and repeat until get-next returns idle."
    } else if tracker {
        "Read the current Project context through your TermLoop tools, perform this one bounded Task using its exact configured instructions, and report its result through the reporting tool required by your role."
    } else if reason == AssistantWakeReason::StewardUserMessage {
        "Follow the **User message** row in the visible Steward wake protocol for the exact newest user-authored message. A successful TermLoop mutation receipt may fully satisfy the demand; never duplicate it with `steward_suggest`. If the newest message has kind `acceptance`, or is the legacy exact reply `Accepted. Proceed with this suggestion.`, locate the newest preceding Steward `suggestion` and treat its concrete recommendation as the accepted user request: perform the supported action without asking the user to restate it, or reply once that the suggestion contained no Steward-performable action and name the real next actor. Never stand by silently after an acceptance."
    } else if reason == AssistantWakeReason::StewardPipelineMoved {
        "Follow the **Delivery pipeline moved** row in the visible Steward wake protocol."
    } else if reason == AssistantWakeReason::StewardPipelineMovedAndRoutineFinding {
        "Follow the **Movement plus finding** row in the visible Steward wake protocol. Keep the movement update and any finding-bound approval proposal separate."
    } else if reason == AssistantWakeReason::StewardRoutineFinding {
        "Follow the **New Routine finding** row and the Routine-finding policy in the visible Steward instructions."
    } else if reason == AssistantWakeReason::StewardStartupRefresh {
        "Follow the **Startup refresh** row in the visible Steward wake protocol. Read the transcript first; if its exact newest visible message is an unhandled typed `acceptance` or the legacy exact reply `Accepted. Proceed with this suggestion.`, process that accepted suggestion before unresolved findings and never stand by silently."
    } else if reason == AssistantWakeReason::StewardConfigurationChanged {
        "Follow the **Configuration or any other wake** row in the visible Steward wake protocol."
    } else {
        "Read the current Project context through your TermLoop tools, evaluate this Project activity, and respond through the reporting tool required by your role."
    };
    let mut delivered = ASSISTANT_WAKE_TEMPLATE
        .authored_body
        .replace("{{ROLE}}", role_name)
        .replace("{{REASON}}", reason.label())
        .replace("{{CHECK}}", &check)
        .replace("{{INSTRUCTIONS}}", instructions);
    if let Some(task_prompt) = configured_task_prompt {
        delivered.push_str("\n\nExact configured Task instructions:\n\n");
        delivered.push_str(task_prompt);
    }
    if delivered.contains("{{") || delivered.len() > 12 * 1024 {
        return Err(InvocationError::InvalidAssistantConfiguration);
    }
    let provenance = Provenance {
        template_ref: ASSISTANT_WAKE_TEMPLATE.id.into(),
        template_version: ASSISTANT_WAKE_TEMPLATE.version,
    };
    let terminal_input_sequence =
        termloop_platform::generated_terminal_paste_submission_sequence(delivered.as_bytes())
            .map_err(|_| InvocationError::InvalidAssistantConfiguration)?;
    Ok(AssistantWakeMessage {
        provenance,
        delivered,
        terminal_input_sequence,
    })
}
