use crate::{AskToTerminalPrompt, InvocationError, PromptTemplate, assistant, terminal_prompt};

pub(super) const AGENT_RESTART_CONTINUE_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.restart-continue",
    version: 2,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.restart-continue.md"),
};

/// The visible continuation prompt exactly as authored. Settings show this so
/// the user sees what an interrupted Agent receives before enabling it.
pub fn agent_restart_continue_template() -> &'static PromptTemplate {
    &AGENT_RESTART_CONTINUE_TEMPLATE
}

/// Composes the visible post-resume message that asks an Agent whose working
/// turn was interrupted by a graceful restart to continue that work. It has no
/// bindings; core only decides whether to submit it.
pub fn agent_restart_continue_prompt() -> Result<AskToTerminalPrompt, InvocationError> {
    let template = &AGENT_RESTART_CONTINUE_TEMPLATE;
    assistant::validate_template_asset(template)?;
    terminal_prompt(template, vec![], template.body().to_owned())
}
