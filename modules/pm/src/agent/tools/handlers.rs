//! Typed parameters, results, and handlers of the PM agent tools. Every
//! handler stays inside the caller's project; a delivery check also stays on
//! its one ticket.

use super::{PmToolContext, PmToolError, denied};
use crate::agent::{
    PM_CHECK_REPORT, PM_RISKS_READ, PM_SKILL_DRAFT_SUBMIT, PM_SKILL_RUN_FINISH, PM_TICKET_NOTE_ADD,
    PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA, PM_TICKET_PROPOSE_DESCRIPTION, PM_TICKET_READ,
    PM_TICKET_SUGGEST, PmAgentMode,
};
use crate::playbook::{PlaybookStep, StepVerdict};
use crate::skill::{
    Evidence, NeededTool, NewSkillDraft, SkillChannel, SkillDraftOrigin, SkillManifest,
    SkillPrefilter, SkillSample, SkillSource, SkillTrigger,
};
use crate::{
    Board, BreakdownTask, ChannelWatermark, CheckReport, DataTier, DeliveryRisk, EpicDraft,
    NewTicketNote, PmError, PmStore, ProposalChange, ProposalOrigin, SprintState, Ticket,
    TicketAuthor, TicketDelivery, TicketDeliveryFacts, TicketNote, TicketNoteKind, TicketPriority,
    TicketProposal, TicketStatus,
};

/// Which tickets a board read lists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BoardScope {
    /// The active sprint's tickets.
    #[default]
    ActiveSprint,
    /// Every ticket: open sprints and the backlog.
    All,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BoardReadParams {
    #[serde(default)]
    pub scope: BoardScope,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSprint {
    pub id: String,
    pub name: String,
    pub state: SprintState,
    pub goal: Option<String>,
    pub ends_at_epoch_ms: Option<u64>,
}

/// One board card as the agent sees it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardTicket {
    pub id: String,
    pub title: String,
    pub status: TicketStatus,
    pub priority: TicketPriority,
    pub assignee: Option<String>,
    pub sprint_id: Option<String>,
    pub jira_key: Option<String>,
    /// The title of the furthest Playbook step the ticket passed.
    pub step: Option<String>,
    /// The title of the step it works toward; `None` once every step passed.
    pub next_step: Option<String>,
    pub risks: usize,
    /// A delivery check is running for the ticket.
    pub checking: bool,
    /// The epic the ticket works toward.
    pub epic_id: Option<String>,
}

/// One epic as the agent sees it; its progress is its tickets'.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardEpic {
    pub id: String,
    pub title: String,
    pub description: String,
    /// Every ticket of the epic, across sprints and the backlog.
    pub tickets: usize,
    pub done: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardReadResult {
    /// The furthest delivery data the project has; data beyond it is absent,
    /// not empty.
    pub tier: DataTier,
    /// The Playbook step titles, in order.
    pub steps: Vec<String>,
    pub sprints: Vec<BoardSprint>,
    pub tickets: Vec<BoardTicket>,
    pub epics: Vec<BoardEpic>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TicketReadParams {
    pub ticket_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketReadResult {
    pub ticket: Ticket,
    pub delivery: TicketDelivery,
    pub facts: Option<TicketDeliveryFacts>,
    pub pending_proposals: Vec<TicketProposal>,
    /// Facts learned and sources followed, oldest first; a pending one is
    /// not in the description yet.
    pub notes: Vec<TicketNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteAddParams {
    pub ticket_id: String,
    pub kind: TicketNoteKind,
    /// A fact, or a source's one-line label.
    pub text: String,
    /// Where the fact was read, or the source's link.
    #[serde(default)]
    pub url: Option<String>,
    /// What the fact was read from, e.g. `slack:<channel>:<ts>`.
    #[serde(default)]
    pub source_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAddResult {
    pub note_id: String,
    pub ticket_id: String,
    /// Always true for a new note: the description does not reflect it yet.
    pub pending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DescriptionProposalParams {
    pub ticket_id: String,
    /// The complete new description in Markdown.
    pub description: String,
    pub summary: String,
    /// What a skill's suggestion rests on; ignored for the assistant.
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AcceptanceCriteriaProposalParams {
    pub ticket_id: String,
    pub criteria: Vec<String>,
    pub summary: String,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

/// Any ticket change a skill suggests, with the evidence it rests on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SuggestParams {
    pub ticket_id: String,
    pub change: ProposalChange,
    pub summary: String,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillRunFinishParams {
    /// One line: what the run looked at and suggested.
    pub summary: String,
    /// The newest Slack message the run read in each channel.
    #[serde(default)]
    pub channel_watermarks: Vec<ChannelWatermark>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRunFinishResult {
    pub accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillDraftSubmitParams {
    pub name: String,
    pub description: String,
    pub trigger: SkillTrigger,
    pub sources: Vec<SkillSource>,
    pub prefilter: SkillPrefilter,
    pub tools: Vec<String>,
    pub instructions: String,
    #[serde(default)]
    pub channels: Vec<SkillChannel>,
    /// Read-only tools of the agent's own MCP servers a run may call.
    #[serde(default)]
    pub agent_tools: Vec<String>,
    pub what_it_will_do: String,
    #[serde(default)]
    pub needed_tools: Vec<NeededTool>,
    #[serde(default)]
    pub changelog: Option<String>,
    /// The installed skill this draft revises.
    #[serde(default)]
    pub base_skill_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDraftSubmitResult {
    pub draft_id: String,
    /// Tools the PM approves one by one at install.
    pub first_use_tools: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalResult {
    /// `None` in a dry run, which keeps a sample instead.
    pub proposal_id: Option<String>,
    pub ticket_id: String,
    /// Always false: the PM decides whether a proposal is applied.
    pub applied: bool,
    /// The suggestion was kept as a dry-run sample, not a proposal.
    pub sample: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RisksReadParams {
    #[serde(default)]
    pub ticket_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketRisks {
    pub ticket_id: String,
    pub title: String,
    pub risks: Vec<DeliveryRisk>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RisksReadResult {
    pub tickets: Vec<TicketRisks>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckReportParams {
    pub ticket_id: String,
    pub step_id: String,
    pub verdict: StepVerdict,
    /// One or two factual sentences: what was read and what it showed.
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReportResult {
    pub accepted: bool,
    /// When the step is looked at again; `None` once passed.
    pub next_attempt_at_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlaybookProposeParams {
    /// What the setup read and what each step rests on, in plain words.
    pub summary: String,
    pub steps: Vec<PlaybookStep>,
}

/// A split of a goal into tickets: under an existing epic (`epic_id`) or
/// a new one (`epic`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BreakdownProposeParams {
    #[serde(default)]
    pub epic_id: Option<String>,
    #[serde(default)]
    pub epic: Option<EpicDraft>,
    pub tasks: Vec<BreakdownTask>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownProposeResult {
    pub breakdown_id: String,
    /// Always false: the project manager picks the tasks to keep.
    pub applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookProposeResult {
    /// Always false: the project manager reviews and applies it.
    pub applied: bool,
}

/// The ticket a call names, when the caller may touch it: it belongs to the
/// caller's project, and a delivery check names its own ticket.
fn scoped_ticket(
    store: &PmStore,
    context: &PmToolContext,
    tool: &str,
    ticket_id: &str,
) -> Result<Ticket, PmToolError> {
    if context.mode == PmAgentMode::DeliveryCheck && context.ticket_id.as_deref() != Some(ticket_id)
    {
        return Err(denied(
            tool,
            "a delivery check works on its own ticket only",
        ));
    }
    match store.ticket(ticket_id)? {
        Some(ticket) if ticket.project_id == context.project_id => Ok(ticket),
        _ => Err(PmError::NotFound.into()),
    }
}

fn delivery_of(board: &Board, ticket_id: &str) -> Result<TicketDelivery, PmToolError> {
    board
        .deliveries
        .iter()
        .find(|delivery| delivery.ticket_id == ticket_id)
        .cloned()
        .ok_or(PmToolError::Store(PmError::NotFound))
}

pub(super) fn board_read(
    store: &PmStore,
    context: &PmToolContext,
    params: BoardReadParams,
) -> Result<BoardReadResult, PmToolError> {
    let board = store.board(&context.project_id)?;
    let active = board
        .sprints
        .iter()
        .find(|sprint| sprint.state == SprintState::Active)
        .map(|sprint| sprint.id.as_str());
    let tickets = board
        .tickets
        .iter()
        .zip(&board.deliveries)
        .filter(|(ticket, _)| match params.scope {
            BoardScope::ActiveSprint => active.is_some() && ticket.sprint_id.as_deref() == active,
            BoardScope::All => true,
        })
        .map(|(ticket, delivery)| {
            let title = |index: usize| board.playbook.steps[index].title.clone();
            BoardTicket {
                id: ticket.id.clone(),
                title: ticket.title.clone(),
                status: ticket.status,
                priority: ticket.priority,
                assignee: ticket.assignee.clone(),
                sprint_id: ticket.sprint_id.clone(),
                jira_key: ticket.jira_issue_key(),
                step: delivery.playbook.position.map(title),
                next_step: delivery.playbook.next_index().map(title),
                risks: delivery.risks.len(),
                checking: delivery.checking,
                epic_id: ticket.epic_id.clone(),
            }
        })
        .collect();
    let sprints = board
        .sprints
        .iter()
        .filter(|sprint| sprint.state != SprintState::Closed)
        .map(|sprint| BoardSprint {
            id: sprint.id.clone(),
            name: sprint.name.clone(),
            state: sprint.state,
            goal: sprint.goal.clone(),
            ends_at_epoch_ms: sprint.ends_at_epoch_ms,
        })
        .collect();
    let epics = board
        .epics
        .iter()
        .map(|epic| {
            let of_epic = || {
                board
                    .tickets
                    .iter()
                    .filter(|ticket| ticket.epic_id.as_deref() == Some(epic.id.as_str()))
            };
            BoardEpic {
                id: epic.id.clone(),
                title: epic.title.clone(),
                description: epic.description.clone(),
                tickets: of_epic().count(),
                done: of_epic()
                    .filter(|ticket| ticket.status == TicketStatus::Done)
                    .count(),
            }
        })
        .collect();
    Ok(BoardReadResult {
        tier: board.tracking.tier,
        steps: board
            .playbook
            .steps
            .iter()
            .map(|step| step.title.clone())
            .collect(),
        sprints,
        tickets,
        epics,
    })
}

pub(super) fn ticket_read(
    store: &PmStore,
    context: &PmToolContext,
    params: TicketReadParams,
) -> Result<TicketReadResult, PmToolError> {
    let ticket = scoped_ticket(store, context, PM_TICKET_READ, &params.ticket_id)?;
    let board = store.board(&context.project_id)?;
    Ok(TicketReadResult {
        delivery: delivery_of(&board, &ticket.id)?,
        facts: store.ticket_facts(&ticket.id)?,
        pending_proposals: store.ticket_proposals(&ticket.id)?,
        notes: store.ticket_notes(&ticket.id)?,
        ticket,
    })
}

/// Records what the agent learned about a ticket; the ticket itself is left
/// alone.
pub(super) fn note_add(
    store: &mut PmStore,
    context: &PmToolContext,
    params: NoteAddParams,
) -> Result<NoteAddResult, PmToolError> {
    let ticket = scoped_ticket(store, context, PM_TICKET_NOTE_ADD, &params.ticket_id)?;
    let note = store.add_ticket_note(NewTicketNote {
        ticket_id: ticket.id,
        kind: params.kind,
        text: params.text,
        url: params.url,
        source_key: params.source_key,
        author: TicketAuthor::Agent,
    })?;
    Ok(NoteAddResult {
        note_id: note.id,
        ticket_id: note.ticket_id,
        pending: note.pending,
    })
}

fn proposal_result(proposal: TicketProposal) -> ProposalResult {
    ProposalResult {
        proposal_id: Some(proposal.id),
        ticket_id: proposal.ticket_id,
        applied: false,
        sample: false,
    }
}

/// Records a suggestion the way the caller's mode wants it: a dry run
/// keeps a sample, a skill run a proposal naming the skill and evidence,
/// the assistant a plain proposal.
fn record_suggestion(
    store: &mut PmStore,
    context: &PmToolContext,
    ticket: &Ticket,
    change: ProposalChange,
    summary: String,
    evidence: Vec<Evidence>,
) -> Result<ProposalResult, PmToolError> {
    let run = context
        .skill
        .as_ref()
        .filter(|_| context.mode == PmAgentMode::SkillRun);
    match run {
        Some(run) if run.draft_id.is_some() => {
            store.record_dry_run_sample(
                &run.run_id,
                SkillSample {
                    ticket_id: ticket.id.clone(),
                    change,
                    summary,
                    evidence,
                },
            )?;
            Ok(ProposalResult {
                proposal_id: None,
                ticket_id: ticket.id.clone(),
                applied: false,
                sample: true,
            })
        }
        Some(run) => {
            let (skill_id, skill_version) = run
                .skill
                .clone()
                .ok_or(PmToolError::Store(PmError::NotFound))?;
            let origin = ProposalOrigin {
                skill_id,
                skill_version,
                evidence,
            };
            Ok(proposal_result(store.propose_ticket_change_from(
                &ticket.id,
                change,
                &summary,
                Some(origin),
            )?))
        }
        None => Ok(proposal_result(
            store.propose_ticket_change(&ticket.id, change, &summary)?,
        )),
    }
}

pub(super) fn propose_description(
    store: &mut PmStore,
    context: &PmToolContext,
    params: DescriptionProposalParams,
) -> Result<ProposalResult, PmToolError> {
    let ticket = scoped_ticket(
        store,
        context,
        PM_TICKET_PROPOSE_DESCRIPTION,
        &params.ticket_id,
    )?;
    record_suggestion(
        store,
        context,
        &ticket,
        ProposalChange::Description {
            description: params.description,
        },
        params.summary,
        params.evidence,
    )
}

pub(super) fn propose_acceptance_criteria(
    store: &mut PmStore,
    context: &PmToolContext,
    params: AcceptanceCriteriaProposalParams,
) -> Result<ProposalResult, PmToolError> {
    let ticket = scoped_ticket(
        store,
        context,
        PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
        &params.ticket_id,
    )?;
    record_suggestion(
        store,
        context,
        &ticket,
        ProposalChange::AcceptanceCriteria {
            criteria: params.criteria,
        },
        params.summary,
        params.evidence,
    )
}

pub(super) fn suggest(
    store: &mut PmStore,
    context: &PmToolContext,
    params: SuggestParams,
) -> Result<ProposalResult, PmToolError> {
    let ticket = scoped_ticket(store, context, PM_TICKET_SUGGEST, &params.ticket_id)?;
    record_suggestion(
        store,
        context,
        &ticket,
        params.change,
        params.summary,
        params.evidence,
    )
}

pub(super) fn skill_run_finish(
    store: &mut PmStore,
    context: &PmToolContext,
    params: SkillRunFinishParams,
) -> Result<SkillRunFinishResult, PmToolError> {
    let Some(run) = &context.skill else {
        return Err(denied(PM_SKILL_RUN_FINISH, "not a skill run"));
    };
    store.report_skill_run(&run.run_id, &params.summary, &params.channel_watermarks)?;
    Ok(SkillRunFinishResult { accepted: true })
}

pub(super) fn draft_submit(
    store: &mut PmStore,
    context: &PmToolContext,
    params: SkillDraftSubmitParams,
) -> Result<SkillDraftSubmitResult, PmToolError> {
    if let Some(base) = &params.base_skill_id {
        match store.skill(base)? {
            Some(skill) if skill.project_id == context.project_id => {}
            _ => {
                return Err(denied(
                    PM_SKILL_DRAFT_SUBMIT,
                    "no such skill in this project",
                ));
            }
        }
    }
    let draft = store.submit_skill_draft(NewSkillDraft {
        project_id: context.project_id.clone(),
        origin: if params.base_skill_id.is_some() {
            SkillDraftOrigin::Revision
        } else {
            SkillDraftOrigin::Creator
        },
        base_skill_id: params.base_skill_id,
        manifest: SkillManifest {
            name: params.name,
            description: params.description,
            trigger: params.trigger,
            sources: params.sources,
            prefilter: params.prefilter,
            approved_tools: params.tools,
            instructions: params.instructions,
            channels: params.channels,
            agent_tools: params.agent_tools,
        },
        what_it_will_do: params.what_it_will_do,
        needed_tools: params.needed_tools,
        changelog: params.changelog,
    })?;
    Ok(SkillDraftSubmitResult {
        draft_id: draft.id,
        first_use_tools: draft.first_use_tools,
    })
}

/// The Playbook setup proposes the steps it found; the project manager
/// reviews them in the Skills panel.
pub(super) fn playbook_propose(
    store: &mut PmStore,
    context: &PmToolContext,
    params: PlaybookProposeParams,
) -> Result<PlaybookProposeResult, PmToolError> {
    store.propose_playbook(&context.project_id, params.summary, params.steps)?;
    Ok(PlaybookProposeResult { applied: false })
}

/// Keeps a breakdown for the PM; no epic or ticket changes until the PM
/// accepts the tasks it keeps.
pub(super) fn breakdown_propose(
    store: &mut PmStore,
    context: &PmToolContext,
    params: BreakdownProposeParams,
) -> Result<BreakdownProposeResult, PmToolError> {
    let breakdown = store.propose_epic_breakdown(
        &context.project_id,
        params.epic_id.as_deref(),
        params.epic,
        params.tasks,
        params.summary,
    )?;
    Ok(BreakdownProposeResult {
        breakdown_id: breakdown.id,
        applied: false,
    })
}

pub(super) fn risks_read(
    store: &PmStore,
    context: &PmToolContext,
    params: RisksReadParams,
) -> Result<RisksReadResult, PmToolError> {
    // A delivery check reads only its own ticket's risks.
    let only = match (&params.ticket_id, context.mode) {
        (Some(ticket_id), _) => Some(ticket_id.clone()),
        (None, PmAgentMode::DeliveryCheck) => context.ticket_id.clone(),
        (None, _) => None,
    };
    if let Some(ticket_id) = &only {
        scoped_ticket(store, context, PM_RISKS_READ, ticket_id)?;
    }
    let board = store.board(&context.project_id)?;
    let tickets = board
        .tickets
        .iter()
        .zip(&board.deliveries)
        .filter(|(ticket, delivery)| {
            only.as_deref().is_none_or(|id| ticket.id == id) && !delivery.risks.is_empty()
        })
        .map(|(ticket, delivery)| TicketRisks {
            ticket_id: ticket.id.clone(),
            title: ticket.title.clone(),
            risks: delivery.risks.clone(),
        })
        .collect();
    Ok(RisksReadResult { tickets })
}

pub(super) fn check_report(
    store: &mut PmStore,
    context: &PmToolContext,
    params: CheckReportParams,
) -> Result<CheckReportResult, PmToolError> {
    let ticket = scoped_ticket(store, context, PM_CHECK_REPORT, &params.ticket_id)?;
    let recorded = store.record_check_report(
        &context.project_id,
        CheckReport {
            ticket_id: ticket.id,
            step_id: params.step_id,
            verdict: params.verdict,
            evidence: params.evidence,
        },
    )?;
    Ok(CheckReportResult {
        accepted: true,
        next_attempt_at_epoch_ms: recorded.verdict.next_attempt_at_epoch_ms,
    })
}
