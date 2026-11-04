use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use super::AgentLaunchPlan;
use crate::{CoreError, CoreRuntime, required_string};
use serde_json::{Value, json};
use termloop_agents::{
    AgentHistoryPreviewRole, AgentHistoryScan, AgentHistoryScanIssue, DiscoveredAgentConversation,
};

const HISTORY_CACHE_REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);
const RECENT_CANDIDATES_PER_PROVIDER: usize = 20;
const FULL_CANDIDATES_PER_PROVIDER: usize = 200;
const MAX_CACHED_HISTORY: usize = 100;
const MAX_CACHED_PROJECTS: usize = 32;
const MAX_TASK_AGENT_TAIL_SESSIONS: usize = 8;

pub enum SessionHistoryListPlanOutcome {
    Current(Value),
    Observe(SessionHistoryScanPlan),
}

#[derive(Clone)]
pub struct SessionHistoryScanPlan {
    project_id: String,
    scope_paths: Vec<String>,
    fill_cache: bool,
    accounts: Vec<termloop_agents::AgentAccountContext>,
}

pub struct ObservedSessionHistoryScan {
    plan: SessionHistoryScanPlan,
    scan: AgentHistoryScan,
}

impl SessionHistoryScanPlan {
    pub fn observe(self, cancellation: &AtomicBool) -> ObservedSessionHistoryScan {
        ObservedSessionHistoryScan {
            scan: termloop_agents::scan_account_agent_history_cancellable_with_limit(
                &self.accounts,
                cancellation,
                if self.fill_cache {
                    FULL_CANDIDATES_PER_PROVIDER
                } else {
                    RECENT_CANDIDATES_PER_PROVIDER
                },
            ),
            plan: self,
        }
    }
}

#[derive(Clone)]
struct CachedHistoryEntry {
    handle: String,
    project_match: &'static str,
    /// Inactive Agent in another Project that owns this conversation; an
    /// import moves it into the listing Project.
    owner: Option<HistoryOwner>,
    conversation: DiscoveredAgentConversation,
}

#[derive(Clone)]
struct HistoryOwner {
    session_id: String,
    project_name: String,
}

#[derive(Clone)]
struct CachedManagedHistoryEntry {
    session_id: String,
    conversation: DiscoveredAgentConversation,
}

struct CachedProjectHistory {
    scope_paths: Vec<String>,
    entries: Vec<CachedHistoryEntry>,
    managed_entries: Vec<CachedManagedHistoryEntry>,
    issues: HistoryIssueCounts,
    scanned_at_epoch_ms: u64,
    cache_filled: bool,
    truncated: bool,
    refresh_after: termloop_platform::MonotonicDeadline,
}

#[derive(Clone, Copy, Default)]
struct HistoryIssueCounts {
    discovery_unavailable: u64,
    source_unreadable: u64,
    source_unrecognized: u64,
}

#[derive(Default)]
pub(crate) struct SessionHistoryRuntime {
    projects: HashMap<String, CachedProjectHistory>,
}

impl SessionHistoryRuntime {
    pub(crate) fn clear_accounts(&mut self) {
        self.projects.clear();
    }

    /// A moved Agent no longer belongs to its old Project's managed history.
    pub(crate) fn forget_managed_session(&mut self, session_id: &str) {
        for cached in self.projects.values_mut() {
            cached
                .managed_entries
                .retain(|entry| entry.session_id != session_id);
        }
    }
}

#[derive(Clone)]
pub struct SessionHistoryResumePlan {
    project_id: String,
    history_handle: String,
    conversation: DiscoveredAgentConversation,
}

pub struct ObservedSessionHistoryResume {
    plan: SessionHistoryResumePlan,
    cwd: String,
}

impl SessionHistoryResumePlan {
    pub fn observe(self) -> Result<ObservedSessionHistoryResume, CoreError> {
        let fresh =
            termloop_platform::read_bounded_history_file_slices(&self.conversation.source, 1, 1)
                .map_err(|_| CoreError::InvalidParams("historyHandle".into()))?;
        if fresh.modified_at_epoch_ms != self.conversation.source_modified_at_epoch_ms
            || fresh.size_bytes != self.conversation.source_size_bytes
            || fresh.window_sha256 != self.conversation.source_window_sha256
        {
            return Err(CoreError::InvalidParams("historyHandle".into()));
        }
        let cwd = termloop_platform::canonical_existing_directory(&self.conversation.cwd)
            .map_err(|_| CoreError::InvalidParams("historyHandle".into()))?
            .into_os_string()
            .into_string()
            .map_err(|_| CoreError::InvalidParams("historyHandle".into()))?;
        Ok(ObservedSessionHistoryResume { plan: self, cwd })
    }
}

fn same_account_conversation(
    session: &termloop_domain::SessionRecord,
    conversation: &DiscoveredAgentConversation,
) -> bool {
    session.resume_ref.as_ref() == Some(&conversation.resume_ref)
        && session
            .launch_selection
            .account_id
            .as_deref()
            .unwrap_or("default")
            == conversation.account_id
}

impl CoreRuntime {
    pub fn plan_session_history_list(
        &mut self,
        params: Value,
    ) -> Result<SessionHistoryListPlanOutcome, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let force = params.get("force").and_then(Value::as_bool) == Some(true);
        let fill_cache = params.get("fillCache").and_then(Value::as_bool) == Some(true);
        let scope_paths = self.session_history_scope_paths(&project_id)?;
        if !force
            && let Some(cached) = self.session_history.projects.get(&project_id)
            && cached.scope_paths == scope_paths
            && (!fill_cache || (cached.cache_filled && cached.refresh_after.remaining().is_some()))
        {
            return Ok(SessionHistoryListPlanOutcome::Current(history_result(
                cached,
            )));
        }
        Ok(SessionHistoryListPlanOutcome::Observe(
            SessionHistoryScanPlan {
                project_id,
                scope_paths,
                accounts: self
                    .store
                    .agent_accounts()
                    .iter()
                    .map(|account| {
                        self.resolve_agent_account(
                            account.agent_id.command(),
                            Some(&account.account_id),
                        )
                        .and_then(|context| context.ok_or(CoreError::NotFound))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                fill_cache,
            },
        ))
    }

    pub fn complete_session_history_list(
        &mut self,
        observed: ObservedSessionHistoryScan,
    ) -> Result<Value, CoreError> {
        let current_scope_paths = self.session_history_scope_paths(&observed.plan.project_id)?;
        if current_scope_paths != observed.plan.scope_paths
            || observed.plan.accounts.len() != self.store.agent_accounts().len()
        {
            return Err(CoreError::InvalidParams("projectId".into()));
        }
        let scope_identities = current_scope_paths
            .iter()
            .filter_map(|path| {
                termloop_platform::existing_directory_comparison_input(Path::new(path)).ok()
            })
            .collect::<Vec<_>>();
        let known_resume_refs = self
            .store
            .sessions()
            .iter()
            .chain(
                self.store
                    .deleted_sessions()
                    .iter()
                    .map(|deleted| &deleted.session),
            )
            .filter_map(|session| {
                session
                    .resume_ref
                    .as_ref()
                    .filter(|value| value.validate())
                    .map(|resume_ref| {
                        (
                            (
                                resume_ref.clone(),
                                session
                                    .launch_selection
                                    .account_id
                                    .as_deref()
                                    .unwrap_or("default")
                                    .to_owned(),
                            ),
                            session.id.clone(),
                            session.project_id.clone(),
                        )
                    })
            })
            .collect::<Vec<_>>();
        let foreign_worktrees = self.foreign_task_worktrees(&observed.plan.project_id);
        let mut matching = Vec::new();
        let mut outside = Vec::new();
        let mut managed_entries = Vec::new();
        for conversation in observed.scan.conversations {
            let mut owner = None;
            if let Some((_, session_id, session_project_id)) =
                known_resume_refs
                    .iter()
                    .find(|((resume_ref, account_id), _, _)| {
                        resume_ref == &conversation.resume_ref
                            && account_id == &conversation.account_id
                    })
            {
                if session_project_id == &observed.plan.project_id {
                    managed_entries.push(CachedManagedHistoryEntry {
                        session_id: session_id.clone(),
                        conversation,
                    });
                    continue;
                }
                let Some(found) = self.movable_history_owner(session_id, &observed.plan.project_id)
                else {
                    continue;
                };
                owner = Some(found);
            }
            let Ok(cwd_identity) = termloop_platform::existing_directory_comparison_input(
                Path::new(&conversation.cwd),
            ) else {
                continue;
            };
            if owner.is_some() {
                if !foreign_worktrees
                    .iter()
                    .any(|tree| contains_directory(tree, &cwd_identity))
                {
                    outside.push((owner, conversation));
                }
                continue;
            }
            let Some(project_match) = scope_identities.iter().find_map(|scope| {
                if scope.root() != cwd_identity.root()
                    || !cwd_identity.segments().starts_with(scope.segments())
                {
                    return None;
                }
                Some(if scope == &cwd_identity {
                    "exact"
                } else {
                    "related"
                })
            }) else {
                if !foreign_worktrees
                    .iter()
                    .any(|tree| contains_directory(tree, &cwd_identity))
                {
                    outside.push((None, conversation));
                }
                continue;
            };
            matching.push((project_match, conversation));
        }
        matching.sort_by(|(_, left), (_, right)| {
            right.updated_at_epoch_ms.cmp(&left.updated_at_epoch_ms)
        });
        outside.sort_by(|(_, left), (_, right)| {
            right.updated_at_epoch_ms.cmp(&left.updated_at_epoch_ms)
        });
        managed_entries.sort_by(|left, right| {
            right
                .conversation
                .updated_at_epoch_ms
                .cmp(&left.conversation.updated_at_epoch_ms)
        });
        managed_entries.truncate(MAX_CACHED_HISTORY);
        let truncated =
            observed.scan.candidate_limit_reached || matching.len() > MAX_CACHED_HISTORY;
        matching.truncate(MAX_CACHED_HISTORY);
        // Conversations outside this Project get their own bound so they never
        // crowd this Project's own history out of the cache.
        outside.truncate(MAX_CACHED_HISTORY);
        let existing_handles = self
            .session_history
            .projects
            .get(&observed.plan.project_id)
            .filter(|cached| cached.scope_paths == current_scope_paths)
            .map(|cached| {
                cached
                    .entries
                    .iter()
                    .map(|entry| {
                        (
                            (
                                entry.conversation.resume_ref.clone(),
                                entry.conversation.account_id.clone(),
                            ),
                            entry.handle.clone(),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let entries = matching
            .into_iter()
            .map(|(project_match, conversation)| (project_match, None, conversation))
            .chain(
                outside
                    .into_iter()
                    .map(|(owner, conversation)| ("outside", owner, conversation)),
            )
            .map(|(project_match, owner, conversation)| CachedHistoryEntry {
                handle: existing_handles
                    .iter()
                    .find(|((resume_ref, account_id), _)| {
                        resume_ref == &conversation.resume_ref
                            && account_id == &conversation.account_id
                    })
                    .map(|(_, handle)| handle.clone())
                    .unwrap_or_else(termloop_platform::generate_opaque_runtime_token),
                project_match,
                owner,
                conversation,
            })
            .collect();
        let issues = issue_counts(&observed.scan.issues);
        let refresh_after =
            termloop_platform::MonotonicDeadline::after(HISTORY_CACHE_REFRESH_INTERVAL)
                .map_err(|error| CoreError::Terminal(error.to_string()))?;
        if !self
            .session_history
            .projects
            .contains_key(&observed.plan.project_id)
            && self.session_history.projects.len() >= MAX_CACHED_PROJECTS
            && let Some(oldest) = self
                .session_history
                .projects
                .iter()
                .min_by_key(|(_, cached)| cached.scanned_at_epoch_ms)
                .map(|(project_id, _)| project_id.clone())
        {
            self.session_history.projects.remove(&oldest);
        }
        self.session_history.projects.insert(
            observed.plan.project_id.clone(),
            CachedProjectHistory {
                scope_paths: current_scope_paths,
                entries,
                managed_entries,
                issues,
                scanned_at_epoch_ms: termloop_platform::current_epoch_ms(),
                cache_filled: observed.plan.fill_cache,
                truncated,
                refresh_after,
            },
        );
        let cached = self
            .session_history
            .projects
            .get(&observed.plan.project_id)
            .expect("history cache inserted above");
        Ok(history_result(cached))
    }

    pub fn session_history_preview(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let session_id = required_string(&params, "sessionId")?;
        let resume_ref = self
            .store
            .sessions()
            .iter()
            .chain(
                self.store
                    .deleted_sessions()
                    .iter()
                    .map(|deleted| &deleted.session),
            )
            .find(|session| session.id == session_id && session.project_id == project_id)
            .ok_or(CoreError::NotFound)?
            .resume_ref
            .as_ref()
            .filter(|value| value.validate());
        let Some(resume_ref) = resume_ref else {
            return Err(CoreError::NotFound);
        };
        let provider = match resume_ref.provider {
            termloop_domain::ResumeProvider::Claude => "claude",
            termloop_domain::ResumeProvider::Codex => "codex",
            _ => return Err(CoreError::NotFound),
        };
        let Some(conversation) = self
            .session_history
            .projects
            .get(&project_id)
            .and_then(|cached| {
                cached.managed_entries.iter().find(|entry| {
                    entry.session_id == session_id && &entry.conversation.resume_ref == resume_ref
                })
            })
            .map(|entry| &entry.conversation)
        else {
            return Ok(unavailable_history_preview(provider));
        };
        Ok(json!({
            "status": "available",
            "provider": provider,
            "model": conversation.model,
            "updated_at_epoch_ms": conversation.updated_at_epoch_ms,
            "preview_messages": conversation.preview_messages.iter().map(|message| json!({
                "role": match message.role {
                    AgentHistoryPreviewRole::User => "user",
                    AgentHistoryPreviewRole::Assistant => "assistant",
                },
                "text": message.text,
            })).collect::<Vec<_>>(),
        }))
    }

    /// Returns only bounded provider-authored message tails for ordinary Agent
    /// Sessions whose current Project-scoped cwd projects into this Task's
    /// worktree. Session identity remains Project-scoped; this is a derived
    /// evidence view, not Task parentage or a durable transcript.
    pub fn task_agent_transcript_tail_projection_for_executor(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Value, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == project_id)
            .ok_or(CoreError::NotFound)?;
        let Some(worktree) = task.worktree.as_ref() else {
            return Ok(task_agent_tail_unavailable(
                task_id,
                "taskWorktreeUnavailable",
            ));
        };
        let Ok(worktree_key) = crate::task_worktree::comparison_key(Path::new(&worktree.path))
        else {
            return Ok(task_agent_tail_unavailable(
                task_id,
                "taskWorktreeUnreadable",
            ));
        };
        let assistant_session_ids = self
            .store
            .steward_configurations()
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .filter_map(|configuration| configuration.executor_session_id.as_deref())
            .collect::<std::collections::HashSet<_>>();
        let cached = self.session_history.projects.get(project_id);
        let mut sessions = self
            .store
            .sessions()
            .iter()
            .filter(|session| {
                session.project_id == project_id
                    && session.kind == termloop_domain::SessionKind::Agent
                    && session.ask_to_source_session_id.is_none()
                    && session.improver_target.is_none()
                    && !assistant_session_ids.contains(session.id.as_str())
                    && crate::task_worktree::comparison_key(Path::new(&session.process.cwd))
                        .is_ok_and(|session_key| worktree_key.contains_or_equals(&session_key))
            })
            .map(|session| {
                let conversation = session.resume_ref.as_ref().and_then(|resume_ref| {
                    cached.and_then(|cached| {
                        cached.managed_entries.iter().find(|entry| {
                            entry.session_id == session.id
                                && &entry.conversation.resume_ref == resume_ref
                        })
                    })
                });
                let updated_at_epoch_ms = conversation
                    .map(|entry| entry.conversation.updated_at_epoch_ms)
                    .unwrap_or(0);
                let value = if let Some(entry) = conversation {
                    json!({
                        "sessionId": session.id,
                        "status": "available",
                        "provider": entry.conversation.agent_id,
                        "updatedAtEpochMs": entry.conversation.updated_at_epoch_ms,
                        "messages": entry.conversation.tail_messages.iter().map(|message| json!({
                            "role": match message.role {
                                AgentHistoryPreviewRole::User => "user",
                                AgentHistoryPreviewRole::Assistant => "assistant",
                            },
                            "text": message.text,
                        })).collect::<Vec<_>>(),
                    })
                } else {
                    json!({
                        "sessionId": session.id,
                        "status": "unavailable",
                        "provider": session.process.agent_id,
                        "updatedAtEpochMs": null,
                        "messages": [],
                    })
                };
                (updated_at_epoch_ms, session.id.as_str(), value)
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(right.1)));
        let session_limit_reached = sessions.len() > MAX_TASK_AGENT_TAIL_SESSIONS;
        sessions.truncate(MAX_TASK_AGENT_TAIL_SESSIONS);
        let sessions = sessions
            .into_iter()
            .map(|(_, _, value)| value)
            .collect::<Vec<_>>();
        let available = sessions
            .iter()
            .any(|session| session["status"] == "available");
        let Some(cached) = cached else {
            return Ok(json!({
                "taskId": task_id,
                "status": "unavailable",
                "reason": "historyNotScanned",
                "sessions": sessions,
                "sessionLimitReached": session_limit_reached,
                "candidateLimitReached": false,
            }));
        };
        Ok(json!({
            "taskId": task_id,
            "status": if available { "available" } else { "unavailable" },
            "reason": if sessions.is_empty() {
                Some("noTaskAgentSessions")
            } else if available {
                None
            } else {
                Some("transcriptUnavailable")
            },
            "sessions": sessions,
            "sessionLimitReached": session_limit_reached,
            "candidateLimitReached": cached.truncated,
            "scanIssues": {
                "discoveryUnavailable": cached.issues.discovery_unavailable,
                "sourceUnreadable": cached.issues.source_unreadable,
                "sourceUnrecognized": cached.issues.source_unrecognized,
            },
        }))
    }

    pub fn plan_session_history_resume(
        &mut self,
        params: &Value,
    ) -> Result<SessionHistoryResumePlan, CoreError> {
        let project_id = required_string(params, "projectId")?;
        let history_handle = required_string(params, "historyHandle")?;
        let current_scope_paths = self.session_history_scope_paths(&project_id)?;
        let entry = self
            .session_history
            .projects
            .get(&project_id)
            .filter(|cached| cached.scope_paths == current_scope_paths)
            .and_then(|cached| {
                cached
                    .entries
                    .iter()
                    .find(|entry| entry.handle == history_handle)
            })
            .ok_or_else(|| CoreError::InvalidParams("historyHandle".into()))?;
        let moved_session_id = entry.owner.as_ref().map(|owner| owner.session_id.clone());
        let conversation = entry.conversation.clone();
        if !self.history_conversation_available(
            &conversation,
            moved_session_id.as_deref(),
            &project_id,
        ) {
            return Err(CoreError::InvalidParams("historyHandle".into()));
        }
        Ok(SessionHistoryResumePlan {
            project_id,
            history_handle,
            conversation,
        })
    }

    pub fn complete_session_history_resume_preview(
        &mut self,
        observed: ObservedSessionHistoryResume,
        params: &Value,
    ) -> Result<Value, CoreError> {
        if required_string(params, "projectId")? != observed.plan.project_id
            || required_string(params, "historyHandle")? != observed.plan.history_handle
        {
            return Err(CoreError::InvalidParams("historyHandle".into()));
        }
        let current_scope_paths = self.session_history_scope_paths(&observed.plan.project_id)?;
        let cached = self
            .session_history
            .projects
            .get(&observed.plan.project_id)
            .filter(|cached| cached.scope_paths == current_scope_paths)
            .and_then(|cached| {
                cached
                    .entries
                    .iter()
                    .find(|entry| entry.handle == observed.plan.history_handle)
            })
            .ok_or_else(|| CoreError::InvalidParams("historyHandle".into()))?;
        let moved_session_id = cached.owner.as_ref().map(|owner| owner.session_id.clone());
        if cached.conversation.account_id != observed.plan.conversation.account_id
            || cached.conversation.resume_ref != observed.plan.conversation.resume_ref
            || (cached.project_match != "outside"
                && project_match(&current_scope_paths, &observed.cwd).is_none())
            || (cached.project_match == "outside"
                && self.inside_foreign_task_worktree(&observed.plan.project_id, &observed.cwd))
            || !self.history_conversation_available(
                &observed.plan.conversation,
                moved_session_id.as_deref(),
                &observed.plan.project_id,
            )
        {
            return Err(CoreError::InvalidParams("historyHandle".into()));
        }
        // A moved Agent keeps the name the person gave it in its old Project.
        let history_name = moved_session_id
            .as_deref()
            .and_then(|session_id| {
                self.store
                    .sessions()
                    .iter()
                    .find(|session| session.id == session_id)
                    .and_then(|session| session.name.clone())
            })
            .unwrap_or_else(|| observed.plan.conversation.title.clone());
        let mut launch_params = json!({
            "projectId": observed.plan.project_id,
            "cwd": observed.cwd,
            "agentId": observed.plan.conversation.agent_id,
            "accountId": observed.plan.conversation.account_id,
        });
        for key in ["model", "permission", "reasoning"] {
            if let Some(value) = params.get(key) {
                launch_params[key] = value.clone();
            }
        }
        let mut launch = self.plan_agent_launch(launch_params)?;
        launch.resume_ref = None;
        launch.history_source_handle = Some(observed.plan.history_handle);
        launch.history_source_ref = Some(observed.plan.conversation.resume_ref.clone());
        launch.history_name = Some(history_name);
        launch.history_moved_session_id = moved_session_id;
        launch.history_source = Some(observed.plan.conversation);
        self.cache_agent_launch_preview(launch)
    }

    /// Task worktrees of other Projects. Their cleanup gates see only their
    /// own Project's Sessions, so no Session of this Project may run in one.
    fn foreign_task_worktrees(
        &self,
        project_id: &str,
    ) -> Vec<termloop_platform::PathComparisonInput> {
        self.store
            .tasks()
            .iter()
            .filter(|task| task.project_id != project_id)
            .filter_map(|task| task.worktree.as_ref())
            .filter_map(|worktree| {
                termloop_platform::existing_directory_comparison_input(Path::new(&worktree.path))
                    .ok()
            })
            .collect()
    }

    fn inside_foreign_task_worktree(&self, project_id: &str, cwd: &str) -> bool {
        let Ok(cwd) = termloop_platform::existing_directory_comparison_input(Path::new(cwd)) else {
            return true;
        };
        self.foreign_task_worktrees(project_id)
            .iter()
            .any(|tree| contains_directory(tree, &cwd))
    }

    /// No Session may own the conversation except the one inactive Agent in
    /// another Project that this import moves, and that Agent must still be
    /// safe to move.
    fn history_conversation_available(
        &self,
        conversation: &DiscoveredAgentConversation,
        moved_session_id: Option<&str>,
        project_id: &str,
    ) -> bool {
        if moved_session_id
            .is_some_and(|session_id| self.movable_history_owner(session_id, project_id).is_none())
        {
            return false;
        }
        !self.store.sessions().iter().any(|session| {
            Some(session.id.as_str()) != moved_session_id
                && same_account_conversation(session, conversation)
        }) && !self
            .store
            .deleted_sessions()
            .iter()
            .any(|deleted| same_account_conversation(&deleted.session, conversation))
    }

    /// An ordinary inactive Agent owned by another Project, with no process,
    /// reservation, archive, relocation, or assistant role holding it.
    fn movable_history_owner(&self, session_id: &str, project_id: &str) -> Option<HistoryOwner> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)?;
        let ordinary = session.kind == termloop_domain::SessionKind::Agent
            && session.project_id != project_id
            && session.archived_at_epoch_ms.is_none()
            && matches!(
                session.lifecycle_state.as_str(),
                "exited" | "stale" | "resumeFailed"
            )
            && !matches!(
                session.resume_failure,
                Some(
                    termloop_domain::ResumeFailureReason::RuntimeOwnershipUncertain
                        | termloop_domain::ResumeFailureReason::RuntimeConflict
                )
            )
            && session.run_configuration_id.is_none()
            && session.improver_target.is_none()
            && session.ask_to_source_session_id.is_none()
            && session.process.template_ref.as_deref() != Some("builtin.agent.ask-to-helper");
        let held = self.resume_reservations.contains(session_id)
            || self
                .provider_history_repair_reservations
                .contains(session_id)
            || self.codex_runtimes.contains_key(session_id)
            || self.session_is_archive_suspended(session_id)
            || self
                .store
                .session_archive_operations()
                .iter()
                .any(|operation| operation.session_id == session_id)
            || self
                .store
                .session_relocation_operations()
                .iter()
                .any(|operation| operation.session_id == session_id)
            || self
                .store
                .steward_project_for_executor_session(session_id)
                .is_some()
            || self.terminal.contains_session(session_id).unwrap_or(true);
        if !ordinary || held {
            return None;
        }
        let project_name = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == session.project_id)?
            .name
            .clone();
        Some(HistoryOwner {
            session_id: session.id.clone(),
            project_name,
        })
    }

    fn session_history_scope_paths(&self, project_id: &str) -> Result<Vec<String>, CoreError> {
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?;
        let mut paths = vec![project.folder_path.clone()];
        paths.extend(
            self.store
                .tasks()
                .iter()
                .filter(|task| task.project_id == project_id)
                .filter_map(|task| task.worktree.as_ref().map(|worktree| worktree.path.clone())),
        );
        paths.sort();
        paths.dedup();
        Ok(paths)
    }

    pub(super) fn validate_history_launch_plan(
        &self,
        plan: &AgentLaunchPlan,
    ) -> Result<(), CoreError> {
        let Some(handle) = plan.history_source_handle.as_deref() else {
            return Ok(());
        };
        let source_ref = plan
            .history_source_ref
            .as_ref()
            .ok_or_else(|| CoreError::InvalidParams("historyHandle".into()))?;
        let entry = self
            .session_history
            .projects
            .get(&plan.project_id)
            .and_then(|cached| {
                cached.entries.iter().find(|entry| {
                    entry.handle == handle
                        && &entry.conversation.resume_ref == source_ref
                        && plan.account.as_ref().is_some_and(|account| {
                            account.account_id == entry.conversation.account_id
                        })
                })
            });
        let valid = entry.is_some_and(|entry| {
            entry.owner.as_ref().map(|owner| owner.session_id.as_str())
                == plan.history_moved_session_id.as_deref()
                && self.history_conversation_available(
                    &entry.conversation,
                    plan.history_moved_session_id.as_deref(),
                    &plan.project_id,
                )
        });
        if !valid {
            return Err(CoreError::InvalidParams("historyHandle".into()));
        }
        Ok(())
    }

    pub(super) fn consume_history_handle(&mut self, plan: &AgentLaunchPlan) {
        let Some(handle) = plan.history_source_handle.as_deref() else {
            return;
        };
        if let Some(cached) = self.session_history.projects.get_mut(&plan.project_id) {
            cached.entries.retain(|entry| entry.handle != handle);
        }
    }
}

fn history_result(cached: &CachedProjectHistory) -> Value {
    let entries = cached
        .entries
        .iter()
        .map(|entry| {
            json!({
                "history_handle": entry.handle,
                "provider": entry.conversation.agent_id,
                "title": entry.conversation.title,
                "cwd": entry.conversation.cwd,
                "branch": entry.conversation.branch,
                "model": entry.conversation.model,
                "updated_at_epoch_ms": entry.conversation.updated_at_epoch_ms,
                "project_match": entry.project_match,
                "owner_project_name": entry.owner.as_ref().map(|owner| owner.project_name.as_str()),
                "preview_messages": entry.conversation.preview_messages.iter().map(|message| json!({
                    "role": match message.role {
                        AgentHistoryPreviewRole::User => "user",
                        AgentHistoryPreviewRole::Assistant => "assistant",
                    },
                    "text": message.text,
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "entries": entries,
        "issues": {
            "discovery_unavailable": cached.issues.discovery_unavailable,
            "source_unreadable": cached.issues.source_unreadable,
            "source_unrecognized": cached.issues.source_unrecognized,
        },
        "scanned_at_epoch_ms": cached.scanned_at_epoch_ms,
        "cache_filled": cached.cache_filled,
        "truncated": cached.truncated,
    })
}

fn unavailable_history_preview(provider: &str) -> Value {
    json!({
        "status": "unavailable",
        "provider": provider,
        "model": null,
        "updated_at_epoch_ms": null,
        "preview_messages": [],
    })
}

fn task_agent_tail_unavailable(task_id: &str, reason: &str) -> Value {
    json!({
        "taskId": task_id,
        "status": "unavailable",
        "reason": reason,
        "sessions": [],
        "sessionLimitReached": false,
        "candidateLimitReached": false,
    })
}

fn issue_counts(issues: &[AgentHistoryScanIssue]) -> HistoryIssueCounts {
    let mut counts = HistoryIssueCounts::default();
    for issue in issues {
        match issue {
            AgentHistoryScanIssue::HomeUnavailable
            | AgentHistoryScanIssue::ClaudeDiscoveryUnavailable
            | AgentHistoryScanIssue::CodexDiscoveryUnavailable => counts.discovery_unavailable += 1,
            AgentHistoryScanIssue::SourceUnreadable => counts.source_unreadable += 1,
            AgentHistoryScanIssue::SourceUnrecognized => counts.source_unrecognized += 1,
        }
    }
    counts
}

fn contains_directory(
    root: &termloop_platform::PathComparisonInput,
    path: &termloop_platform::PathComparisonInput,
) -> bool {
    root.root() == path.root() && path.segments().starts_with(root.segments())
}

fn project_match(scope_paths: &[String], cwd: &str) -> Option<&'static str> {
    let cwd_identity =
        termloop_platform::existing_directory_comparison_input(Path::new(cwd)).ok()?;
    scope_paths.iter().find_map(|scope| {
        let scope =
            termloop_platform::existing_directory_comparison_input(Path::new(scope)).ok()?;
        if scope.root() != cwd_identity.root()
            || !cwd_identity.segments().starts_with(scope.segments())
        {
            return None;
        }
        Some(if scope == cwd_identity {
            "exact"
        } else {
            "related"
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_agents::{AgentHistoryPreviewMessage, AgentHistoryPreviewRole};
    use termloop_domain::{
        ManagedWorktreeProof, NormalizedWorktreeSpec, ProcessDescriptor, ProvisioningBranchMode,
        ProvisioningStage, ResumeProvider, ResumeRef, SessionKind, SessionRecord,
        TaskBranchBinding, TaskRecord, TaskStatus, TaskWorktreeBinding,
        WorktreeProvisioningOperation,
    };
    use termloop_store::{BeginProvisioningOutcome, ProvisioningCommit, Store};
    use termloop_terminal::TerminalService;
    use uuid::Uuid;

    fn fixture() -> (
        CoreRuntime,
        String,
        String,
        std::path::PathBuf,
        DiscoveredAgentConversation,
    ) {
        let root = std::env::temp_dir().join(format!(
            "termloop-session-history-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let provider_root = root.join("provider-history");
        std::fs::create_dir_all(&provider_root).unwrap();
        let source_path = provider_root.join("conversation.jsonl");
        std::fs::write(&source_path, b"{\"type\":\"fixture\"}\n").unwrap();
        let source =
            termloop_platform::discover_bounded_history_files(&provider_root, "jsonl", 0, 1)
                .unwrap()
                .pop()
                .unwrap();
        let slices = termloop_platform::read_bounded_history_file_slices(&source, 32, 32).unwrap();
        let checkout = root.join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(root.join("state.json")).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        let project = runtime
            .handle(
                "project.create",
                json!({"name":"History","folderPath":checkout}),
            )
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        let native_id = Uuid::new_v4().to_string();
        let conversation = DiscoveredAgentConversation {
            account_id: "default".into(),
            resume_ref: ResumeRef::for_provider(ResumeProvider::Claude, native_id.clone()).unwrap(),
            agent_id: "claude".into(),
            title: "A deliberately long external conversation title that must be bounded before it becomes a TermLoop Session name".into(),
            cwd: checkout.display().to_string(),
            branch: Some("task/history".into()),
            model: Some("sonnet".into()),
            updated_at_epoch_ms: slices.modified_at_epoch_ms,
            preview_messages: vec![AgentHistoryPreviewMessage {
                role: AgentHistoryPreviewRole::User,
                text: "Inspect the release pipeline".into(),
            }],
            tail_messages: vec![
                AgentHistoryPreviewMessage {
                    role: AgentHistoryPreviewRole::User,
                    text: "Please finish the release pipeline".into(),
                },
                AgentHistoryPreviewMessage {
                    role: AgentHistoryPreviewRole::Assistant,
                    text: "Implemented it; focused tests passed.".into(),
                },
            ],
            source,
            source_modified_at_epoch_ms: slices.modified_at_epoch_ms,
            source_size_bytes: slices.size_bytes,
            source_window_sha256: slices.window_sha256,
        };
        (runtime, project_id, native_id, root, conversation)
    }

    fn provision_task_worktree(
        runtime: &mut CoreRuntime,
        project_id: &str,
        root: &Path,
        task_id: &str,
    ) -> String {
        let project_id = project_id.to_owned();
        let worktree = root.join(format!("{task_id}-worktree"));
        std::fs::create_dir_all(&worktree).unwrap();
        let worktree = worktree.to_string_lossy().into_owned();
        runtime
            .store
            .insert_task(
                &runtime.write_authority,
                TaskRecord {
                    id: task_id.into(),
                    project_id: project_id.clone(),
                    title: "Finish release pipeline".into(),
                    brief: None,
                    developer_notes: vec![],
                    status: TaskStatus::Open,
                    archived_at_epoch_ms: None,
                    branch: None,
                    worktree: None,
                    worktree_generation: 0,
                    steward_brief_markdown: String::new(),
                    steward_brief_revision: 1,
                    rank: 1,
                    created_at_epoch_ms: 1,
                    updated_at_epoch_ms: 1,
                },
            )
            .unwrap();
        let repository_root = root.to_string_lossy().into_owned();
        let operation_id = "provision-task-agent-tail";
        let spec = NormalizedWorktreeSpec {
            version: 1,
            repository_root: repository_root.clone(),
            repository_common_dir: format!("{repository_root}/.git"),
            destination_path: worktree.clone(),
            branch_name: "task/release".into(),
            branch_mode: ProvisioningBranchMode::Create,
            base_ref: Some("refs/heads/main".into()),
            base_oid: Some("a".repeat(40)),
        };
        assert!(matches!(
            runtime
                .store
                .begin_task_worktree_provisioning(
                    &runtime.write_authority,
                    WorktreeProvisioningOperation {
                        operation_id: operation_id.into(),
                        task_id: task_id.into(),
                        project_id: project_id.clone(),
                        spec: spec.clone(),
                        stage: ProvisioningStage::Reserved,
                        created_branch_ref: false,
                        failure: None,
                        started_at_epoch_ms: 2,
                        updated_at_epoch_ms: 2,
                    },
                )
                .unwrap(),
            BeginProvisioningOutcome::Started(_)
        ));
        runtime
            .store
            .advance_task_worktree_provisioning(
                &runtime.write_authority,
                task_id,
                operation_id,
                ProvisioningStage::WorktreeAdded,
                true,
                3,
            )
            .unwrap();
        runtime
            .store
            .commit_task_worktree_provisioning(
                &runtime.write_authority,
                task_id,
                operation_id,
                ProvisioningCommit {
                    branch: TaskBranchBinding {
                        repository_root: repository_root.clone(),
                        name: "task/release".into(),
                    },
                    worktree: TaskWorktreeBinding {
                        path: worktree.clone(),
                    },
                    proof: ManagedWorktreeProof {
                        task_id: task_id.into(),
                        operation_id: operation_id.into(),
                        worktree_generation: 0,
                        normalized_spec_version: 1,
                        normalized_spec: spec,
                        repository_common_dir: format!("{repository_root}/.git"),
                        registered_worktree_path: worktree.clone(),
                        branch_ref: "refs/heads/task/release".into(),
                    },
                    updated_at_epoch_ms: 4,
                },
            )
            .unwrap();
        runtime
            .store
            .clear_task_worktree_provisioning(&runtime.write_authority, task_id, operation_id)
            .unwrap();
        worktree
    }

    #[test]
    fn task_agent_tail_is_scoped_to_ordinary_sessions_in_the_task_worktree() {
        let (mut runtime, project_id, native_id, root, mut conversation) = fixture();
        let task_id = "task-with-agent";
        let worktree = provision_task_worktree(&mut runtime, &project_id, &root, task_id);
        conversation.cwd = worktree.clone();
        let session_id = "task-agent-session";
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    id: session_id.into(),
                    project_id: project_id.clone(),
                    name: Some("Developer".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: Vec::new(),
                        cwd: worktree.clone(),
                        agent_id: Some("claude".into()),
                        template_ref: Some("builtin.agent.task-kickoff".into()),
                        template_version: Some(7),
                    },
                    launch_selection: Default::default(),
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    fork_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: Some(conversation.resume_ref.clone()),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        let legacy_steward_session_id = "legacy-steward-task-agent";
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    id: legacy_steward_session_id.into(),
                    project_id: project_id.clone(),
                    name: Some("Legacy Steward Agent".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: Vec::new(),
                        cwd: worktree.clone(),
                        agent_id: Some("claude".into()),
                        template_ref: Some("builtin.steward.task-assignment".into()),
                        template_version: Some(1),
                    },
                    launch_selection: Default::default(),
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    fork_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    id: "helper-in-task-worktree".into(),
                    project_id: project_id.clone(),
                    name: Some("Helper".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: Vec::new(),
                        cwd: worktree,
                        agent_id: Some("claude".into()),
                        template_ref: Some("builtin.agent.ask-to-helper".into()),
                        template_version: Some(1),
                    },
                    launch_selection: Default::default(),
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: Some(session_id.into()),
                    fork_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        let plan = match runtime
            .plan_session_history_list(json!({
                "projectId": project_id,
                "force": true,
                "fillCache": true,
            }))
            .unwrap()
        {
            SessionHistoryListPlanOutcome::Observe(plan) => plan,
            SessionHistoryListPlanOutcome::Current(_) => panic!("forced list must scan"),
        };
        runtime
            .complete_session_history_list(ObservedSessionHistoryScan {
                plan,
                scan: AgentHistoryScan {
                    conversations: vec![conversation],
                    issues: Vec::new(),
                    candidate_limit_reached: false,
                },
            })
            .unwrap();

        let tail = runtime
            .task_agent_transcript_tail_projection_for_executor(&project_id, task_id)
            .unwrap();
        assert_eq!(tail["status"], "available");
        let tail_sessions = tail["sessions"].as_array().unwrap();
        assert_eq!(tail_sessions.len(), 2);
        let developer_tail = tail_sessions
            .iter()
            .find(|session| session["sessionId"] == session_id)
            .unwrap();
        assert_eq!(
            developer_tail["messages"][1]["text"],
            "Implemented it; focused tests passed."
        );
        let coordination = runtime
            .task_coordination_agent_projection_for_executor(&project_id, task_id)
            .unwrap();
        assert_eq!(coordination["state"], "selected");
        assert_eq!(coordination["sessionId"], session_id);
        assert_eq!(coordination["reason"], "preferredNonStewardTaskAgent");
        assert!(
            runtime
                .ensure_task_agent_request_target_for_executor(&project_id, task_id, session_id)
                .is_ok()
        );
        assert!(matches!(
            runtime.ensure_task_agent_request_target_for_executor(
                &project_id,
                task_id,
                legacy_steward_session_id,
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.ensure_task_agent_request_target_for_executor(
                &project_id,
                task_id,
                "helper-in-task-worktree",
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime
                .ensure_task_agent_request_target_for_executor(&project_id, task_id, &native_id,),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(!tail.to_string().contains("helper-in-task-worktree"));
        assert!(!tail.to_string().contains("provider-history"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn list_caches_opaque_handles_and_preview_binds_the_native_resume_privately() {
        let (mut runtime, project_id, native_id, root, conversation) = fixture();
        let full_conversation = conversation.clone();
        let plan = match runtime
            .plan_session_history_list(json!({"projectId": project_id}))
            .unwrap()
        {
            SessionHistoryListPlanOutcome::Observe(plan) => plan,
            SessionHistoryListPlanOutcome::Current(_) => panic!("first list must scan"),
        };
        let source_path = conversation.source.path().display().to_string();
        let result = runtime
            .complete_session_history_list(ObservedSessionHistoryScan {
                plan,
                scan: AgentHistoryScan {
                    conversations: vec![conversation],
                    issues: vec![AgentHistoryScanIssue::SourceUnreadable],
                    candidate_limit_reached: false,
                },
            })
            .unwrap();
        let handle = result["entries"][0]["history_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(handle.len(), 64);
        assert!(!result.to_string().contains(&native_id));
        assert!(!result.to_string().contains(&source_path));
        assert_eq!(result["issues"]["source_unreadable"], 1);

        let cached = match runtime
            .plan_session_history_list(json!({"projectId": project_id}))
            .unwrap()
        {
            SessionHistoryListPlanOutcome::Current(value) => value,
            SessionHistoryListPlanOutcome::Observe(_) => panic!("fresh cache must be reused"),
        };
        assert_eq!(cached["entries"][0]["history_handle"], handle);
        assert_eq!(cached["cache_filled"], false);

        let fill_plan = match runtime
            .plan_session_history_list(json!({"projectId": project_id, "fillCache": true}))
            .unwrap()
        {
            SessionHistoryListPlanOutcome::Observe(plan) => plan,
            SessionHistoryListPlanOutcome::Current(_) => {
                panic!("a recent-only cache must be filled in the background")
            }
        };
        let filled = runtime
            .complete_session_history_list(ObservedSessionHistoryScan {
                plan: fill_plan,
                scan: AgentHistoryScan {
                    conversations: vec![full_conversation],
                    issues: Vec::new(),
                    candidate_limit_reached: false,
                },
            })
            .unwrap();
        assert_eq!(filled["cache_filled"], true);
        assert_eq!(filled["entries"][0]["history_handle"], handle);
        runtime
            .session_history
            .projects
            .get_mut(&project_id)
            .unwrap()
            .refresh_after = termloop_platform::MonotonicDeadline::after(Duration::ZERO).unwrap();
        std::thread::sleep(Duration::from_millis(1));
        assert!(matches!(
            runtime
                .plan_session_history_list(json!({"projectId": project_id}))
                .unwrap(),
            SessionHistoryListPlanOutcome::Current(_)
        ));
        assert!(matches!(
            runtime
                .plan_session_history_list(json!({"projectId": project_id, "fillCache": true}))
                .unwrap(),
            SessionHistoryListPlanOutcome::Observe(_)
        ));

        let resume_params = json!({"projectId":project_id,"historyHandle":handle});
        let observed = runtime
            .plan_session_history_resume(&resume_params)
            .unwrap()
            .observe()
            .unwrap();
        let preview = runtime
            .complete_session_history_resume_preview(observed, &resume_params)
            .unwrap();
        assert_eq!(preview["manifest"]["target"]["conversation"], "resume");
        assert!(!preview.to_string().contains(&native_id));
        let mut launch = runtime
            .take_agent_launch(json!({
                "projectId": project_id,
                "historyHandle": handle,
                "launchTicket": preview["launch_ticket"],
            }))
            .unwrap();
        assert_eq!(
            launch
                .history_source_ref
                .as_ref()
                .unwrap()
                .native_session_id,
            native_id
        );
        assert_eq!(
            super::super::launch_session_name(&launch)
                .unwrap()
                .chars()
                .count(),
            80
        );
        launch.prepare_runtime();
        runtime.validate_history_launch_plan(&launch).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn managed_and_deleted_sessions_expose_only_a_bounded_cached_preview() {
        let (mut runtime, project_id, native_id, root, conversation) = fixture();
        let session_id = "managed-history-session";
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    id: session_id.into(),
                    project_id: project_id.clone(),
                    name: Some("Managed history".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: Vec::new(),
                        cwd: conversation.cwd.clone(),
                        agent_id: Some("claude".into()),
                        template_ref: Some("builtin.agent.interactive".into()),
                        template_version: Some(1),
                    },
                    launch_selection: Default::default(),
                    lifecycle_state: "exited".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    fork_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: Some(conversation.resume_ref.clone()),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        let preview_params = json!({"projectId": project_id, "sessionId": session_id});
        assert_eq!(
            runtime
                .session_history_preview(preview_params.clone())
                .unwrap()["status"],
            "unavailable"
        );

        let plan = match runtime
            .plan_session_history_list(json!({"projectId": project_id}))
            .unwrap()
        {
            SessionHistoryListPlanOutcome::Observe(plan) => plan,
            SessionHistoryListPlanOutcome::Current(_) => panic!("first list must scan"),
        };
        let result = runtime
            .complete_session_history_list(ObservedSessionHistoryScan {
                plan,
                scan: AgentHistoryScan {
                    conversations: vec![conversation.clone()],
                    issues: Vec::new(),
                    candidate_limit_reached: false,
                },
            })
            .unwrap();
        assert_eq!(result["entries"], json!([]));
        let preview = runtime
            .session_history_preview(preview_params.clone())
            .unwrap();
        assert_eq!(preview["status"], "available");
        assert_eq!(preview["provider"], "claude");
        assert_eq!(preview["model"], "sonnet");
        assert_eq!(
            preview["preview_messages"][0]["text"],
            "Inspect the release pipeline"
        );
        assert!(!preview.to_string().contains(&native_id));
        assert!(
            !preview
                .to_string()
                .contains(&conversation.source.path().display().to_string())
        );

        runtime
            .store
            .move_agent_session_to_deleted(
                &runtime.write_authority,
                session_id,
                termloop_platform::current_epoch_ms(),
            )
            .unwrap();
        let plan = match runtime
            .plan_session_history_list(json!({"projectId": project_id, "force": true}))
            .unwrap()
        {
            SessionHistoryListPlanOutcome::Observe(plan) => plan,
            SessionHistoryListPlanOutcome::Current(_) => panic!("forced list must scan"),
        };
        let result = runtime
            .complete_session_history_list(ObservedSessionHistoryScan {
                plan,
                scan: AgentHistoryScan {
                    conversations: vec![conversation],
                    issues: Vec::new(),
                    candidate_limit_reached: false,
                },
            })
            .unwrap();
        assert_eq!(result["entries"], json!([]));
        assert_eq!(
            runtime.session_history_preview(preview_params).unwrap()["status"],
            "available"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    fn history_agent(
        id: &str,
        project_id: &str,
        conversation: &DiscoveredAgentConversation,
        lifecycle_state: &str,
    ) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            project_id: project_id.into(),
            name: Some("Named elsewhere".into()),
            kind: SessionKind::Agent,
            process: ProcessDescriptor {
                program: "claude".into(),
                args: Vec::new(),
                cwd: conversation.cwd.clone(),
                agent_id: Some("claude".into()),
                template_ref: Some("builtin.agent.interactive".into()),
                template_version: Some(1),
            },
            launch_selection: Default::default(),
            lifecycle_state: lifecycle_state.into(),
            runtime_epoch: 1,
            archived_at_epoch_ms: None,
            ask_to_source_session_id: None,
            fork_source_session_id: None,
            run_configuration_id: None,
            improver_target: None,
            ask_to_continuation: None,
            resume_ref: Some(conversation.resume_ref.clone()),
            resume_launch_guard: None,
            resume_failure: None,
        }
    }

    fn list_once(
        runtime: &mut CoreRuntime,
        project_id: &str,
        conversation: DiscoveredAgentConversation,
    ) -> Value {
        let plan = match runtime
            .plan_session_history_list(json!({"projectId": project_id, "force": true}))
            .unwrap()
        {
            SessionHistoryListPlanOutcome::Observe(plan) => plan,
            SessionHistoryListPlanOutcome::Current(_) => panic!("forced list must scan"),
        };
        runtime
            .complete_session_history_list(ObservedSessionHistoryScan {
                plan,
                scan: AgentHistoryScan {
                    conversations: vec![conversation],
                    issues: Vec::new(),
                    candidate_limit_reached: false,
                },
            })
            .unwrap()
    }

    fn other_project(runtime: &mut CoreRuntime, root: &Path) -> (String, String) {
        let folder = root.join("other-checkout");
        std::fs::create_dir_all(&folder).unwrap();
        let project = runtime
            .handle(
                "project.create",
                json!({"name":"Other project","folderPath":folder}),
            )
            .unwrap();
        (
            project["id"].as_str().unwrap().to_owned(),
            folder.display().to_string(),
        )
    }

    #[test]
    fn conversations_outside_the_project_are_listed_and_import_in_their_own_folder() {
        let (mut runtime, project_id, _native_id, root, mut conversation) = fixture();
        let outside = root.join("loose-folder");
        std::fs::create_dir_all(&outside).unwrap();
        conversation.cwd = outside.display().to_string();
        let result = list_once(&mut runtime, &project_id, conversation);
        assert_eq!(result["entries"][0]["project_match"], "outside");
        assert_eq!(result["entries"][0]["owner_project_name"], Value::Null);
        let handle = result["entries"][0]["history_handle"].clone();

        let resume_params = json!({"projectId": project_id, "historyHandle": handle});
        let observed = runtime
            .plan_session_history_resume(&resume_params)
            .unwrap()
            .observe()
            .unwrap();
        let preview = runtime
            .complete_session_history_resume_preview(observed, &resume_params)
            .unwrap();
        let mut launch = runtime
            .take_agent_launch(json!({
                "projectId": project_id,
                "historyHandle": handle,
                "launchTicket": preview["launch_ticket"],
            }))
            .unwrap();
        assert_eq!(
            std::fs::canonicalize(&launch.cwd).unwrap(),
            std::fs::canonicalize(&outside).unwrap()
        );
        assert!(launch.history_moved_session_id.is_none());
        launch.prepare_runtime();
        runtime.validate_history_launch_plan(&launch).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_inactive_agent_of_another_project_is_moved_by_import() {
        let (mut runtime, project_id, _native_id, root, mut conversation) = fixture();
        let (other_id, other_folder) = other_project(&mut runtime, &root);
        conversation.cwd = other_folder;
        let moved = history_agent("moved-agent", &other_id, &conversation, "exited");
        runtime
            .store
            .insert_session(&runtime.write_authority, moved.clone())
            .unwrap();

        // The owning Project keeps it as its own managed Agent, not an import.
        let owner_view = list_once(&mut runtime, &other_id, conversation.clone());
        assert_eq!(owner_view["entries"], json!([]));

        let result = list_once(&mut runtime, &project_id, conversation.clone());
        assert_eq!(result["entries"][0]["project_match"], "outside");
        assert_eq!(result["entries"][0]["owner_project_name"], "Other project");
        let handle = result["entries"][0]["history_handle"].clone();

        let resume_params = json!({"projectId": project_id, "historyHandle": handle});
        let observed = runtime
            .plan_session_history_resume(&resume_params)
            .unwrap()
            .observe()
            .unwrap();
        let preview = runtime
            .complete_session_history_resume_preview(observed, &resume_params)
            .unwrap();
        let mut launch = runtime
            .take_agent_launch(json!({
                "projectId": project_id,
                "historyHandle": handle,
                "launchTicket": preview["launch_ticket"],
            }))
            .unwrap();
        assert_eq!(
            launch.history_moved_session_id.as_deref(),
            Some("moved-agent")
        );
        assert_eq!(launch.history_name.as_deref(), Some("Named elsewhere"));
        launch.prepare_runtime();
        runtime.validate_history_launch_plan(&launch).unwrap();

        let replacement = history_agent("replacement", &project_id, &conversation, "running");
        runtime
            .store
            .insert_session_moving_agent_descriptor(
                &runtime.write_authority,
                replacement,
                "moved-agent",
                false,
            )
            .unwrap();
        let sessions = runtime.store.sessions();
        assert!(!sessions.iter().any(|session| session.id == "moved-agent"));
        assert!(sessions.iter().any(|session| {
            session.id == "replacement"
                && session.project_id == project_id
                && session.resume_ref == moved.resume_ref
        }));
        // The handle cannot import the same conversation a second time.
        assert!(runtime.validate_history_launch_plan(&launch).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn conversations_inside_another_projects_task_worktree_are_not_offered() {
        let (mut runtime, project_id, _native_id, root, mut conversation) = fixture();
        let (other_id, _other_folder) = other_project(&mut runtime, &root);
        conversation.cwd = provision_task_worktree(&mut runtime, &other_id, &root, "other-task");
        let unowned = list_once(&mut runtime, &project_id, conversation.clone());
        assert_eq!(unowned["entries"], json!([]));
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                history_agent("task-agent", &other_id, &conversation, "exited"),
            )
            .unwrap();
        let owned = list_once(&mut runtime, &project_id, conversation);
        assert_eq!(owned["entries"], json!([]));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_running_or_archived_agent_of_another_project_is_not_offered() {
        for (lifecycle_state, archived_at_epoch_ms) in [("running", None), ("exited", Some(1))] {
            let (mut runtime, project_id, _native_id, root, mut conversation) = fixture();
            let (other_id, other_folder) = other_project(&mut runtime, &root);
            conversation.cwd = other_folder;
            let mut owner = history_agent("owner", &other_id, &conversation, lifecycle_state);
            owner.archived_at_epoch_ms = archived_at_epoch_ms;
            runtime
                .store
                .insert_session(&runtime.write_authority, owner)
                .unwrap();
            let result = list_once(&mut runtime, &project_id, conversation);
            assert_eq!(result["entries"], json!([]), "{lifecycle_state}");
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn resume_observation_rejects_a_provider_file_changed_after_listing() {
        let (mut runtime, project_id, _native_id, root, conversation) = fixture();
        let source_path = conversation.source.path().to_owned();
        let plan = match runtime
            .plan_session_history_list(json!({"projectId": project_id}))
            .unwrap()
        {
            SessionHistoryListPlanOutcome::Observe(plan) => plan,
            SessionHistoryListPlanOutcome::Current(_) => panic!("first list must scan"),
        };
        let result = runtime
            .complete_session_history_list(ObservedSessionHistoryScan {
                plan,
                scan: AgentHistoryScan {
                    conversations: vec![conversation],
                    issues: Vec::new(),
                    candidate_limit_reached: false,
                },
            })
            .unwrap();
        let handle = result["entries"][0]["history_handle"].as_str().unwrap();
        let resume = runtime
            .plan_session_history_resume(&json!({
                "projectId": project_id,
                "historyHandle": handle,
            }))
            .unwrap();
        std::fs::write(source_path, b"{\"type\":\"changed-and-longer\"}\n").unwrap();
        assert!(matches!(resume.observe(), Err(CoreError::InvalidParams(_))));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn filled_cache_keeps_only_the_newest_one_hundred_project_conversations() {
        let (mut runtime, project_id, _native_id, root, conversation) = fixture();
        let plan = match runtime
            .plan_session_history_list(json!({"projectId": project_id, "fillCache": true}))
            .unwrap()
        {
            SessionHistoryListPlanOutcome::Observe(plan) => plan,
            SessionHistoryListPlanOutcome::Current(_) => panic!("first list must scan"),
        };
        let conversations = (0..=MAX_CACHED_HISTORY)
            .map(|index| {
                let mut candidate = conversation.clone();
                candidate.resume_ref =
                    ResumeRef::for_provider(ResumeProvider::Claude, Uuid::new_v4().to_string())
                        .unwrap();
                candidate.title = format!("Conversation {index}");
                candidate.updated_at_epoch_ms = index as u64;
                candidate
            })
            .collect();
        let result = runtime
            .complete_session_history_list(ObservedSessionHistoryScan {
                plan,
                scan: AgentHistoryScan {
                    conversations,
                    issues: Vec::new(),
                    candidate_limit_reached: false,
                },
            })
            .unwrap();
        let entries = result["entries"].as_array().unwrap();
        assert_eq!(entries.len(), MAX_CACHED_HISTORY);
        assert_eq!(
            entries.first().unwrap()["updated_at_epoch_ms"],
            MAX_CACHED_HISTORY as u64
        );
        assert_eq!(entries.last().unwrap()["updated_at_epoch_ms"], 1);
        assert_eq!(result["cache_filled"], true);
        assert_eq!(result["truncated"], true);
        let _ = std::fs::remove_dir_all(root);
    }
}
