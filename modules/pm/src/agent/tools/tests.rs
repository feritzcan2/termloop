use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::*;
use crate::ChannelWatermark;
use crate::ProposalChange;
use crate::agent::{
    PM_OWNER_EVIDENCE_READ, PM_PLAYBOOK_PROPOSE, PM_SKILL_DISCOVERY_READ, PM_SKILL_DRY_RUN_REQUEST,
    PM_SKILL_TOOL_VERIFY, PM_TICKET_NOTE_ADD, PM_TOOLS,
};
use crate::playbook::{
    AgentCheck, PlaybookStep, PullRequestStepState, StepCheck, StepEvaluator, StepVerdict,
    default_steps,
};
use crate::skill::{Evidence, NeededTool, SkillChannel, SkillPrefilter, SkillSource, SkillTrigger};
use crate::{
    DeliveryCheckReason, DueCheck, FactRead, FactsObservation, NewTicket, PullRequestFact,
    PullRequestFactChecks, PullRequestFactReview, PullRequestFactState, PullRequestsObservation,
    SprintState, Ticket, TicketAuthor,
};

fn store() -> PmStore {
    PmStore::open_in_memory().expect("in-memory PM store")
}

fn ticket(store: &mut PmStore, project_id: &str, title: &str, sprint_id: Option<&str>) -> Ticket {
    store
        .create_ticket(NewTicket {
            sprint_id: sprint_id.map(str::to_owned),
            ..NewTicket::new(project_id, title)
        })
        .expect("ticket")
}

fn assistant(project_id: &str) -> PmToolContext {
    PmToolContext::new(project_id, PmAgentMode::Assistant)
}

fn delivery_check(project_id: &str, ticket_id: &str) -> PmToolContext {
    PmToolContext {
        ticket_id: Some(ticket_id.into()),
        ..PmToolContext::new(project_id, PmAgentMode::DeliveryCheck)
    }
}

fn keys(value: &Value) -> BTreeSet<String> {
    value
        .as_object()
        .expect("an object")
        .keys()
        .cloned()
        .collect()
}

/// Checks one object schema against a fully populated sample of its
/// parameter struct, recursing into nested objects and arrays of objects.
fn assert_schema_matches(schema: &Value, sample: &Value, path: &str) {
    assert_eq!(schema["type"], "object", "{path}");
    assert_eq!(schema["additionalProperties"], false, "{path}");
    let properties = &schema["properties"];
    assert_eq!(keys(properties), keys(sample), "{path}: property names");
    for required in schema["required"].as_array().expect("required list") {
        let required = required.as_str().expect("a property name");
        assert!(properties.get(required).is_some(), "{path}: {required}");
    }
    for (name, value) in sample.as_object().unwrap() {
        let mut property = &properties[name];
        if let Some(variants) = property["oneOf"].as_array() {
            property = variants
                .iter()
                .find(|variant| variant["properties"]["kind"]["const"] == value["kind"])
                .unwrap_or_else(|| panic!("{path}.{name}: no variant for {value}"));
        }
        if let Some(constant) = property.get("const") {
            assert_eq!(constant, value, "{path}.{name}");
            continue;
        }
        match value {
            Value::Object(_) => assert_schema_matches(property, value, &format!("{path}.{name}")),
            Value::Array(items) => {
                assert_eq!(property["type"], "array", "{path}.{name}");
                if let Some(first @ Value::Object(_)) = items.first() {
                    let mut item = &property["items"];
                    if let Some(variants) = item["oneOf"].as_array() {
                        item = variants
                            .iter()
                            .find(|variant| variant["properties"]["kind"]["const"] == first["kind"])
                            .unwrap_or_else(|| panic!("{path}.{name}[]: no variant for {first}"));
                    }
                    assert_schema_matches(item, first, &format!("{path}.{name}[]"));
                }
            }
            Value::String(_) => assert!(
                property["type"] == "string"
                    || property["type"]
                        .as_array()
                        .is_some_and(|types| types.contains(&json!("string"))),
                "{path}.{name}"
            ),
            _ => {}
        }
        if let Some(allowed) = property["enum"].as_array() {
            assert!(
                allowed.contains(value),
                "{path}.{name}: {value} not in enum"
            );
        }
    }
}

fn sample(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}

fn samples() -> Vec<(&'static str, Value)> {
    vec![
        (
            PM_BOARD_READ,
            sample(BoardReadParams {
                scope: BoardScope::All,
            }),
        ),
        (
            PM_TICKET_READ,
            sample(TicketReadParams {
                ticket_id: "t1".into(),
            }),
        ),
        (
            PM_TICKET_PROPOSE_DESCRIPTION,
            sample(DescriptionProposalParams {
                ticket_id: "t1".into(),
                description: "## Goal".into(),
                summary: "Clarify".into(),
                evidence: vec![evidence()],
            }),
        ),
        (
            PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
            sample(AcceptanceCriteriaProposalParams {
                ticket_id: "t1".into(),
                criteria: vec!["Logs in".into()],
                summary: "Add criteria".into(),
                evidence: vec![evidence()],
            }),
        ),
        (
            PM_RISKS_READ,
            sample(RisksReadParams {
                ticket_id: Some("t1".into()),
            }),
        ),
        (
            PM_CHECK_REPORT,
            sample(CheckReportParams {
                ticket_id: "t1".into(),
                step_id: "on-int".into(),
                verdict: StepVerdict::Waiting,
                evidence: "INT still runs build 811.".into(),
            }),
        ),
        (
            PM_TICKET_SUGGEST,
            sample(SuggestParams {
                ticket_id: "t1".into(),
                change: ProposalChange::Assignee {
                    assignee: "ada".into(),
                    shortlist: vec![crate::AssigneeCandidate {
                        name: "ada".into(),
                        reason: "Wrote the checkout module".into(),
                        evidence: vec![evidence()],
                    }],
                },
                summary: "Ada owns checkout".into(),
                evidence: vec![evidence()],
            }),
        ),
        (
            PM_SKILL_RUN_FINISH,
            sample(SkillRunFinishParams {
                summary: "Read 3 tickets".into(),
                channel_watermarks: vec![ChannelWatermark {
                    channel_id: "C123".into(),
                    ts: "1712345678.000100".into(),
                }],
            }),
        ),
        (PM_SKILL_DISCOVERY_READ, json!({ "refresh": true })),
        (PM_SKILL_TOOL_VERIFY, json!({ "kind": "cli", "name": "gh" })),
        (
            PM_SKILL_DRAFT_SUBMIT,
            sample(SkillDraftSubmitParams {
                name: "Slack tracker".into(),
                description: "Follows Slack".into(),
                trigger: SkillTrigger::Schedule { every_minutes: 30 },
                sources: vec![SkillSource::Slack],
                prefilter: SkillPrefilter::SlackMentions,
                tools: vec![PM_TICKET_READ.into()],
                instructions: "Suggest updates".into(),
                channels: vec![SkillChannel {
                    id: "C123".into(),
                    name: "shop".into(),
                }],
                agent_tools: vec!["mcp__slack__read_channel".into()],
                what_it_will_do: "Reads channels".into(),
                needed_tools: vec![NeededTool {
                    name: "Slack MCP server".into(),
                    available: false,
                    steps: Some("Add the Slack connector to Claude".into()),
                }],
                changelog: Some("first".into()),
                base_skill_id: Some("s1".into()),
            }),
        ),
        (PM_SKILL_DRY_RUN_REQUEST, json!({ "draftId": "d1" })),
        (PM_OWNER_EVIDENCE_READ, json!({ "ticketId": "t1" })),
        (
            PM_PLAYBOOK_PROPOSE,
            sample(PlaybookProposeParams {
                summary: "INT deploys from the deploy workflow".into(),
                steps: vec![PlaybookStep {
                    id: "on-int".into(),
                    title: "On INT".into(),
                    checks: vec![StepCheck::PullRequest {
                        state: PullRequestStepState::Merged,
                        base_branch: Some("release".into()),
                    }],
                    agent: Some(AgentCheck {
                        instructions: "Read the INT pipeline's last run".into(),
                        retry_minutes: 30,
                    }),
                }],
            }),
        ),
        (
            PM_TICKET_NOTE_ADD,
            sample(NoteAddParams {
                ticket_id: "t1".into(),
                kind: crate::TicketNoteKind::Fact,
                text: "CSV too".into(),
                url: Some("https://acme.slack.com/archives/C1/p1".into()),
                source_key: Some("slack:C1:1.1".into()),
            }),
        ),
    ]
}

fn evidence() -> Evidence {
    Evidence {
        label: "Slack #shop".into(),
        url: Some("https://acme.slack.com/archives/C1/p1".into()),
        quote: Some("checkout is done".into()),
    }
}

#[test]
fn every_tool_schema_matches_its_parameter_struct() {
    let samples = samples();
    assert_eq!(samples.len(), PM_TOOLS.len());
    for mode in [
        PmAgentMode::Assistant,
        PmAgentMode::DeliveryCheck,
        PmAgentMode::SkillCreator,
    ] {
        let definitions = pm_tool_definitions(&PmToolContext::new("p1", mode));
        assert_eq!(
            definitions.iter().map(|tool| tool.name).collect::<Vec<_>>(),
            mode.tools()
        );
        for definition in definitions {
            assert!(!definition.description.is_empty());
            let (_, sample) = samples
                .iter()
                .find(|(name, _)| *name == definition.name)
                .expect("a sample per tool");
            assert_schema_matches(&definition.input_schema, sample, definition.name);
            // The listed definition serializes as MCP expects.
            let listed = serde_json::to_value(&definition).unwrap();
            assert!(listed.get("inputSchema").is_some());
        }
    }
}

#[test]
fn modes_scope_tools_projects_and_tickets() {
    let mut store = store();
    let own = ticket(&mut store, "p1", "Own", None);
    let other = ticket(&mut store, "p1", "Other", None);
    let foreign = ticket(&mut store, "p2", "Foreign", None);

    let error = call_pm_tool(&mut store, &assistant("p1"), PM_CHECK_REPORT, json!({})).unwrap_err();
    assert!(matches!(error, PmToolError::Denied { .. }));
    assert_eq!(error.code(), "denied");
    let error = call_pm_tool(
        &mut store,
        &delivery_check("p1", &own.id),
        PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
        json!({}),
    )
    .unwrap_err();
    assert_eq!(error.code(), "denied");
    let error = call_pm_tool(&mut store, &assistant("p1"), "jira_write", json!({})).unwrap_err();
    assert_eq!(error.code(), "unknownTool");

    // A delivery check stays on its ticket.
    let error = call_pm_tool(
        &mut store,
        &delivery_check("p1", &own.id),
        PM_TICKET_READ,
        json!({ "ticketId": other.id }),
    )
    .unwrap_err();
    assert_eq!(error.code(), "denied");
    let read = call_pm_tool(
        &mut store,
        &delivery_check("p1", &own.id),
        PM_TICKET_READ,
        json!({ "ticketId": own.id }),
    )
    .unwrap();
    assert_eq!(read["ticket"]["id"], own.id);
    let error = call_pm_tool(
        &mut store,
        &PmToolContext {
            ticket_id: None,
            ..delivery_check("p1", &own.id)
        },
        PM_BOARD_READ,
        json!({}),
    )
    .unwrap_err();
    assert_eq!(error.code(), "denied");

    // Another project's ticket does not exist for this caller.
    let error = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_TICKET_READ,
        json!({ "ticketId": foreign.id }),
    )
    .unwrap_err();
    assert_eq!(error.code(), "notFound");

    let error = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_TICKET_READ,
        json!({ "ticketId": own.id, "extra": true }),
    )
    .unwrap_err();
    assert_eq!(error.code(), "invalidArguments");
}

#[test]
fn the_board_read_lists_the_active_sprint_by_default() {
    let mut store = store();
    let sprint = store
        .create_sprint("p1", "Sprint 1", Some("Ship login"), SprintState::Planned)
        .unwrap();
    store.activate_sprint(&sprint.id).unwrap();
    let in_sprint = ticket(&mut store, "p1", "In sprint", Some(&sprint.id));
    ticket(&mut store, "p1", "Backlog", None);

    let board = call_pm_tool(&mut store, &assistant("p1"), PM_BOARD_READ, Value::Null).unwrap();
    assert_eq!(board["tier"], "tickets");
    assert_eq!(
        board["steps"],
        json!(["In progress", "In review", "Merged", "Done"])
    );
    assert_eq!(board["tickets"][0]["step"], Value::Null);
    assert_eq!(board["tickets"][0]["nextStep"], "In progress");
    assert_eq!(board["sprints"][0]["goal"], "Ship login");
    let tickets = board["tickets"].as_array().unwrap();
    assert_eq!(tickets.len(), 1);
    assert_eq!(tickets[0]["id"], in_sprint.id);

    let all = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_BOARD_READ,
        json!({ "scope": "all" }),
    )
    .unwrap();
    assert_eq!(all["tickets"].as_array().unwrap().len(), 2);
}

#[test]
fn a_description_proposal_becomes_an_agent_version_only_when_accepted() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Login", None);
    store
        .save_ticket_description(&work.id, "First", TicketAuthor::Pm, None)
        .unwrap();

    let proposed = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_TICKET_PROPOSE_DESCRIPTION,
        json!({ "ticketId": work.id, "description": "## Goal\nLog in", "summary": "Add a goal" }),
    )
    .unwrap();
    assert_eq!(proposed["applied"], false);
    let proposal_id = proposed["proposalId"].as_str().unwrap().to_owned();
    // The ticket is untouched until the PM accepts.
    let unchanged = store.ticket(&work.id).unwrap().unwrap();
    assert_eq!(unchanged.description, "First");
    assert_eq!(store.ticket_versions(&work.id).unwrap().len(), 1);
    assert_eq!(store.ticket_proposals(&work.id).unwrap().len(), 1);

    let accepted = store.accept_ticket_proposal(&proposal_id).unwrap();
    assert_eq!(accepted.description, "## Goal\nLog in");
    let head = accepted.versions.unwrap();
    assert_eq!(head.head_author, TicketAuthor::Agent);
    assert_eq!(head.count, 2);
    assert!(store.ticket_proposals(&work.id).unwrap().is_empty());

    // A proposal made against an older head conflicts and stays pending.
    let stale = store
        .propose_ticket_change(
            &work.id,
            crate::ProposalChange::Description {
                description: "Stale".into(),
            },
            "Rewrite",
        )
        .unwrap();
    store
        .save_ticket_description(&work.id, "PM edit", TicketAuthor::Pm, None)
        .unwrap();
    assert!(matches!(
        store.accept_ticket_proposal(&stale.id),
        Err(crate::PmError::Conflict)
    ));
    assert_eq!(store.ticket_proposals(&work.id).unwrap().len(), 1);
    store.reject_ticket_proposal(&stale.id).unwrap();
    assert!(store.ticket_proposals(&work.id).unwrap().is_empty());
    assert_eq!(
        store.ticket(&work.id).unwrap().unwrap().description,
        "PM edit"
    );

    // A proposal that changes nothing is refused.
    let error = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_TICKET_PROPOSE_DESCRIPTION,
        json!({ "ticketId": work.id, "description": "PM edit", "summary": "Same" }),
    )
    .unwrap_err();
    assert_eq!(error.code(), "refused");
}

#[test]
fn accepted_criteria_proposals_add_only_missing_criteria() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Login", None);
    store.add_acceptance_criterion(&work.id, "Logs in").unwrap();
    let proposed = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
        json!({ "ticketId": work.id, "criteria": ["Logs in", "Logs out"], "summary": "Cover logout" }),
    )
    .unwrap();
    assert!(
        store
            .ticket(&work.id)
            .unwrap()
            .unwrap()
            .acceptance_criteria
            .len()
            == 1
    );
    let accepted = store
        .accept_ticket_proposal(proposed["proposalId"].as_str().unwrap())
        .unwrap();
    let texts: Vec<_> = accepted
        .acceptance_criteria
        .iter()
        .map(|criterion| criterion.text.as_str())
        .collect();
    assert_eq!(texts, ["Logs in", "Logs out"]);
}

fn merged(store: &mut PmStore, ticket_id: &str) {
    store
        .record_facts(
            ticket_id,
            FactsObservation {
                pull_requests: FactRead::Read(PullRequestsObservation {
                    repository: "github.com/acme/pay".into(),
                    items: vec![PullRequestFact {
                        number: 7,
                        title: "Login".into(),
                        url: "https://github.com/acme/pay/pull/7".into(),
                        state: PullRequestFactState::Merged,
                        checks: PullRequestFactChecks::Passing,
                        review: PullRequestFactReview::Approved,
                        base_branch: "main".into(),
                        head_branch: "login".into(),
                        merge_commit: Some("abc1234".into()),
                        updated_at_epoch_ms: 1,
                        awaiting_review_since_epoch_ms: None,
                    }],
                    truncated: false,
                }),
                ..FactsObservation::default()
            },
        )
        .unwrap();
}

#[test]
fn a_check_report_answers_its_one_step_of_its_one_ticket() {
    let mut store = store();
    let sprint = store
        .create_sprint("p1", "Sprint 1", None, SprintState::Planned)
        .unwrap();
    store.activate_sprint(&sprint.id).unwrap();
    let work = ticket(&mut store, "p1", "Login", Some(&sprint.id));
    let other = ticket(&mut store, "p1", "Other", Some(&sprint.id));
    merged(&mut store, &work.id);

    let report = |ticket_id: &str, step_id: &str| {
        json!({
            "ticketId": ticket_id,
            "stepId": step_id,
            "verdict": "waiting",
            "evidence": "The last INT run (#811) deployed main at 9f8e7d6, before the merge."
        })
    };
    // Without an agent step there is nothing for a check to answer.
    let error = call_pm_tool(
        &mut store,
        &delivery_check("p1", &work.id),
        PM_CHECK_REPORT,
        report(&work.id, "merged"),
    )
    .unwrap_err();
    assert_eq!(error.code(), "refused");

    let mut steps = default_steps();
    steps.insert(
        3,
        PlaybookStep {
            id: "on-int".into(),
            title: "On INT".into(),
            checks: vec![],
            agent: Some(AgentCheck {
                instructions: "Read the INT pipeline's last run with az.".into(),
                retry_minutes: 30,
            }),
        },
    );
    store.save_playbook("p1", 0, steps).unwrap();
    store
        .start_check(DueCheck {
            ticket_id: work.id.clone(),
            step_id: "on-int".into(),
            reason: DeliveryCheckReason::Due,
        })
        .unwrap();
    let result = call_pm_tool(
        &mut store,
        &delivery_check("p1", &work.id),
        PM_CHECK_REPORT,
        report(&work.id, "on-int"),
    )
    .unwrap();
    assert_eq!(result["accepted"], true);
    assert!(result["nextAttemptAtEpochMs"].is_u64());
    let delivery = store.board("p1").unwrap().deliveries[0].clone();
    assert!(!delivery.checking);
    let state = &delivery.playbook.steps[3];
    assert_eq!(state.verdict, Some(StepVerdict::Waiting));
    assert_eq!(state.evaluator, Some(StepEvaluator::Agent));

    // A check stays on its own ticket, and an unknown verdict is refused.
    let error = call_pm_tool(
        &mut store,
        &delivery_check("p1", &work.id),
        PM_CHECK_REPORT,
        report(&other.id, "on-int"),
    )
    .unwrap_err();
    assert_eq!(error.code(), "denied");
    let error = call_pm_tool(
        &mut store,
        &delivery_check("p1", &work.id),
        PM_CHECK_REPORT,
        json!({ "ticketId": work.id, "stepId": "on-int", "verdict": "deployed", "evidence": "x" }),
    )
    .unwrap_err();
    assert_eq!(error.code(), "invalidArguments");
}

#[test]
fn the_playbook_setup_proposes_steps_the_pm_reviews() {
    let mut store = store();
    let setup = PmToolContext::new("p1", PmAgentMode::SkillCreator);
    let result = call_pm_tool(
        &mut store,
        &setup,
        PM_PLAYBOOK_PROPOSE,
        json!({
            "summary": "Merged pull requests deploy to INT from deploy.yml.",
            "steps": [
                { "id": "merged", "title": "Merged", "checks": [{ "kind": "pullRequest", "state": "merged" }] },
                { "id": "on-int", "title": "On INT", "agent": { "instructions": "Read the INT run.", "retryMinutes": 30 } }
            ]
        }),
    )
    .unwrap();
    assert_eq!(result["applied"], false);
    assert_eq!(
        store.playbook_proposal("p1").unwrap().unwrap().steps.len(),
        2
    );
    assert_eq!(store.playbook("p1").unwrap().revision, 0);
    let error = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_PLAYBOOK_PROPOSE,
        json!({ "summary": "x", "steps": [] }),
    )
    .unwrap_err();
    assert_eq!(error.code(), "denied");
}

#[test]
fn the_assistant_records_notes_the_ticket_read_returns() {
    let mut store = store();
    let own = ticket(&mut store, "p1", "Export", None);
    let foreign = ticket(&mut store, "p2", "Foreign", None);
    let note = |ticket_id: &str, key: &str| {
        json!({
            "ticketId": ticket_id,
            "kind": "fact",
            "text": "The client also wants CSV",
            "url": "https://acme.slack.com/archives/C1/p1",
            "sourceKey": key,
        })
    };
    let added = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_TICKET_NOTE_ADD,
        note(&own.id, "slack:C1:1.1"),
    )
    .unwrap();
    assert_eq!(added["pending"], true);
    // The same message again is refused, a ticket of another project is
    // not found, and the description is left alone.
    let again = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_TICKET_NOTE_ADD,
        note(&own.id, "slack:C1:1.1"),
    )
    .unwrap_err();
    assert_eq!(again.code(), "refused");
    let foreign_error = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_TICKET_NOTE_ADD,
        note(&foreign.id, "slack:C1:1.2"),
    )
    .unwrap_err();
    assert_eq!(foreign_error.code(), "notFound");
    let denied = call_pm_tool(
        &mut store,
        &delivery_check("p1", &own.id),
        PM_TICKET_NOTE_ADD,
        note(&own.id, "slack:C1:1.3"),
    )
    .unwrap_err();
    assert_eq!(denied.code(), "denied");

    let read = call_pm_tool(
        &mut store,
        &assistant("p1"),
        PM_TICKET_READ,
        json!({ "ticketId": own.id }),
    )
    .unwrap();
    assert_eq!(read["ticket"]["description"], "");
    assert_eq!(read["notes"].as_array().unwrap().len(), 1);
    assert_eq!(read["notes"][0]["author"], "agent");
    assert_eq!(read["notes"][0]["sourceKey"], "slack:C1:1.1");
}
