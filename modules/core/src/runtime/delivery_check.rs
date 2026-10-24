//! Short-lived delivery checks for Projects opened as Project Manager.
//!
//! A check is one temporary Agent in the Project checkout. It reads the Tasks
//! it was given through its own MCP tools, records one report, and is then
//! retired. The registry is runtime-only: a check is never resumed, and a
//! daemon restart forgets every check, whose orphaned Session is retired by
//! the next sweep.

use std::collections::HashMap;

use serde_json::{Value, json};
use termloop_domain::{
    CheckNotes, EnvironmentDeployState, FactSource, TASK_CHECK_NOTES_MAX_BYTES,
    TASK_ENVIRONMENT_FACTS_MAX, TASK_TICKET_BRIEF_MAX_CHARS, TASK_TICKET_SUMMARY_MAX_CHARS,
    TASK_TICKET_TITLE_MAX_CHARS, TASK_TRACKING_SHORT_MAX_CHARS, TASK_TRACKING_TEXT_MAX_BYTES,
    TaskDeliveryFacts, TaskTicketProposal,
};

use crate::session_launch::AgentMcpRole;
use crate::{CoreError, CoreRuntime, store_error};

pub(crate) const DELIVERY_CHECK_TEMPLATE: &str = "builtin.agent.delivery-check";

/// Whether a Session runs one of TermLoop's temporary checking Agents — a
/// Playbook evaluator or a delivery check. Neither is ever resumed, counted as
/// a Task's Agent, or remembered as an ordinary launch.
pub(crate) fn is_temporary_check_template(template_ref: Option<&str>) -> bool {
    matches!(
        template_ref,
        Some(DELIVERY_CHECK_TEMPLATE | crate::runtime::playbook_evaluation::EVALUATOR_TEMPLATE)
    )
}
/// Checks running at once across every Project.
const MAX_CHECKS: usize = 8;
/// A check that has not reported by then is retired.
pub(crate) const CHECK_DEADLINE_MS: u64 = 20 * 60 * 1000;
pub(crate) const MAX_CHECK_TASKS: usize = 20;

/// Why a delivery check runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryCheckReason {
    /// The project manager asked for it.
    Requested,
    /// A delivery probe's output changed and needs reading.
    ProbeChanged,
}

#[derive(Default)]
pub(crate) struct DeliveryCheckRuntime {
    pub(crate) checks: HashMap<String, DeliveryCheck>,
}

#[derive(Debug, Clone)]
pub(crate) struct DeliveryCheck {
    pub(crate) project_id: String,
    pub(crate) task_ids: Vec<String>,
    pub(crate) reason: DeliveryCheckReason,
    /// What changed, for a check a probe asked for.
    pub(crate) context: Option<String>,
    pub(crate) session_id: String,
    pub(crate) runtime_epoch: u64,
    pub(crate) started_at_epoch_ms: u64,
    read: bool,
}

impl DeliveryCheck {
    /// A check of a Project's Tasks whose Agent is about to launch as this
    /// Session.
    pub(crate) fn starting(
        project_id: String,
        task_ids: Vec<String>,
        reason: DeliveryCheckReason,
        context: Option<String>,
        session_id: String,
        runtime_epoch: u64,
    ) -> Self {
        Self {
            project_id,
            task_ids,
            reason,
            context,
            session_id,
            runtime_epoch,
            started_at_epoch_ms: termloop_platform::current_epoch_ms(),
            read: false,
        }
    }
}

/// One delivery check's report, as the server decoded it from the MCP call.
#[derive(Debug, Clone, Default)]
pub struct DeliveryCheckReport {
    pub check_id: String,
    pub tasks: Vec<DeliveryCheckTaskReport>,
}

#[derive(Debug, Clone, Default)]
pub struct DeliveryCheckTaskReport {
    pub task_id: String,
    pub environments: Vec<DeliveryCheckEnvironment>,
    pub blockers: Option<String>,
    pub notes_markdown: String,
    pub ticket_proposal: Option<DeliveryCheckTicketProposal>,
}

#[derive(Debug, Clone)]
pub struct DeliveryCheckEnvironment {
    pub name: String,
    /// `deployed`, `inProgress`, `notDeployed`, or `unknown`.
    pub state: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DeliveryCheckTicketProposal {
    pub title: Option<String>,
    pub description: Option<String>,
    pub summary: String,
}

impl CoreRuntime {
    /// Holds a slot for a check whose Agent is about to launch.
    pub(crate) fn reserve_delivery_check(
        &mut self,
        check_id: String,
        check: DeliveryCheck,
    ) -> Result<(), CoreError> {
        if self.delivery_checks.checks.len() >= MAX_CHECKS {
            return Err(CoreError::HelperCapacityExhausted);
        }
        self.delivery_checks.checks.insert(check_id, check);
        Ok(())
    }

    /// The Tasks a running check of this Project covers, with its Session.
    pub fn running_delivery_checks(&self, project_id: &str) -> Vec<(String, Vec<String>)> {
        let mut running = self
            .delivery_checks
            .checks
            .values()
            .filter(|check| check.project_id == project_id)
            .map(|check| (check.session_id.clone(), check.task_ids.clone()))
            .collect::<Vec<_>>();
        running.sort();
        running
    }

    pub(crate) fn delivery_check_covers(&self, project_id: &str, task_id: &str) -> bool {
        self.delivery_checks.checks.values().any(|check| {
            check.project_id == project_id && check.task_ids.iter().any(|id| id == task_id)
        })
    }

    fn authenticated_delivery_check(
        &self,
        token: &str,
    ) -> Result<(String, DeliveryCheck), CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        if !self.store.sessions().iter().any(|session| {
            session.id == principal.session_id()
                && session.runtime_epoch == principal.runtime_epoch()
                && session.lifecycle_state == "running"
                && session.process.template_ref.as_deref() == Some(DELIVERY_CHECK_TEMPLATE)
        }) {
            return Err(CoreError::CapabilityDenied);
        }
        let AgentMcpRole::DeliveryCheck { check_id } = principal.role() else {
            return Err(CoreError::CapabilityDenied);
        };
        let check = self
            .delivery_checks
            .checks
            .get(check_id)
            .filter(|check| {
                check.session_id == principal.session_id()
                    && check.runtime_epoch == principal.runtime_epoch()
            })
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        if !self.is_project_manager_project(&check.project_id) {
            return Err(CoreError::TrackerReportStale);
        }
        Ok((check_id.clone(), check))
    }

    pub fn read_delivery_check(&mut self, token: &str) -> Result<Value, CoreError> {
        let (check_id, check) = self.authenticated_delivery_check(token)?;
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == check.project_id)
            .ok_or(CoreError::TrackerReportStale)?;
        let tasks = check
            .task_ids
            .iter()
            .filter_map(|task_id| self.task_record(task_id).ok())
            .filter(|task| task.status == termloop_domain::TaskStatus::Open)
            .map(|task| self.delivery_check_task_json(&task))
            .collect::<Vec<_>>();
        let result = json!({
            "checkId": check_id,
            "projectId": project.id,
            "projectName": project.name,
            "reason": check.reason,
            "context": check.context,
            "tasks": tasks,
        });
        if let Some(check) = self.delivery_checks.checks.get_mut(&check_id) {
            check.read = true;
        }
        Ok(result)
    }

    /// Records the check's one report: environment facts and notes for each
    /// Task it reported on, and a ticket proposal where it suggested one.
    pub fn record_delivery_check(
        &mut self,
        token: &str,
        report: DeliveryCheckReport,
        now_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let (check_id, check) = self.authenticated_delivery_check(token)?;
        if check_id != report.check_id || !check.read {
            return Err(CoreError::CapabilityDenied);
        }
        if report.tasks.is_empty() {
            return Err(CoreError::InvalidParams("tasks".into()));
        }
        let mut facts = Vec::new();
        let mut proposals = Vec::new();
        for (index, task_report) in report.tasks.iter().enumerate() {
            if !check.task_ids.contains(&task_report.task_id)
                || report.tasks[index + 1..]
                    .iter()
                    .any(|other| other.task_id == task_report.task_id)
            {
                return Err(CoreError::InvalidParams("taskId".into()));
            }
            let task = self.task_record(&task_report.task_id)?;
            if task.status != termloop_domain::TaskStatus::Open {
                return Err(CoreError::TrackerReportStale);
            }
            facts.push(self.reported_facts(task_report, now_epoch_ms)?);
            if let Some(proposal) = &task_report.ticket_proposal {
                proposals.push(self.reported_proposal(&task.id, proposal, now_epoch_ms)?);
            }
        }
        self.store
            .set_task_delivery_facts(&self.write_authority, facts)
            .map_err(store_error)?;
        for proposal in proposals {
            self.store
                .set_task_ticket_proposal(&self.write_authority, proposal)
                .map_err(store_error)?;
        }
        self.delivery_checks.checks.remove(&check_id);
        self.mcp_authorizer.remove(&check.session_id);
        Ok(json!({
            "projectId": check.project_id,
            "sessionId": check.session_id,
            "taskIds": report.tasks.iter().map(|task| task.task_id.clone()).collect::<Vec<_>>(),
        }))
    }

    fn reported_facts(
        &self,
        report: &DeliveryCheckTaskReport,
        now_epoch_ms: u64,
    ) -> Result<TaskDeliveryFacts, CoreError> {
        let invalid = |field: &str| CoreError::InvalidParams(field.into());
        if report.environments.len() > TASK_ENVIRONMENT_FACTS_MAX {
            return Err(invalid("environments"));
        }
        let notes = report.notes_markdown.trim();
        if notes.is_empty() || notes.len() > TASK_CHECK_NOTES_MAX_BYTES {
            return Err(invalid("notesMarkdown"));
        }
        let blockers = report
            .blockers
            .as_deref()
            .map(str::trim)
            .filter(|blockers| !blockers.is_empty());
        if blockers.is_some_and(|blockers| blockers.len() > TASK_TRACKING_TEXT_MAX_BYTES) {
            return Err(invalid("blockers"));
        }
        let mut facts = self
            .store
            .task_delivery_facts_for(&report.task_id)
            .cloned()
            .unwrap_or_else(|| TaskDeliveryFacts {
                task_id: report.task_id.clone(),
                ..TaskDeliveryFacts::default()
            });
        for environment in &report.environments {
            let name = environment.name.trim();
            let detail = environment
                .detail
                .as_deref()
                .map(str::trim)
                .filter(|detail| !detail.is_empty());
            let state = serde_json::from_value::<EnvironmentDeployState>(Value::String(
                environment.state.clone(),
            ))
            .map_err(|_| invalid("environments"))?;
            if name.is_empty()
                || name.chars().count() > TASK_TRACKING_SHORT_MAX_CHARS
                || detail
                    .is_some_and(|detail| detail.chars().count() > TASK_TRACKING_SHORT_MAX_CHARS)
            {
                return Err(invalid("environments"));
            }
            facts.observe_environment(
                name,
                state,
                detail.map(str::to_owned),
                FactSource::Check,
                now_epoch_ms,
            );
        }
        facts.check_notes = Some(CheckNotes {
            blockers: blockers.map(str::to_owned),
            markdown: notes.to_owned(),
            recorded_at_epoch_ms: now_epoch_ms,
        });
        if !facts.is_valid() {
            return Err(invalid("environments"));
        }
        Ok(facts)
    }

    fn reported_proposal(
        &self,
        task_id: &str,
        proposal: &DeliveryCheckTicketProposal,
        now_epoch_ms: u64,
    ) -> Result<TaskTicketProposal, CoreError> {
        let text = |value: &Option<String>| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let title = text(&proposal.title);
        let brief = text(&proposal.description);
        let summary = proposal.summary.trim().to_owned();
        if title
            .as_ref()
            .is_some_and(|title| title.chars().count() > TASK_TICKET_TITLE_MAX_CHARS)
            || brief
                .as_ref()
                .is_some_and(|brief| brief.chars().count() > TASK_TICKET_BRIEF_MAX_CHARS)
            || summary.chars().count() > TASK_TICKET_SUMMARY_MAX_CHARS
        {
            return Err(CoreError::InvalidParams("ticketProposal".into()));
        }
        let proposal = TaskTicketProposal {
            task_id: task_id.to_owned(),
            title,
            brief,
            summary,
            base_version: self
                .store
                .task_ticket_head(task_id)
                .map_or(0, |head| head.number),
            proposed_at_epoch_ms: now_epoch_ms,
        };
        if !proposal.is_valid() {
            return Err(CoreError::InvalidParams("ticketProposal".into()));
        }
        Ok(proposal)
    }

    /// Forgets a check whose Agent could not start.
    pub fn fail_delivery_check_launch(&mut self, check_id: &str) {
        if let Some(check) = self.delivery_checks.checks.remove(check_id) {
            self.mcp_authorizer.remove(&check.session_id);
        }
    }

    /// Forgets checks whose Agent exited, whose deadline passed, or whose
    /// Project left Project Manager mode, and returns every delivery check
    /// Session no running check owns, for termination and retirement.
    pub fn obsolete_delivery_check_sessions(&mut self, now_epoch_ms: u64) -> Vec<String> {
        let stale = self
            .delivery_checks
            .checks
            .iter()
            .filter(|(_, check)| {
                now_epoch_ms.saturating_sub(check.started_at_epoch_ms) > CHECK_DEADLINE_MS
                    || !self.is_project_manager_project(&check.project_id)
                    || self.store.sessions().iter().any(|session| {
                        session.id == check.session_id
                            && (session.lifecycle_state != "running"
                                || session.runtime_epoch != check.runtime_epoch)
                    })
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for check_id in stale {
            self.fail_delivery_check_launch(&check_id);
        }
        self.store
            .sessions()
            .iter()
            .filter(|session| {
                session.process.template_ref.as_deref() == Some(DELIVERY_CHECK_TEMPLATE)
                    && !self
                        .delivery_checks
                        .checks
                        .values()
                        .any(|check| check.session_id == session.id)
            })
            .map(|session| session.id.clone())
            .collect()
    }

    /// Deletes the descriptor of a delivery check Session that no longer runs.
    pub fn retire_delivery_check_descriptor(&mut self, session_id: &str) -> Result<(), CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        if session.process.template_ref.as_deref() != Some(DELIVERY_CHECK_TEMPLATE)
            || self
                .delivery_checks
                .checks
                .values()
                .any(|check| check.session_id == session_id)
            || self
                .terminal
                .contains_session(session_id)
                .map_err(crate::terminal_error)?
            || self.codex_runtimes.contains_key(session_id)
            || self.resume_reservations.contains(session_id)
        {
            return Err(CoreError::CapabilityDenied);
        }
        if session.lifecycle_state != "exited" {
            self.store
                .mark_session_exited(&self.write_authority, session_id)
                .map_err(store_error)?;
        }
        self.store
            .delete_session_descriptor(&self.write_authority, session_id)
            .map_err(store_error)?;
        let retired = self.retire_closed_session_runtime(session_id);
        debug_assert!(retired.is_none());
        self.mcp_authorizer.remove(session_id);
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests;
