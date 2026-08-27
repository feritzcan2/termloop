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

pub enum SessionHistoryListPlanOutcome {
    Current(Value),
    Observe(SessionHistoryScanPlan),
}

#[derive(Clone)]
pub struct SessionHistoryScanPlan {
    project_id: String,
    scope_paths: Vec<String>,
    fill_cache: bool,
}

pub struct ObservedSessionHistoryScan {
    plan: SessionHistoryScanPlan,
    scan: AgentHistoryScan,
}

impl SessionHistoryScanPlan {
    pub fn observe(self, cancellation: &AtomicBool) -> ObservedSessionHistoryScan {
        ObservedSessionHistoryScan {
            scan: termloop_agents::scan_local_agent_history_cancellable_with_limit(
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
    conversation: DiscoveredAgentConversation,
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
                fill_cache,
            },
        ))
    }

    pub fn complete_session_history_list(
        &mut self,
        observed: ObservedSessionHistoryScan,
    ) -> Result<Value, CoreError> {
        let current_scope_paths = self.session_history_scope_paths(&observed.plan.project_id)?;
        if current_scope_paths != observed.plan.scope_paths {
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
                            resume_ref.clone(),
                            session.id.clone(),
                            session.project_id.clone(),
                        )
                    })
            })
            .collect::<Vec<_>>();
        let mut matching = Vec::new();
        let mut managed_entries = Vec::new();
        for conversation in observed.scan.conversations {
            if let Some((_, session_id, session_project_id)) = known_resume_refs
                .iter()
                .find(|(resume_ref, _, _)| resume_ref == &conversation.resume_ref)
            {
                if session_project_id == &observed.plan.project_id {
                    managed_entries.push(CachedManagedHistoryEntry {
                        session_id: session_id.clone(),
                        conversation,
                    });
                }
                continue;
            }
            let Ok(cwd_identity) = termloop_platform::existing_directory_comparison_input(
                Path::new(&conversation.cwd),
            ) else {
                continue;
            };
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
                continue;
            };
            matching.push((project_match, conversation));
        }
        matching.sort_by(|(_, left), (_, right)| {
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
        let existing_handles = self
            .session_history
            .projects
            .get(&observed.plan.project_id)
            .filter(|cached| cached.scope_paths == current_scope_paths)
            .map(|cached| {
                cached
                    .entries
                    .iter()
                    .map(|entry| (entry.conversation.resume_ref.clone(), entry.handle.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let entries = matching
            .into_iter()
            .map(|(project_match, conversation)| CachedHistoryEntry {
                handle: existing_handles
                    .iter()
                    .find(|(resume_ref, _)| resume_ref == &conversation.resume_ref)
                    .map(|(_, handle)| handle.clone())
                    .unwrap_or_else(termloop_platform::generate_opaque_runtime_token),
                project_match,
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

    pub fn plan_session_history_resume(
        &mut self,
        params: &Value,
    ) -> Result<SessionHistoryResumePlan, CoreError> {
        let project_id = required_string(params, "projectId")?;
        let history_handle = required_string(params, "historyHandle")?;
        let current_scope_paths = self.session_history_scope_paths(&project_id)?;
        let conversation = self
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
            .map(|entry| entry.conversation.clone())
            .ok_or_else(|| CoreError::InvalidParams("historyHandle".into()))?;
        if self
            .store
            .sessions()
            .iter()
            .any(|session| session.resume_ref.as_ref() == Some(&conversation.resume_ref))
        {
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
        if cached.conversation.resume_ref != observed.plan.conversation.resume_ref
            || project_match(&current_scope_paths, &observed.cwd).is_none()
            || self.store.sessions().iter().any(|session| {
                session.resume_ref.as_ref() == Some(&observed.plan.conversation.resume_ref)
            })
        {
            return Err(CoreError::InvalidParams("historyHandle".into()));
        }
        let mut launch_params = json!({
            "projectId": observed.plan.project_id,
            "cwd": observed.cwd,
            "agentId": observed.plan.conversation.agent_id,
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
        launch.history_name = Some(observed.plan.conversation.title.clone());
        launch.history_source = Some(observed.plan.conversation);
        self.cache_agent_launch_preview(launch)
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
        let valid = self
            .session_history
            .projects
            .get(&plan.project_id)
            .is_some_and(|cached| {
                cached.entries.iter().any(|entry| {
                    entry.handle == handle && &entry.conversation.resume_ref == source_ref
                })
            });
        if !valid
            || self
                .store
                .sessions()
                .iter()
                .any(|session| session.resume_ref.as_ref() == Some(source_ref))
        {
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
        ProcessDescriptor, ResumeProvider, ResumeRef, SessionKind, SessionRecord,
    };
    use termloop_store::Store;
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
            source,
            source_modified_at_epoch_ms: slices.modified_at_epoch_ms,
            source_size_bytes: slices.size_bytes,
            source_window_sha256: slices.window_sha256,
        };
        (runtime, project_id, native_id, root, conversation)
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
