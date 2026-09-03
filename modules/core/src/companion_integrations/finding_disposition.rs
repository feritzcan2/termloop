//! Runtime-only enforcement for Steward handling of actionable Routine findings.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;
use termloop_domain::RoutineActionHandling;

use super::steward::CurrentStewardWake;
use crate::{CoreError, CoreRuntime};

const MAX_TRACKED_FINDING_DISPOSITIONS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoutineFindingDispositionKey {
    project_id: String,
    finding_id: String,
    source_key: String,
    routine_generation: u64,
    steward_generation: u64,
}

#[derive(Debug)]
struct PendingRoutineFindingDisposition {
    project_id: String,
    runtime_epoch: u64,
    findings: Vec<RoutineFindingDispositionKey>,
}

#[derive(Debug, Default)]
pub(crate) struct StewardFindingDispositionRuntime {
    pending_by_session: HashMap<String, PendingRoutineFindingDisposition>,
    retried: VecDeque<RoutineFindingDispositionKey>,
    retry_wakes: VecDeque<CurrentStewardWake>,
}

impl StewardFindingDispositionRuntime {
    fn record_read(
        &mut self,
        session_id: &str,
        project_id: &str,
        runtime_epoch: u64,
        findings: Vec<RoutineFindingDispositionKey>,
    ) {
        if findings.is_empty() {
            self.pending_by_session.remove(session_id);
            return;
        }
        if !self.pending_by_session.contains_key(session_id)
            && self.pending_by_session.len() >= MAX_TRACKED_FINDING_DISPOSITIONS
            && let Some(stale_session_id) = self.pending_by_session.keys().next().cloned()
        {
            self.pending_by_session.remove(&stale_session_id);
        }
        self.pending_by_session.insert(
            session_id.to_owned(),
            PendingRoutineFindingDisposition {
                project_id: project_id.to_owned(),
                runtime_epoch,
                findings,
            },
        );
    }

    fn take_read(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Option<PendingRoutineFindingDisposition> {
        self.pending_by_session
            .remove(session_id)
            .filter(|pending| pending.runtime_epoch == runtime_epoch)
    }

    fn was_retried(&self, finding: &RoutineFindingDispositionKey) -> bool {
        self.retried.contains(finding)
    }

    fn record_retried(&mut self, findings: Vec<RoutineFindingDispositionKey>) {
        for finding in findings {
            if self.retried.contains(&finding) {
                continue;
            }
            if self.retried.len() >= MAX_TRACKED_FINDING_DISPOSITIONS {
                self.retried.pop_front();
            }
            self.retried.push_back(finding);
        }
    }

    fn enqueue_retry(&mut self, wake: CurrentStewardWake) {
        if self.retry_wakes.iter().any(|queued| {
            queued.project_id == wake.project_id && queued.generation == wake.generation
        }) {
            return;
        }
        if self.retry_wakes.len() >= MAX_TRACKED_FINDING_DISPOSITIONS {
            self.retry_wakes.pop_front();
        }
        self.retry_wakes.push_back(wake);
    }

    fn take_retries(&mut self) -> Vec<CurrentStewardWake> {
        self.retry_wakes.drain(..).collect()
    }
}

impl CoreRuntime {
    /// Reads current findings and arms a turn-local obligation for every
    /// actionable finding returned to this exact Steward Session.
    pub fn read_routine_findings_for_steward(
        &mut self,
        project_id: &str,
        session_id: &str,
    ) -> Result<Value, CoreError> {
        if !self.is_current_steward_session(project_id, session_id) {
            return Err(CoreError::CapabilityDenied);
        }
        let runtime_epoch = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id && session.project_id == project_id)
            .map(|session| session.runtime_epoch)
            .ok_or(CoreError::CapabilityDenied)?;
        let steward_generation = self
            .current_enabled_steward_wake(project_id)
            .map(|wake| wake.generation)
            .ok_or(CoreError::CapabilityDenied)?;
        let result = self.read_routine_findings(project_id)?;
        let findings = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|configuration| {
                configuration.project_id == project_id
                    && configuration.enabled
                    && matches!(
                        configuration.action_handling,
                        RoutineActionHandling::Ask | RoutineActionHandling::Auto
                    )
            })
            .flat_map(|configuration| {
                configuration
                    .pending_routine_findings
                    .iter()
                    .filter(|finding| self.routine_finding_is_current(configuration, finding))
                    .map(|finding| RoutineFindingDispositionKey {
                        project_id: project_id.to_owned(),
                        finding_id: finding.id.clone(),
                        source_key: finding.source_key.clone(),
                        routine_generation: finding.routine_generation,
                        steward_generation,
                    })
            })
            .collect();
        self.steward_finding_dispositions.record_read(
            session_id,
            project_id,
            runtime_epoch,
            findings,
        );
        Ok(result)
    }

    /// A Steward turn that read an actionable finding may not disappear into
    /// idle without resolving it or binding it to the one pending proposal.
    /// Retry each exact finding source state at most once.
    pub(crate) fn observe_steward_idle(&mut self, session_id: &str, runtime_epoch: u64) {
        let Some(pending) = self
            .steward_finding_dispositions
            .take_read(session_id, runtime_epoch)
        else {
            return;
        };
        if !self.is_current_steward_session(&pending.project_id, session_id) {
            return;
        }
        let pending_proposal = self
            .current_pending_companion_proposal(&pending.project_id)
            .and_then(|message| message.refs.as_ref());
        let unresolved = pending
            .findings
            .into_iter()
            .filter(|finding| {
                self.current_routine_finding(&finding.project_id, &finding.finding_id)
                    .is_some_and(|(configuration, current)| {
                        configuration.generation == finding.routine_generation
                            && current.source_key == finding.source_key
                    })
                    && pending_proposal
                        .is_none_or(|refs| !refs.references_routine_finding(&finding.finding_id))
                    && !self.steward_finding_dispositions.was_retried(finding)
            })
            .collect::<Vec<_>>();
        if unresolved.is_empty() {
            return;
        }
        let Some(wake) = self.current_enabled_steward_wake(&pending.project_id) else {
            return;
        };
        if unresolved
            .iter()
            .any(|finding| finding.steward_generation != wake.generation)
        {
            return;
        }
        self.steward_finding_dispositions.record_retried(unresolved);
        self.steward_finding_dispositions.enqueue_retry(wake);
    }

    pub fn take_steward_finding_disposition_retries(&mut self) -> Vec<CurrentStewardWake> {
        self.steward_finding_dispositions.take_retries()
    }
}
