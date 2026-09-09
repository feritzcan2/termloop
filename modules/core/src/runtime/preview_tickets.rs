//! Runtime-only ownership of inspected, single-use command payloads.

use std::collections::{HashSet, VecDeque};
use std::time::Duration;

use termloop_platform::MonotonicDeadline;

use crate::CoreError;
use crate::session_launch::{
    AgentLaunchPreviewTicket, AgentResumePreviewTicket, QuickActionPreviewTicket,
    SessionRelocationPreviewTicket, archive::SessionArchivePreviewTicket,
};
use crate::task_worktree::archive::TaskArchivePreviewTicket;

pub(crate) const PREVIEW_TTL_MS: u64 = 30_000;

#[derive(Default)]
pub(crate) struct PreviewTicketRuntime {
    // Quick Actions and improvers intentionally share a pool: attempting the
    // wrong flow consumes the ticket before that flow rejects its payload.
    pub(crate) quick_action: PreviewTicketPool<QuickActionPreviewTicket>,
    pub(crate) agent_launch: PreviewTicketPool<AgentLaunchPreviewTicket>,
    pub(crate) agent_resume: PreviewTicketPool<AgentResumePreviewTicket>,
    pub(crate) relocation: PreviewTicketPool<SessionRelocationPreviewTicket>,
    pub(crate) session_archive: PreviewTicketPool<SessionArchivePreviewTicket>,
    pub(crate) task_archive: PreviewTicketPool<TaskArchivePreviewTicket, 32>,
}

impl PreviewTicketRuntime {
    /// Called after the durable delete, while Core is still serialized. No
    /// authorization for the deleted Project or its subjects may survive it.
    pub(crate) fn invalidate_project(
        &mut self,
        project_id: &str,
        session_ids: &HashSet<String>,
        task_ids: &HashSet<String>,
    ) {
        self.quick_action
            .retain(|ticket| ticket.project_id() != project_id);
        self.agent_launch
            .retain(|ticket| ticket.project_id() != project_id);
        self.agent_resume
            .retain(|ticket| !session_ids.contains(ticket.session_id()));
        self.relocation
            .retain(|ticket| ticket.project_id() != project_id);
        self.session_archive
            .retain(|ticket| !session_ids.contains(ticket.session_id()));
        self.task_archive
            .retain(|ticket| !task_ids.contains(ticket.task_id()));
    }

    /// Assistant reset has a narrower scope than Project deletion. Ordinary
    /// launches and Task archives remain usable; all Project relocations expire.
    pub(crate) fn invalidate_assistant_reset(
        &mut self,
        project_id: &str,
        session_ids: &HashSet<String>,
    ) {
        self.quick_action.retain(|ticket| {
            ticket.project_id() != project_id || !ticket.is_assistant_prompt_improver()
        });
        self.agent_resume
            .retain(|ticket| !session_ids.contains(ticket.session_id()));
        self.session_archive
            .retain(|ticket| !session_ids.contains(ticket.session_id()));
        self.relocation
            .retain(|ticket| ticket.project_id() != project_id);
    }
}

struct Preview<T> {
    token: String,
    payload: T,
    deadline: MonotonicDeadline,
}

pub(crate) struct PreviewTicketPool<T, const CAPACITY: usize = 64> {
    entries: VecDeque<Preview<T>>,
}

impl<T, const CAPACITY: usize> Default for PreviewTicketPool<T, CAPACITY> {
    fn default() -> Self {
        assert!(CAPACITY > 0, "preview pools must have positive capacity");
        Self {
            entries: VecDeque::new(),
        }
    }
}

impl<T, const CAPACITY: usize> PreviewTicketPool<T, CAPACITY> {
    pub(crate) fn issue(&mut self, payload: T) -> Result<String, CoreError> {
        self.expire();
        if self.entries.len() >= CAPACITY {
            self.entries.pop_front();
        }
        let mut token = termloop_platform::generate_opaque_runtime_token();
        while self.entries.iter().any(|preview| preview.token == token) {
            token = termloop_platform::generate_opaque_runtime_token();
        }
        let deadline = MonotonicDeadline::after(Duration::from_millis(PREVIEW_TTL_MS))
            .map_err(|error| CoreError::Terminal(error.to_string()))?;
        self.entries.push_back(Preview {
            token: token.clone(),
            payload,
            deadline,
        });
        Ok(token)
    }

    /// Removing the payload is the one-time authority transition. Callers must
    /// validate their bindings after taking it and never restore it on failure.
    /// Core's mutable borrow keeps lookup and removal in one serialized command.
    pub(crate) fn consume_once(&mut self, token: &str) -> Option<T> {
        self.expire();
        let position = self
            .entries
            .iter()
            .position(|preview| preview.token == token)?;
        self.entries.remove(position).map(|preview| preview.payload)
    }

    pub(crate) fn discard(&mut self, token: &str) {
        self.entries.retain(|preview| preview.token != token);
    }

    fn expire(&mut self) {
        self.entries
            .retain(|preview| preview.deadline.remaining().is_some());
    }

    fn retain(&mut self, mut keep: impl FnMut(&T) -> bool) {
        self.entries.retain(|preview| keep(&preview.payload));
    }
}

#[cfg(test)]
mod tests;
