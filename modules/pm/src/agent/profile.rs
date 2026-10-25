//! The PM agent's role copy and the system prompt built from the PM store at
//! launch time. The prompt names only the data the project has: a project
//! without deploy tracking never hears about environments, and one without a
//! Git host never hears about pull requests.

use termloop_launch::PromptTemplate;

use super::PmAgentMode;
use crate::{Board, DataTier, PmError, PmStore, SprintState, Ticket, TicketDelivery, valid_id};

/// The bound of a built system prompt; Claude's appended system prompt
/// argument allows 64 KiB.
pub const PM_SYSTEM_PROMPT_MAX_BYTES: usize = 48 * 1024;
/// The bound of the focus ticket's description quoted in the prompt.
const FOCUS_DESCRIPTION_MAX_CHARS: usize = 4_000;

const ROLE: &str = "\
You are the project manager's agent in TermLoop PM. You follow the work; you \
do not do it. Never edit code, run builds, commit, push, open pull requests, \
or change any external system such as Jira or a Git host. You read the PM \
board through the pm_* tools and suggest ticket changes as proposals the \
project manager accepts or rejects.

A ticket is work handed to developers: what to build and how to know it is \
done. It is never a status report. Keep what you observed apart from what you \
inferred, and say so when something is unknown.";

const ASSISTANT: &str = "\
Mode: assistant. Help the project manager plan and follow the sprint: read \
the board and risks, explain where work stands, and propose clearer \
descriptions or missing acceptance criteria with \
pm_ticket_propose_description and pm_ticket_propose_acceptance_criteria. A \
proposal changes nothing until the project manager accepts it.";

const DELIVERY_CHECK: &str = "\
Mode: delivery check. You are not interactive; nobody answers questions. \
Find out where the change of the ticket in focus runs, using read-only \
commands only. Report once with pm_check_report: every environment you have \
evidence for with its state (deployed, inProgress, notDeployed, or unknown), \
any blockers, and notesMarkdown with ## Observed, ## Inferred, and ## Unknown \
sections. When an agent-read probe's output is in front of you, give its \
reading as agentProbe. If you found a command that tells an environment's \
state, propose it in probeProposals with its environment, argv, matcher, and \
reason; the project manager approves it before it ever runs. If the report \
is refused as invalidArguments, fix it and report again. Stop once a report \
is accepted.";

const TIER_TICKETS: &str = "\
Data: this project has tickets only (optionally mirrored from Jira). There is \
no pull request or deployment data; do not ask for it or guess it.";

const TIER_CODE: &str = "\
Data: this project has tickets and pull requests from its Git host. There is \
no deployment data; do not ask for it or guess it.";

const TIER_DEPLOY: &str = "\
Data: this project has tickets, pull requests when a Git host is connected, \
and which environments run each change.";

/// The visible provenance of the assistant's instructions.
pub(super) const ASSISTANT_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "pm.agent.assistant",
    version: 1,
    authored_body: ASSISTANT,
};

/// The visible provenance of a delivery check's instructions.
pub(super) const DELIVERY_CHECK_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "pm.agent.delivery-check",
    version: 1,
    authored_body: DELIVERY_CHECK,
};

/// What the daemon needs to launch the PM agent in one mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PmAgentProfile {
    pub mode: PmAgentMode,
    pub system_prompt: String,
    /// The non-interactive first message of a delivery check.
    pub first_message: Option<String>,
    pub tools: &'static [&'static str],
}

fn tier_copy(tier: DataTier) -> &'static str {
    match tier {
        DataTier::Tickets => TIER_TICKETS,
        DataTier::Code => TIER_CODE,
        DataTier::Deploy => TIER_DEPLOY,
    }
}

fn truncated(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}\n[truncated]", &text[..end]),
        None => text.to_owned(),
    }
}

fn sprint_section(board: &Board) -> String {
    let Some(sprint) = board
        .sprints
        .iter()
        .find(|sprint| sprint.state == SprintState::Active)
    else {
        return "Active sprint: none.".to_owned();
    };
    let tickets: Vec<_> = board
        .tickets
        .iter()
        .zip(&board.deliveries)
        .filter(|(ticket, _)| ticket.sprint_id.as_deref() == Some(sprint.id.as_str()))
        .collect();
    let at_risk = tickets
        .iter()
        .filter(|(_, delivery)| !delivery.risks.is_empty())
        .count();
    let mut section = format!("Active sprint: {}", sprint.name);
    if let Some(goal) = &sprint.goal {
        section.push_str(&format!("\nGoal: {goal}"));
    }
    if let Some(ends_at) = sprint.ends_at_epoch_ms {
        section.push_str(&format!("\nEnds at (epoch ms): {ends_at}"));
    }
    section.push_str(&format!(
        "\nTickets: {}, with risks: {at_risk}",
        tickets.len()
    ));
    section
}

fn focus_section(ticket: &Ticket, delivery: Option<&TicketDelivery>, board: &Board) -> String {
    let mut section = format!(
        "Ticket in focus: {} ({})\nStatus: {:?}",
        ticket.title, ticket.id, ticket.status
    );
    if let Some(key) = ticket.jira_issue_key() {
        section.push_str(&format!("\nJira: {key}"));
    }
    if let Some(delivery) = delivery {
        section.push_str(&format!("\nStage: {:?}", delivery.stage.kind));
        if !delivery.check_reasons.is_empty() {
            section.push_str(&format!(
                "\nWhy a check is due: {}",
                delivery.check_reasons.join("; ")
            ));
        }
    }
    if board.tracking.deploy && !board.environments.is_empty() {
        let names: Vec<_> = board
            .environments
            .iter()
            .map(|environment| environment.name.as_str())
            .collect();
        section.push_str(&format!(
            "\nEnvironments in delivery order: {}",
            names.join(", ")
        ));
    }
    if !ticket.description.is_empty() {
        section.push_str("\n\nDescription:\n");
        section.push_str(&truncated(&ticket.description, FOCUS_DESCRIPTION_MAX_CHARS));
    }
    section
}

impl PmAgentProfile {
    /// Builds the profile from the PM store's current state. A delivery
    /// check needs a ticket of the project and a project that tracks
    /// deployments.
    pub fn build(
        store: &PmStore,
        project_id: &str,
        mode: PmAgentMode,
        focus_ticket_id: Option<&str>,
    ) -> Result<Self, PmError> {
        let board = store.board(project_id)?;
        let focus = match focus_ticket_id {
            Some(ticket_id) => {
                if !valid_id(ticket_id) {
                    return Err(PmError::Invalid("ticketId"));
                }
                let ticket = board
                    .tickets
                    .iter()
                    .position(|ticket| ticket.id == ticket_id)
                    .ok_or(PmError::NotFound)?;
                Some(ticket)
            }
            None if mode == PmAgentMode::DeliveryCheck => {
                return Err(PmError::Invalid("ticketId"));
            }
            None => None,
        };
        if mode == PmAgentMode::DeliveryCheck && !board.tracking.deploy {
            return Err(PmError::Constraint(
                "the project does not track deployments",
            ));
        }
        let mut sections = vec![
            ROLE.to_owned(),
            match mode {
                PmAgentMode::Assistant => ASSISTANT,
                PmAgentMode::DeliveryCheck => DELIVERY_CHECK,
            }
            .to_owned(),
            tier_copy(board.tracking.tier).to_owned(),
            sprint_section(&board),
        ];
        if let Some(index) = focus {
            sections.push(focus_section(
                &board.tickets[index],
                board.deliveries.get(index),
                &board,
            ));
        }
        let mut system_prompt = sections.join("\n\n");
        if system_prompt.len() > PM_SYSTEM_PROMPT_MAX_BYTES {
            let mut end = PM_SYSTEM_PROMPT_MAX_BYTES;
            while !system_prompt.is_char_boundary(end) {
                end -= 1;
            }
            system_prompt.truncate(end);
        }
        let first_message = (mode == PmAgentMode::DeliveryCheck).then(|| {
            let ticket = &board.tickets[focus.expect("a delivery check has its ticket")];
            format!(
                "Run the delivery check for ticket {} and report with pm_check_report.",
                ticket.id
            )
        });
        Ok(Self {
            mode,
            system_prompt,
            first_message,
            tools: mode.tools(),
        })
    }
}
