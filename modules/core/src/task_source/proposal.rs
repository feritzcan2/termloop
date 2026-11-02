//! Agent-proposed Jira issues. An ordinary Agent proposes one issue through
//! MCP; the user edits and approves it, sends feedback, or dismisses it. The
//! proposal is runtime-only and bound to the exact Session runtime epoch.
//! Approval is planned under the Core lock, the Jira call runs outside it with
//! the Task Source's stored credentials, and the result is applied back here.

use serde_json::{Value, json};
use termloop_domain::{
    IssueLink, IssueLinkProvider, IssueLinkSyncAuthority, SessionKind, TaskRecord, TaskStatus,
};
use termloop_providers::{
    JiraCreatedIssue, JiraIssueDraft, markdown_to_jira_wiki, valid_jira_issue_draft,
};

use crate::session_launch::AgentMcpRole;
use crate::task_worktree::{BRIEF_LIMIT, TITLE_LIMIT};
use crate::{CoreError, CoreRuntime, store_error};

const RATIONALE_MAX_CHARS: usize = 2_000;
const FAILURE_MAX_CHARS: usize = 600;
const EPIC_KEY_MAX_CHARS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JiraTaskProposalState {
    AwaitingUser,
    Creating,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JiraTaskProposal {
    proposal_id: String,
    runtime_epoch: u64,
    project_key: String,
    issue_type: String,
    epic_key: Option<String>,
    summary: String,
    description: String,
    rationale: Option<String>,
    state: JiraTaskProposalState,
    failure: Option<String>,
    proposed_at_epoch_ms: u64,
}

/// Everything the server needs to create the approved issue outside the Core
/// lock. It carries no credential: the server reads the source's stored one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraTaskProposalCreatePlan {
    pub session_id: String,
    pub proposal_id: String,
    pub source_id: String,
    pub site_base_url: String,
    pub draft: JiraIssueDraft,
    project_id: String,
    title: String,
    brief: Option<String>,
    start: JiraTaskProposalStart,
    /// The Task whose worktree holds the proposing Agent's working directory.
    source_task_id: Option<String>,
}

/// What follows a created issue, as the user chose on approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JiraTaskProposalStart {
    /// Only the issue; linked to the proposing Agent's Task when it has none.
    IssueOnly,
    /// A new Task started by the proposing Agent, or a fork of it when it
    /// already works in another Task.
    ProposingAgent,
    /// A new Task started by a fresh Agent.
    FreshAgent,
}

impl CoreRuntime {
    /// MCP `propose_jira_task`: records or replaces the caller's pending
    /// proposal and returns its new identity.
    pub fn propose_jira_task(
        &mut self,
        token: &str,
        params: &Value,
        now_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        if principal.role() != &AgentMcpRole::Interactive {
            return Err(CoreError::CapabilityDenied);
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == principal.session_id()
                    && session.kind == SessionKind::Agent
                    && session.lifecycle_state == "running"
                    && session.runtime_epoch == principal.runtime_epoch()
            })
            .ok_or(CoreError::CapabilityDenied)?;
        if !self.project_has_enabled_jira_source(&session.project_id) {
            return Err(CoreError::JiraTaskSourceUnavailable);
        }
        let session_id = session.id.clone();
        let runtime_epoch = session.runtime_epoch;
        if self
            .jira_task_proposals
            .get(&session_id)
            .is_some_and(|proposal| proposal.state == JiraTaskProposalState::Creating)
        {
            return Err(CoreError::InvalidParams("proposal".into()));
        }
        let field = |name: &str| params.get(name).and_then(Value::as_str).map(str::trim);
        let draft = ProposalFields {
            project_key: field("projectKey").unwrap_or_default().to_owned(),
            issue_type: field("issueType").unwrap_or_default().to_owned(),
            epic_key: field("epicKey")
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            summary: field("summary").unwrap_or_default().to_owned(),
            description: field("description").unwrap_or_default().to_owned(),
        };
        draft.validate()?;
        if draft.description.is_empty() {
            return Err(CoreError::InvalidParams("description".into()));
        }
        let rationale = field("rationale")
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if rationale
            .as_ref()
            .is_some_and(|value| value.chars().count() > RATIONALE_MAX_CHARS)
        {
            return Err(CoreError::InvalidParams("rationale".into()));
        }
        let proposal_id = uuid::Uuid::new_v4().to_string();
        self.jira_task_proposals.insert(
            session_id,
            JiraTaskProposal {
                proposal_id: proposal_id.clone(),
                runtime_epoch,
                project_key: draft.project_key,
                issue_type: draft.issue_type,
                epic_key: draft.epic_key,
                summary: draft.summary,
                description: draft.description,
                rationale,
                state: JiraTaskProposalState::AwaitingUser,
                failure: None,
                proposed_at_epoch_ms: now_epoch_ms,
            },
        );
        Ok(json!({ "proposalId": proposal_id, "status": "awaitingUser" }))
    }

    /// The pending proposal of a running Session, as the Session DTO shows it.
    pub(crate) fn jira_task_proposal_projection(&self, session_id: &str) -> Value {
        self.live_jira_task_proposal(session_id)
            .map_or(Value::Null, |proposal| {
                json!({
                    "proposal_id": proposal.proposal_id,
                    "project_key": proposal.project_key,
                    "issue_type": proposal.issue_type,
                    "epic_key": proposal.epic_key,
                    "summary": proposal.summary,
                    "description": proposal.description,
                    "rationale": proposal.rationale,
                    "state": match proposal.state {
                        JiraTaskProposalState::AwaitingUser => "awaitingUser",
                        JiraTaskProposalState::Creating => "creating",
                    },
                    "failure": proposal.failure,
                    "proposed_at_epoch_ms": proposal.proposed_at_epoch_ms,
                })
            })
    }

    /// Marks the proposal as creating and returns the Jira call to make with
    /// the user's edited fields.
    pub fn plan_jira_task_proposal_approval(
        &mut self,
        params: &Value,
    ) -> Result<JiraTaskProposalCreatePlan, CoreError> {
        let session_id = required(params, "sessionId")?;
        let proposal_id = required(params, "proposalId")?;
        let source_id = required(params, "sourceId")?;
        let start = match params.get("start").and_then(Value::as_str) {
            None | Some("proposingAgent") => JiraTaskProposalStart::ProposingAgent,
            Some("freshAgent") => JiraTaskProposalStart::FreshAgent,
            Some("issueOnly") => JiraTaskProposalStart::IssueOnly,
            Some(_) => return Err(CoreError::InvalidParams("start".into())),
        };
        let proposal = self
            .live_jira_task_proposal(&session_id)
            .filter(|proposal| proposal.proposal_id == proposal_id)
            .ok_or(CoreError::NotFound)?;
        if proposal.state != JiraTaskProposalState::AwaitingUser {
            return Err(CoreError::InvalidParams("proposalId".into()));
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        let project_id = session.project_id.clone();
        let source_task_id = self.task_holding_session_cwd(session);
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| {
                source.id == source_id && source.enabled && source.project_id == project_id
            })
            .cloned()
            .ok_or(CoreError::JiraTaskSourceUnavailable)?;
        let field = |name: &str| params.get(name).and_then(Value::as_str).map(str::trim);
        let fields = ProposalFields {
            project_key: field("projectKey").unwrap_or_default().to_owned(),
            issue_type: field("issueType").unwrap_or_default().to_owned(),
            epic_key: field("epicKey")
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            summary: field("summary").unwrap_or_default().to_owned(),
            description: field("description").unwrap_or_default().to_owned(),
        };
        fields.validate()?;
        let draft = JiraIssueDraft {
            project_key: fields.project_key.clone(),
            issue_type: fields.issue_type.clone(),
            parent_key: fields.epic_key.clone(),
            summary: fields.summary.clone(),
            description: markdown_to_jira_wiki(&fields.description),
        };
        if !valid_jira_issue_draft(&draft) {
            return Err(CoreError::InvalidParams("description".into()));
        }
        let plan = JiraTaskProposalCreatePlan {
            session_id: session_id.clone(),
            proposal_id,
            source_id: source.id,
            site_base_url: source.site_base_url,
            draft,
            project_id,
            title: super::truncate_utf8(&fields.summary, TITLE_LIMIT),
            brief: Some(super::truncate_utf8(fields.description.trim(), BRIEF_LIMIT))
                .filter(|brief| !brief.is_empty()),
            start,
            source_task_id,
        };
        let proposal = self
            .jira_task_proposals
            .get_mut(&session_id)
            .expect("live proposal");
        // The card keeps showing what the user approved while Jira answers.
        proposal.project_key = fields.project_key;
        proposal.issue_type = fields.issue_type;
        proposal.epic_key = fields.epic_key;
        proposal.summary = fields.summary;
        proposal.description = fields.description;
        proposal.state = JiraTaskProposalState::Creating;
        proposal.failure = None;
        Ok(plan)
    }

    /// Applies the Jira outcome. Unless the user chose the issue only, a
    /// created issue always becomes a Task, even when the Agent exited
    /// meanwhile, so the issue never goes untracked. The proposing Agent hears
    /// about the issue unless its own conversation moves into the new Task.
    pub fn apply_jira_task_proposal_creation(
        &mut self,
        plan: JiraTaskProposalCreatePlan,
        outcome: Result<JiraCreatedIssue, String>,
        task_id: String,
        now_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let matches_plan = |runtime: &Self| {
            runtime
                .jira_task_proposals
                .get(&plan.session_id)
                .is_some_and(|proposal| {
                    proposal.proposal_id == plan.proposal_id
                        && proposal.state == JiraTaskProposalState::Creating
                })
        };
        let created = match outcome {
            Ok(created) => created,
            Err(failure) => {
                let failure = truncate_chars(failure.trim(), FAILURE_MAX_CHARS);
                let failure = if failure.is_empty() {
                    "Jira did not create the issue".to_owned()
                } else {
                    failure
                };
                if matches_plan(self)
                    && let Some(proposal) = self.jira_task_proposals.get_mut(&plan.session_id)
                {
                    proposal.state = JiraTaskProposalState::AwaitingUser;
                    proposal.failure = Some(failure.clone());
                }
                return Ok(json!({ "outcome": "failed", "failure": failure }));
            }
        };
        if matches_plan(self) {
            self.jira_task_proposals.remove(&plan.session_id);
        }
        let start_with = match plan.start {
            JiraTaskProposalStart::IssueOnly => "none",
            JiraTaskProposalStart::FreshAgent => "fresh",
            JiraTaskProposalStart::ProposingAgent if plan.source_task_id.is_some() => "fork",
            JiraTaskProposalStart::ProposingAgent => "relocate",
        };
        if start_with != "relocate" {
            self.notify_jira_issue_created(&plan.session_id, &created);
        }
        if plan.start == JiraTaskProposalStart::IssueOnly {
            let linked = self.link_issue_to_source_task(&plan, &created)?;
            return Ok(json!({
                "outcome": "created",
                "taskId": linked,
                "issueKey": created.key,
                "issueUrl": created.url,
                "startWith": start_with,
            }));
        }
        if !self
            .store
            .projects()
            .iter()
            .any(|project| project.id == plan.project_id)
        {
            return Ok(json!({
                "outcome": "failed",
                "failure": format!("Created {} in Jira, but the Project no longer exists", created.key),
            }));
        }
        let rank = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == plan.project_id)
            .map(|task| task.rank)
            .max()
            .map_or(Ok(0), |rank| {
                rank.checked_add(1)
                    .ok_or_else(|| CoreError::Store("Task rank overflow".into()))
            })?;
        let task = TaskRecord {
            id: task_id,
            project_id: plan.project_id,
            title: plan.title,
            brief: plan.brief,
            developer_notes: Vec::new(),
            status: TaskStatus::Open,
            archived_at_epoch_ms: None,
            branch: None,
            worktree: None,
            worktree_generation: 0,
            steward_brief_markdown: String::new(),
            steward_brief_revision: 1,
            rank,
            created_at_epoch_ms: now_epoch_ms,
            updated_at_epoch_ms: now_epoch_ms,
        };
        let link = IssueLink {
            task_id: task.id.clone(),
            provider: IssueLinkProvider::Jira,
            external_ref: created.key.clone(),
            source_id: None,
            external_id: None,
            external_updated_at: None,
            url: Some(created.url.clone()),
            sync_authority: IssueLinkSyncAuthority::None,
        };
        let task_id = task.id.clone();
        self.store
            .insert_task_from_source(&self.write_authority, task, link)
            .map_err(store_error)?;
        Ok(json!({
            "outcome": "created",
            "taskId": task_id,
            "issueKey": created.key,
            "issueUrl": created.url,
            "startWith": start_with,
        }))
    }

    /// Links the created issue to the proposing Agent's Task when that Task
    /// is still open, unarchived, and has no Jira issue, which promotes the
    /// current work. Returns the linked Task.
    fn link_issue_to_source_task(
        &mut self,
        plan: &JiraTaskProposalCreatePlan,
        created: &JiraCreatedIssue,
    ) -> Result<Option<String>, CoreError> {
        let Some(task_id) =
            plan.source_task_id.as_deref().filter(|task_id| {
                self.store.tasks().iter().any(|task| {
                    task.id == *task_id
                        && task.project_id == plan.project_id
                        && task.archived_at_epoch_ms.is_none()
                }) && !self.store.issue_links().iter().any(|link| {
                    link.task_id == *task_id && link.provider == IssueLinkProvider::Jira
                })
            })
        else {
            return Ok(None);
        };
        self.store
            .insert_task_jira_issue_link(
                &self.write_authority,
                IssueLink {
                    task_id: task_id.to_owned(),
                    provider: IssueLinkProvider::Jira,
                    external_ref: created.key.clone(),
                    source_id: None,
                    external_id: None,
                    external_updated_at: None,
                    url: Some(created.url.clone()),
                    sync_authority: IssueLinkSyncAuthority::None,
                },
            )
            .map_err(store_error)?;
        Ok(Some(task_id.to_owned()))
    }

    /// Best effort: an Agent that exited meanwhile simply misses the notice.
    fn notify_jira_issue_created(&mut self, session_id: &str, created: &JiraCreatedIssue) {
        let running = self
            .store
            .sessions()
            .iter()
            .any(|session| session.id == session_id && session.lifecycle_state == "running");
        if !running {
            return;
        }
        if let Ok(prompt) =
            termloop_invocation::jira_task_proposal_created_prompt(&created.key, &created.url)
        {
            let _ = self.submit_generated_terminal_input(session_id, prompt.terminal_submission());
        }
    }

    /// The Task whose worktree contains the Session's working directory, the
    /// same attachment that stops relocating the Session into another Task.
    fn task_holding_session_cwd(&self, session: &termloop_domain::SessionRecord) -> Option<String> {
        let cwd = crate::task_worktree::comparison_key(std::path::Path::new(&session.process.cwd))
            .ok()?;
        self.store
            .tasks()
            .iter()
            .find(|task| {
                task.project_id == session.project_id
                    && task.worktree.as_ref().is_some_and(|worktree| {
                        crate::task_worktree::comparison_key(std::path::Path::new(&worktree.path))
                            .is_ok_and(|root| root.contains_or_equals(&cwd))
                    })
            })
            .map(|task| task.id.clone())
    }

    /// Answers a pending proposal without creating it and tells the Agent.
    pub fn respond_jira_task_proposal(&mut self, params: &Value) -> Result<Value, CoreError> {
        let session_id = required(params, "sessionId")?;
        let proposal_id = required(params, "proposalId")?;
        let answer = match params.get("decision").and_then(Value::as_str) {
            Some("revise") => termloop_invocation::JiraTaskProposalAnswer::Revise,
            Some("dismiss") => termloop_invocation::JiraTaskProposalAnswer::Dismiss,
            _ => return Err(CoreError::InvalidParams("decision".into())),
        };
        let feedback = params
            .get("feedback")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let proposal = self
            .live_jira_task_proposal(&session_id)
            .filter(|proposal| proposal.proposal_id == proposal_id)
            .ok_or(CoreError::NotFound)?;
        if proposal.state != JiraTaskProposalState::AwaitingUser {
            return Err(CoreError::InvalidParams("proposalId".into()));
        }
        let prompt = termloop_invocation::jira_task_proposal_answer_prompt(answer, feedback)
            .map_err(|_| CoreError::InvalidParams("feedback".into()))?;
        self.submit_generated_terminal_input(&session_id, prompt.terminal_submission())?;
        self.jira_task_proposals.remove(&session_id);
        Ok(json!({ "sessionId": session_id, "status": "submitting" }))
    }

    fn live_jira_task_proposal(&self, session_id: &str) -> Option<&JiraTaskProposal> {
        let proposal = self.jira_task_proposals.get(session_id)?;
        self.store
            .sessions()
            .iter()
            .any(|session| {
                session.id == session_id
                    && session.lifecycle_state == "running"
                    && session.runtime_epoch == proposal.runtime_epoch
            })
            .then_some(proposal)
    }

    fn project_has_enabled_jira_source(&self, project_id: &str) -> bool {
        self.store
            .task_source_configurations()
            .iter()
            .any(|source| source.enabled && source.project_id == project_id)
    }
}

struct ProposalFields {
    project_key: String,
    issue_type: String,
    epic_key: Option<String>,
    summary: String,
    description: String,
}

impl ProposalFields {
    /// Bounds the fields before any of them is stored or sent to Jira.
    fn validate(&self) -> Result<(), CoreError> {
        let draft = JiraIssueDraft {
            project_key: self.project_key.clone(),
            issue_type: self.issue_type.clone(),
            parent_key: self.epic_key.clone(),
            summary: self.summary.clone(),
            description: String::new(),
        };
        if !valid_jira_issue_draft(&draft)
            || self
                .epic_key
                .as_ref()
                .is_some_and(|key| key.len() > EPIC_KEY_MAX_CHARS)
        {
            return Err(CoreError::InvalidParams("proposal".into()));
        }
        if self.description.chars().count() > termloop_providers::JIRA_DESCRIPTION_MAX_CHARS {
            return Err(CoreError::InvalidParams("description".into()));
        }
        Ok(())
    }
}

fn required(params: &Value, name: &str) -> Result<String, CoreError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| CoreError::InvalidParams(name.into()))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{ProcessDescriptor, SessionRecord};
    use termloop_terminal::TerminalService;

    const SESSION_ID: &str = "123e4567-e89b-42d3-a456-426614174000";
    const TOKEN: &str = "agent-token";

    struct Fixture {
        runtime: CoreRuntime,
        root: std::path::PathBuf,
        project_id: String,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fixture(with_source: bool) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "termloop-core-jira-proposal-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project_root = root.join("project");
        std::fs::create_dir_all(&project_root).unwrap();
        let mut runtime =
            CoreRuntime::open(root.join("state.json"), TerminalService::default(), 1).unwrap();
        let project = runtime
            .create_project(json!({"name":"Project","folderPath":project_root}))
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        if with_source {
            let revision = runtime.state_revision();
            runtime
                .create_task_source(
                    "source-1".into(),
                    &project_id,
                    "Jira".into(),
                    "https://example.atlassian.net".into(),
                    "assignedToMe",
                    vec![],
                    vec![],
                    None,
                    "review",
                    5,
                    900,
                    None,
                    revision,
                    10,
                )
                .unwrap();
        }
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    id: SESSION_ID.into(),
                    project_id: project_id.clone(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: project_root.to_string_lossy().into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.quick-action.free-prompt".into()),
                        template_version: Some(1),
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 7,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    fork_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                    launch_selection: Default::default(),
                },
            )
            .unwrap();
        runtime.mcp_authorizer.register(
            SESSION_ID.into(),
            7,
            AgentMcpRole::Interactive,
            TOKEN.into(),
        );
        Fixture {
            runtime,
            root,
            project_id,
        }
    }

    fn proposal() -> Value {
        json!({
            "projectKey": "PAY",
            "issueType": "Task",
            "epicKey": "PAY-12",
            "summary": "Retry failed card captures",
            "description": "## Goal\n\nRetry **once**.",
            "rationale": "PAY-12 tracks capture reliability",
        })
    }

    fn approval(runtime: &CoreRuntime, summary: &str) -> Value {
        let proposal_id = runtime.jira_task_proposal_projection(SESSION_ID)["proposal_id"].clone();
        json!({
            "sessionId": SESSION_ID,
            "proposalId": proposal_id,
            "sourceId": "source-1",
            "projectKey": "PAY",
            "issueType": "Story",
            "epicKey": null,
            "summary": summary,
            "description": "## Goal\n\nRetry **once**.",
        })
    }

    #[test]
    fn a_proposal_needs_a_jira_source_and_an_interactive_agent() {
        let mut without = fixture(false);
        assert!(matches!(
            without.runtime.propose_jira_task(TOKEN, &proposal(), 5),
            Err(CoreError::JiraTaskSourceUnavailable)
        ));
        let mut with = fixture(true);
        assert!(
            with.runtime
                .propose_jira_task("other-token", &proposal(), 5)
                .is_err()
        );
        let mut bad = proposal();
        bad["epicKey"] = json!("not an epic");
        assert!(matches!(
            with.runtime.propose_jira_task(TOKEN, &bad, 5),
            Err(CoreError::InvalidParams(_))
        ));
        assert_eq!(
            with.runtime.jira_task_proposal_projection(SESSION_ID),
            Value::Null
        );
    }

    #[test]
    fn the_session_shows_its_pending_proposal_while_it_runs() {
        let mut fixture = fixture(true);
        let result = fixture
            .runtime
            .propose_jira_task(TOKEN, &proposal(), 5)
            .unwrap();
        assert_eq!(result["status"], "awaitingUser");
        let shown = fixture.runtime.jira_task_proposal_projection(SESSION_ID);
        assert_eq!(shown["proposal_id"], result["proposalId"]);
        assert_eq!(shown["epic_key"], "PAY-12");
        assert_eq!(shown["state"], "awaitingUser");
        assert_eq!(shown["rationale"], "PAY-12 tracks capture reliability");

        let replaced = fixture
            .runtime
            .propose_jira_task(TOKEN, &proposal(), 6)
            .unwrap();
        assert_ne!(replaced["proposalId"], result["proposalId"]);

        fixture
            .runtime
            .store
            .mark_session_exited(&fixture.runtime.write_authority, SESSION_ID)
            .unwrap();
        assert_eq!(
            fixture.runtime.jira_task_proposal_projection(SESSION_ID),
            Value::Null
        );
    }

    #[test]
    fn approval_creates_the_edited_issue_then_a_linked_task() {
        let mut fixture = fixture(true);
        fixture
            .runtime
            .propose_jira_task(TOKEN, &proposal(), 5)
            .unwrap();
        let params = approval(&fixture.runtime, "Retry captures once");
        let plan = fixture
            .runtime
            .plan_jira_task_proposal_approval(&params)
            .unwrap();
        assert_eq!(plan.site_base_url, "https://example.atlassian.net");
        assert_eq!(plan.draft.issue_type, "Story");
        assert_eq!(plan.draft.parent_key, None);
        assert_eq!(plan.draft.description, "h2. Goal\n\nRetry *once*.");
        assert_eq!(
            fixture.runtime.jira_task_proposal_projection(SESSION_ID)["state"],
            "creating"
        );
        // A second approval cannot race the Jira call.
        assert!(
            fixture
                .runtime
                .plan_jira_task_proposal_approval(&params)
                .is_err()
        );

        let failed = fixture
            .runtime
            .apply_jira_task_proposal_creation(
                plan,
                Err("Jira rejected the issue: parent: Epic not found".into()),
                "task-unused".into(),
                9,
            )
            .unwrap();
        assert_eq!(failed["outcome"], "failed");
        let shown = fixture.runtime.jira_task_proposal_projection(SESSION_ID);
        assert_eq!(shown["state"], "awaitingUser");
        assert_eq!(
            shown["failure"],
            "Jira rejected the issue: parent: Epic not found"
        );
        assert_eq!(shown["summary"], "Retry captures once");

        let plan = fixture
            .runtime
            .plan_jira_task_proposal_approval(&params)
            .unwrap();
        let created = fixture
            .runtime
            .apply_jira_task_proposal_creation(
                plan,
                Ok(JiraCreatedIssue {
                    key: "PAY-77".into(),
                    url: "https://example.atlassian.net/browse/PAY-77".into(),
                }),
                "task-1".into(),
                10,
            )
            .unwrap();
        assert_eq!(created["outcome"], "created");
        assert_eq!(created["taskId"], "task-1");
        assert_eq!(
            fixture.runtime.jira_task_proposal_projection(SESSION_ID),
            Value::Null
        );
        let task = fixture
            .runtime
            .store
            .tasks()
            .iter()
            .find(|task| task.id == "task-1")
            .unwrap();
        assert_eq!(task.project_id, fixture.project_id);
        assert_eq!(task.title, "Retry captures once");
        assert_eq!(task.status, TaskStatus::Open);
        let link = fixture
            .runtime
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == "task-1")
            .unwrap();
        assert_eq!(link.external_ref, "PAY-77");
        assert_eq!(
            link.url.as_deref(),
            Some("https://example.atlassian.net/browse/PAY-77")
        );
    }

    fn approve_with(fixture: &mut Fixture, start: Option<&str>, task_id: &str, key: &str) -> Value {
        fixture
            .runtime
            .propose_jira_task(TOKEN, &proposal(), 5)
            .unwrap();
        let mut params = approval(&fixture.runtime, "Retry captures once");
        if let Some(start) = start {
            params["start"] = json!(start);
        }
        let plan = fixture
            .runtime
            .plan_jira_task_proposal_approval(&params)
            .unwrap();
        fixture
            .runtime
            .apply_jira_task_proposal_creation(
                plan,
                Ok(JiraCreatedIssue {
                    key: key.into(),
                    url: format!("https://example.atlassian.net/browse/{key}"),
                }),
                task_id.into(),
                10,
            )
            .unwrap()
    }

    /// A Task whose managed worktree is the given directory.
    fn bind_task_worktree(runtime: &mut CoreRuntime, task_id: &str, path: &str) {
        use termloop_domain::{
            ManagedWorktreeProof, NormalizedWorktreeSpec, ProvisioningBranchMode,
            ProvisioningStage, TaskBranchBinding, TaskWorktreeBinding,
            WorktreeProvisioningOperation,
        };
        use termloop_store::ProvisioningCommit;
        let project_id = runtime.store.projects()[0].id.clone();
        runtime
            .store
            .insert_task(
                &runtime.write_authority,
                TaskRecord {
                    id: task_id.into(),
                    project_id: project_id.clone(),
                    title: "Current work".into(),
                    brief: None,
                    developer_notes: Vec::new(),
                    status: TaskStatus::Open,
                    archived_at_epoch_ms: None,
                    branch: None,
                    worktree: None,
                    worktree_generation: 0,
                    steward_brief_markdown: String::new(),
                    steward_brief_revision: 1,
                    rank: 0,
                    created_at_epoch_ms: 1,
                    updated_at_epoch_ms: 1,
                },
            )
            .unwrap();
        let repository_root = format!("{path}-repo");
        let operation_id = "provision-current-work";
        let spec = NormalizedWorktreeSpec {
            version: 1,
            repository_root: repository_root.clone(),
            repository_common_dir: format!("{repository_root}/.git"),
            destination_path: path.into(),
            branch_name: "task/current".into(),
            branch_mode: ProvisioningBranchMode::Create,
            base_ref: Some("refs/heads/main".into()),
            base_oid: Some("a".repeat(40)),
        };
        runtime
            .store
            .begin_task_worktree_provisioning(
                &runtime.write_authority,
                WorktreeProvisioningOperation {
                    operation_id: operation_id.into(),
                    task_id: task_id.into(),
                    project_id,
                    spec: spec.clone(),
                    stage: ProvisioningStage::Reserved,
                    created_branch_ref: false,
                    failure: None,
                    started_at_epoch_ms: 2,
                    updated_at_epoch_ms: 2,
                },
            )
            .unwrap();
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
                        name: "task/current".into(),
                    },
                    worktree: TaskWorktreeBinding { path: path.into() },
                    proof: ManagedWorktreeProof {
                        task_id: task_id.into(),
                        operation_id: operation_id.into(),
                        worktree_generation: 0,
                        normalized_spec_version: 1,
                        normalized_spec: spec,
                        repository_common_dir: format!("{repository_root}/.git"),
                        registered_worktree_path: path.into(),
                        branch_ref: "refs/heads/task/current".into(),
                    },
                    updated_at_epoch_ms: 4,
                },
            )
            .unwrap();
        runtime
            .store
            .clear_task_worktree_provisioning(&runtime.write_authority, task_id, operation_id)
            .unwrap();
    }

    fn task_count(fixture: &Fixture) -> usize {
        fixture.runtime.store.tasks().len()
    }

    #[test]
    fn the_start_choice_decides_how_the_client_starts_the_new_task() {
        let mut fixture = fixture(true);
        let relocated = approve_with(&mut fixture, None, "task-1", "PAY-1");
        assert_eq!(relocated["startWith"], "relocate");
        assert_eq!(relocated["taskId"], "task-1");
        let fresh = approve_with(&mut fixture, Some("freshAgent"), "task-2", "PAY-2");
        assert_eq!(fresh["startWith"], "fresh");
        assert_eq!(fresh["taskId"], "task-2");
        let mut bad = {
            fixture
                .runtime
                .propose_jira_task(TOKEN, &proposal(), 5)
                .unwrap();
            approval(&fixture.runtime, "Retry")
        };
        bad["start"] = json!("later");
        assert!(matches!(
            fixture.runtime.plan_jira_task_proposal_approval(&bad),
            Err(CoreError::InvalidParams(_))
        ));
        // Without a Task to promote, the issue stands alone.
        let alone = approve_with(&mut fixture, Some("issueOnly"), "task-unused", "PAY-3");
        assert_eq!(alone["startWith"], "none");
        assert_eq!(alone["taskId"], Value::Null);
        assert_eq!(task_count(&fixture), 2);
    }

    #[test]
    fn a_task_attached_agent_forks_into_the_new_task_or_promotes_its_own() {
        let mut fixture = fixture(true);
        let cwd = fixture
            .runtime
            .store
            .sessions()
            .iter()
            .find(|session| session.id == SESSION_ID)
            .unwrap()
            .process
            .cwd
            .clone();
        bind_task_worktree(&mut fixture.runtime, "task-here", &cwd);
        let forked = approve_with(&mut fixture, Some("proposingAgent"), "task-new", "PAY-5");
        assert_eq!(forked["startWith"], "fork");
        assert_eq!(forked["taskId"], "task-new");

        let promoted = approve_with(&mut fixture, Some("issueOnly"), "task-unused", "PAY-6");
        assert_eq!(promoted["startWith"], "none");
        assert_eq!(promoted["taskId"], "task-here");
        let tasks = task_count(&fixture);
        let link = fixture
            .runtime
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == "task-here")
            .unwrap();
        assert_eq!(link.external_ref, "PAY-6");
        // A Task that already has an issue keeps it.
        let again = approve_with(&mut fixture, Some("issueOnly"), "task-unused", "PAY-7");
        assert_eq!(again["taskId"], Value::Null);
        assert_eq!(task_count(&fixture), tasks);
        assert_eq!(
            fixture
                .runtime
                .store
                .issue_links()
                .iter()
                .filter(|link| link.task_id == "task-here")
                .count(),
            1
        );
    }

    #[test]
    fn approval_and_answers_bind_the_exact_current_proposal() {
        let mut fixture = fixture(true);
        fixture
            .runtime
            .propose_jira_task(TOKEN, &proposal(), 5)
            .unwrap();
        let mut stale = approval(&fixture.runtime, "Retry");
        stale["proposalId"] = json!(uuid::Uuid::new_v4().to_string());
        assert!(matches!(
            fixture.runtime.plan_jira_task_proposal_approval(&stale),
            Err(CoreError::NotFound)
        ));
        let mut foreign_source = approval(&fixture.runtime, "Retry");
        foreign_source["sourceId"] = json!("source-2");
        assert!(matches!(
            fixture
                .runtime
                .plan_jira_task_proposal_approval(&foreign_source),
            Err(CoreError::JiraTaskSourceUnavailable)
        ));
        assert!(matches!(
            fixture.runtime.respond_jira_task_proposal(&json!({
                "sessionId": SESSION_ID,
                "proposalId": stale["proposalId"],
                "decision": "dismiss",
                "feedback": "",
            })),
            Err(CoreError::NotFound)
        ));
        assert_eq!(
            fixture.runtime.jira_task_proposal_projection(SESSION_ID)["state"],
            "awaitingUser"
        );
    }

    #[test]
    fn quick_action_jira_intake_requires_a_free_prompt_with_an_enabled_source() {
        let params = |fixture: &Fixture, template: &str| {
            let cwd =
                termloop_platform::canonical_existing_directory_path(&fixture.root.join("project"))
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
            json!({"projectId":fixture.project_id,"cwd":cwd,"agentId":"claude","model":"default","permission":"default","reasoning":"default","templateRef":template,"bindings":{"prompt":"Add refund export"},"attachments":[],"jiraTaskIntake":true})
        };
        let mut without = fixture(false);
        let request = params(&without, "builtin.quick-action.free-prompt");
        assert!(matches!(
            without.runtime.preview_quick_action(request),
            Err(CoreError::InvalidParams(field)) if field == "jiraTaskIntake"
        ));

        let mut with = fixture(true);
        let request = params(&with, "builtin.quick-action.free-prompt");
        let preview = with.runtime.preview_quick_action(request).unwrap();
        let inspected = preview.to_string();
        assert!(inspected.contains("propose_jira_task"), "{inspected}");
        assert!(inspected.contains("Add refund export"), "{inspected}");

        let mut plain = params(&with, "builtin.quick-action.free-prompt");
        plain["jiraTaskIntake"] = json!(false);
        let inspected = with
            .runtime
            .preview_quick_action(plain)
            .unwrap()
            .to_string();
        assert!(!inspected.contains("propose_jira_task"), "{inspected}");
    }
}
