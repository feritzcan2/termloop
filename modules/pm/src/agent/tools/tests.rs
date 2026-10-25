use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::*;
use crate::ProposalChange;
use crate::agent::{
    PM_SKILL_DISCOVERY_READ, PM_SKILL_DRY_RUN_REQUEST, PM_SKILL_TOOL_VERIFY, PM_TOOLS,
};
use crate::skill::{Evidence, NeededTool, SkillPrefilter, SkillSource, SkillTrigger};
use crate::{
    DeliveryStageKind, EnvironmentDeployState, FactRead, FactSource, FactsObservation, NewProbe,
    NewTicket, ProbeMatcher, ProbeOutcome, ProbeStatus, ProjectEnvironment, PullRequestFact,
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
                    assert_schema_matches(&property["items"], first, &format!("{path}.{name}[]"));
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
                environments: vec![ReportedEnvironmentParams {
                    name: "live".into(),
                    state: EnvironmentDeployState::InProgress,
                    detail: Some("rolling out".into()),
                }],
                blockers: Some("Waiting on QA".into()),
                notes_markdown: "## Observed".into(),
                agent_probe: Some(AgentProbeParams {
                    probe_id: "p".into(),
                    state: EnvironmentDeployState::NotDeployed,
                    detail: Some("old build".into()),
                }),
                probe_proposals: vec![ProbeProposalParams {
                    environment: "live".into(),
                    argv: vec!["curl".into()],
                    matcher: ProbeMatcher::CommitAncestry,
                    reason: Some("version endpoint".into()),
                }],
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
                channels: vec!["C123".into()],
                what_it_will_do: "Reads channels".into(),
                needed_tools: vec![NeededTool {
                    name: "Slack token".into(),
                    available: false,
                    steps: Some("Create a Slack app".into()),
                }],
                changelog: Some("first".into()),
                base_skill_id: Some("s1".into()),
            }),
        ),
        (PM_SKILL_DRY_RUN_REQUEST, json!({ "draftId": "d1" })),
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
    assert_eq!(board["environments"], json!([]));
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
fn a_check_report_records_facts_notes_probe_readings_and_proposals() {
    let mut store = store();
    let sprint = store
        .create_sprint("p1", "Sprint 1", None, SprintState::Planned)
        .unwrap();
    store.activate_sprint(&sprint.id).unwrap();
    let work = ticket(&mut store, "p1", "Login", Some(&sprint.id));
    merged(&mut store, &work.id);

    // Without deploy tracking there is nothing for a check to report.
    let report = json!({
        "ticketId": work.id,
        "environments": [{ "name": "staging", "state": "deployed", "detail": "v1.4 runs abc1234" }],
        "notesMarkdown": "## Observed\nstaging runs abc1234",
        "probeProposals": [{
            "environment": "live",
            "argv": ["curl", "-s", "https://pay.example/version"],
            "matcher": "commitAncestry",
            "reason": "The live version endpoint names the commit"
        }]
    });
    let error = call_pm_tool(
        &mut store,
        &delivery_check("p1", &work.id),
        PM_CHECK_REPORT,
        report.clone(),
    )
    .unwrap_err();
    assert_eq!(error.code(), "denied");

    store
        .set_project_environments(
            "p1",
            &[
                ProjectEnvironment {
                    name: "staging".into(),
                    production: false,
                },
                ProjectEnvironment {
                    name: "live".into(),
                    production: true,
                },
            ],
        )
        .unwrap();
    let result = call_pm_tool(
        &mut store,
        &delivery_check("p1", &work.id),
        PM_CHECK_REPORT,
        report,
    )
    .unwrap();
    assert_eq!(result["accepted"], true);
    assert_eq!(result["stage"]["kind"], "deployed");
    assert_eq!(result["stage"]["environment"], "staging");
    let facts = store.ticket_facts(&work.id).unwrap().unwrap();
    let staging = &facts.environments[0];
    assert_eq!(staging.state, EnvironmentDeployState::Deployed);
    assert_eq!(staging.source, FactSource::Check);
    assert!(facts.check_notes.unwrap().markdown.contains("abc1234"));
    let probes = store.project_probes("p1").unwrap();
    assert_eq!(probes.len(), 1);
    assert_eq!(probes[0].status, ProbeStatus::Proposed);
    assert_eq!(result["proposedProbeIds"][0], probes[0].id);

    // An approved agent-matcher probe's reading lands as a probe fact.
    let agent_probe = store
        .create_probe(NewProbe {
            project_id: "p1".into(),
            environment: "live".into(),
            argv: vec!["kubectl".into(), "get".into(), "deploy".into()],
            matcher: ProbeMatcher::Agent,
            reason: None,
        })
        .unwrap();
    store
        .record_probe_run(
            &agent_probe.id,
            &agent_probe.argv,
            &ProbeOutcome::Output {
                output_hash: "a".repeat(64),
                deployed_commit: None,
            },
            &[],
        )
        .unwrap();
    let result = call_pm_tool(
        &mut store,
        &delivery_check("p1", &work.id),
        PM_CHECK_REPORT,
        json!({
            "ticketId": work.id,
            "environments": [],
            "notesMarkdown": "## Observed\nlive image tag names abc1234",
            "agentProbe": { "probeId": agent_probe.id, "state": "deployed" }
        }),
    )
    .unwrap();
    assert_eq!(result["stage"]["kind"], "live");
    let board = store.board("p1").unwrap();
    assert_eq!(board.deliveries[0].stage.kind, DeliveryStageKind::Live);
    let live = store
        .ticket_facts(&work.id)
        .unwrap()
        .unwrap()
        .environments
        .into_iter()
        .find(|environment| environment.name == "live")
        .unwrap();
    assert_eq!(live.source, FactSource::Probe);

    // A proposed (unapproved) probe cannot carry a reading.
    let error = call_pm_tool(
        &mut store,
        &delivery_check("p1", &work.id),
        PM_CHECK_REPORT,
        json!({
            "ticketId": work.id,
            "environments": [],
            "notesMarkdown": "## Observed",
            "agentProbe": { "probeId": probes[0].id, "state": "deployed" }
        }),
    )
    .unwrap_err();
    assert_eq!(error.code(), "invalidArguments");
}
