use std::sync::atomic::{AtomicU64, Ordering};

use super::{store, ticket};
use crate::agent::{PM_BOARD_READ, PM_RISKS_READ, PM_TICKET_READ, PM_TICKET_SUGGEST};
use crate::agent::{PmAgentMode, PmAgentProfile, PmToolContext, SkillRunContext, SkillSetup};
use crate::skill::{
    BuiltinSkill, DryRunState, Evidence, FeedbackOutcome, NeededTool, NewSkillDraft,
    SKILL_RUN_DEADLINE_MS, SkillChannel, SkillDraftOrigin, SkillEdit, SkillEvent, SkillManifest,
    SkillPrefilter, SkillRunOutcome, SkillRunTrigger, SkillSample, SkillSource, SkillTrigger,
    evidence_sources, revision_reason,
};
use crate::{
    NewEnvironmentProposal, NewProbe, PmError, PmStore, ProbeMatcher, ProjectEnvironment,
    ProposalChange, ProposalOrigin, ProposedEnvironment, SKILL_PAUSE_AFTER_FAILURES,
    SKILL_RETRY_AFTER_MS, TicketStatus,
};

pub(super) fn manifest() -> SkillManifest {
    SkillManifest {
        name: "Standup digest".into(),
        description: "Suggests blockers from the board.".into(),
        trigger: SkillTrigger::Schedule { every_minutes: 30 },
        sources: vec![SkillSource::Board],
        prefilter: SkillPrefilter::BoardChanges,
        approved_tools: vec![PM_BOARD_READ.into(), PM_TICKET_READ.into()],
        instructions: "Look for blocked tickets.".into(),
        channels: Vec::new(),
        agent_tools: Vec::new(),
    }
}

pub(super) fn new_draft(manifest: SkillManifest, base_skill_id: Option<String>) -> NewSkillDraft {
    NewSkillDraft {
        project_id: "p1".into(),
        origin: if base_skill_id.is_some() {
            SkillDraftOrigin::Revision
        } else {
            SkillDraftOrigin::Creator
        },
        base_skill_id,
        manifest,
        what_it_will_do: "Reads the board and suggests blockers.".into(),
        needed_tools: vec![NeededTool {
            name: "Slack".into(),
            available: false,
            steps: Some("Add a Slack token in Settings.".into()),
        }],
        changelog: None,
    }
}

pub(super) fn evidence(url: &str) -> Vec<Evidence> {
    vec![Evidence {
        label: "Slack thread".into(),
        url: Some(url.into()),
        quote: Some("blocked on the API key".into()),
    }]
}

/// Submits, dry-runs, and installs a draft with every tool approved.
pub(super) fn installed(store: &mut PmStore, manifest: SkillManifest) -> crate::skill::Skill {
    let draft = store.submit_skill_draft(new_draft(manifest, None)).unwrap();
    let run = store.start_dry_run(&draft.id, 0).unwrap();
    store
        .finish_skill_run(&run.id, SkillRunOutcome::Reported, None)
        .unwrap();
    let tools = draft.first_use_tools.clone();
    store.install_skill_draft(&draft.id, &tools, None).unwrap()
}

/// A status suggestion of the skill's first version resting on `url`.
fn skill_proposal(
    store: &mut PmStore,
    ticket_id: &str,
    skill_id: &str,
    url: &str,
) -> crate::TicketProposal {
    store
        .propose_ticket_change_from(
            ticket_id,
            ProposalChange::Status {
                status: TicketStatus::InProgress,
            },
            "Work started",
            Some(ProposalOrigin {
                skill_id: skill_id.to_owned(),
                skill_version: 1,
                evidence: evidence(url),
            }),
        )
        .unwrap()
}

fn with_environments(store: &mut PmStore) {
    store
        .set_project_environments(
            "p1",
            &[ProjectEnvironment {
                name: "live".into(),
                production: true,
            }],
        )
        .unwrap();
}

#[test]
fn v8_carries_earlier_proposals_into_the_change_column() {
    let mut store = PmStore::open_from_version(7, |connection| {
        connection
            .execute_batch(
                "INSERT INTO tickets (id, project_id, title, status, priority, rank, \
                     created_at_epoch_ms, updated_at_epoch_ms) \
                 VALUES ('t1', 'p1', 'Login', 'todo', 'medium', 0, 1, 1);
                 INSERT INTO ticket_proposals (id, ticket_id, kind, description, summary, \
                     base_version, created_at_epoch_ms) \
                 VALUES ('a', 't1', 'description', '## Goal', 'Clearer goal', 0, 2);
                 INSERT INTO ticket_proposals (id, ticket_id, kind, criteria_json, summary, \
                     base_version, created_at_epoch_ms) \
                 VALUES ('b', 't1', 'acceptanceCriteria', '[\"Logs in\"]', 'Criteria', 0, 3);",
            )
            .unwrap();
    })
    .unwrap();
    let proposals = store.ticket_proposals("t1").unwrap();
    assert_eq!(
        proposals[0].change,
        ProposalChange::Description {
            description: "## Goal".into()
        }
    );
    assert_eq!(
        proposals[1].change,
        ProposalChange::AcceptanceCriteria {
            criteria: vec!["Logs in".into()]
        }
    );
    assert!(proposals.iter().all(|proposal| proposal.skill_id.is_none()));
    store.migrate_again().unwrap();
    assert_eq!(store.ticket_proposals("t1").unwrap(), proposals);
}

#[test]
fn manifests_are_bounded_and_name_the_refused_field() {
    assert!(manifest().is_valid());
    let refused = |edit: fn(&mut SkillManifest)| {
        let mut manifest = manifest();
        edit(&mut manifest);
        manifest.invalid_field()
    };
    assert_eq!(
        refused(|m| m.trigger = SkillTrigger::Schedule { every_minutes: 5 }),
        Some("trigger")
    );
    assert_eq!(refused(|m| m.sources.clear()), Some("sources"));
    assert_eq!(
        refused(|m| m.sources.push(SkillSource::Board)),
        Some("sources")
    );
    // Only daemon-mediated read tools; never a write or host tool.
    assert_eq!(
        refused(|m| m.approved_tools.push(PM_TICKET_SUGGEST.into())),
        Some("approvedTools")
    );
    assert_eq!(
        refused(|m| m.approved_tools.push("Bash".into())),
        Some("approvedTools")
    );
    assert_eq!(
        refused(|m| m.instructions = " ".into()),
        Some("instructions")
    );
    assert_eq!(
        refused(|m| m.channels = vec![SkillChannel {
            id: "C123".into(),
            name: "shop".into()
        }]),
        Some("channels")
    );
    assert_eq!(
        refused(|m| m.prefilter = SkillPrefilter::SlackMentions),
        Some("prefilter")
    );
    assert_eq!(
        refused(|m| m.prefilter = SkillPrefilter::DeliveryChecks),
        Some("prefilter")
    );
    assert!(
        BuiltinSkill::DeploymentControl
            .manifest()
            .invalid_field_of(true)
            .is_none()
    );
    let wire = serde_json::to_value(manifest().trigger).unwrap();
    assert_eq!(
        wire,
        serde_json::json!({"kind": "schedule", "everyMinutes": 30})
    );
}

#[test]
fn deployment_control_appears_off_with_environments_and_runs_once_set_up() {
    let mut store = store();
    assert!(!store.deployment_control_enabled("p1").unwrap());
    assert!(store.skills("p1").unwrap().is_empty());
    with_environments(&mut store);
    // Listed, but off until the PM sets it up.
    assert!(!store.deployment_control_enabled("p1").unwrap());
    let skills = store.skills("p1").unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].builtin, Some(BuiltinSkill::DeploymentControl));
    assert!(!skills[0].enabled);
    store.set_skill_enabled(&skills[0].id, true).unwrap();
    assert!(store.deployment_control_enabled("p1").unwrap());
    store.set_skill_enabled(&skills[0].id, false).unwrap();
    store.ensure_builtin_skills("p1").unwrap();
    assert!(!store.deployment_control_enabled("p1").unwrap());
    assert_eq!(store.skills("p1").unwrap().len(), 1);
    // It runs without an agent.
    assert!(matches!(
        store.start_skill_run(&skills[0].id, SkillRunTrigger::Manual, 1),
        Err(PmError::Constraint(_))
    ));
}

#[test]
fn the_pm_edits_a_skill_live_as_its_next_version_keeping_its_tools() {
    let mut store = store();
    let skill = installed(&mut store, manifest());
    let approved = store.skill_approved_tools(&skill.id).unwrap();
    let edited = store
        .update_skill(
            &skill.id,
            SkillEdit {
                instructions: Some("Look for tickets blocked over a day.".into()),
                ..SkillEdit::default()
            },
        )
        .unwrap();
    assert_eq!(edited.version, skill.version + 1);
    assert_eq!(
        edited.manifest.instructions,
        "Look for tickets blocked over a day."
    );
    assert_eq!(edited.manifest.name, skill.manifest.name);
    assert_eq!(
        edited.manifest.approved_tools,
        skill.manifest.approved_tools
    );
    assert_eq!(store.skill_approved_tools(&skill.id).unwrap(), approved);
    // The same text again changes nothing.
    let same = SkillEdit {
        instructions: Some(edited.manifest.instructions.clone()),
        ..SkillEdit::default()
    };
    assert_eq!(
        store.update_skill(&skill.id, same).unwrap().version,
        edited.version
    );
    let blank = SkillEdit {
        name: Some("  ".into()),
        ..SkillEdit::default()
    };
    assert!(matches!(
        store.update_skill(&skill.id, blank),
        Err(PmError::Invalid("name"))
    ));
    assert_eq!(store.skill(&skill.id).unwrap().unwrap(), edited);

    with_environments(&mut store);
    store.ensure_builtin_skills("p1").unwrap();
    let builtin = store
        .skills("p1")
        .unwrap()
        .into_iter()
        .find(|skill| skill.builtin.is_some())
        .unwrap();
    assert!(matches!(
        store.update_skill(&builtin.id, SkillEdit::default()),
        Err(PmError::Constraint(_))
    ));
}

#[test]
fn install_needs_a_completed_dry_run_and_each_first_use_tool_approved() {
    let mut store = store();
    let draft = store
        .submit_skill_draft(new_draft(manifest(), None))
        .unwrap();
    assert_eq!(draft.first_use_tools, [PM_BOARD_READ, PM_TICKET_READ]);
    let all = draft.first_use_tools.clone();
    assert!(matches!(
        store.install_skill_draft(&draft.id, &all, None),
        Err(PmError::Constraint(
            "the draft needs a completed dry run first"
        ))
    ));
    let run = store.start_dry_run(&draft.id, 0).unwrap();
    store
        .finish_skill_run(&run.id, SkillRunOutcome::Reported, None)
        .unwrap();
    assert_eq!(
        store.skill_draft(&draft.id).unwrap().unwrap().dry_run_state,
        DryRunState::Completed
    );
    assert!(matches!(
        store.install_skill_draft(&draft.id, &all[..1], None),
        Err(PmError::Constraint(
            "every tool used for the first time needs its own approval"
        ))
    ));
    let skill = store.install_skill_draft(&draft.id, &all, None).unwrap();
    assert!(skill.enabled);
    assert_eq!(skill.version, 1);
    assert_eq!(store.skill_approved_tools(&skill.id).unwrap(), all);
    assert!(store.skill_drafts("p1").unwrap().is_empty());

    // A revision asks only for the tool it adds, and becomes version 2.
    let mut next = manifest();
    next.approved_tools.push(PM_RISKS_READ.into());
    let revision = store
        .submit_skill_draft(new_draft(next, Some(skill.id.clone())))
        .unwrap();
    assert_eq!(revision.first_use_tools, [PM_RISKS_READ]);
    let run = store.start_dry_run(&revision.id, 0).unwrap();
    store
        .finish_skill_run(&run.id, SkillRunOutcome::Reported, None)
        .unwrap();
    let skill = store
        .install_skill_draft(&revision.id, &[PM_RISKS_READ.into()], None)
        .unwrap();
    assert_eq!(skill.version, 2);
    assert_eq!(skill.manifest.approved_tools.len(), 3);
}

#[test]
fn a_skill_run_sees_only_its_approved_tools() {
    let context = |approved: Vec<String>| PmToolContext {
        skill: Some(SkillRunContext {
            run_id: "r1".into(),
            skill: Some(("s1".into(), 1)),
            draft_id: None,
            approved_tools: approved,
        }),
        ..PmToolContext::new("p1", PmAgentMode::SkillRun)
    };
    let narrow = context(vec![PM_TICKET_READ.into()]);
    assert!(narrow.allows(PM_TICKET_READ));
    assert!(narrow.allows(PM_TICKET_SUGGEST));
    assert!(!narrow.allows(PM_BOARD_READ));
    assert!(!narrow.allows(PM_RISKS_READ));
    assert!(!narrow.allows(crate::agent::PM_CHECK_REPORT));
    assert!(!narrow.allows(crate::agent::PM_SKILL_DRAFT_SUBMIT));
    // Without a run binding a skill-run agent gets nothing.
    assert!(
        PmToolContext::new("p1", PmAgentMode::SkillRun)
            .tools()
            .is_empty()
    );
}

#[test]
fn dry_run_samples_stay_on_the_draft_and_are_never_proposals() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Login", None);
    let draft = store
        .submit_skill_draft(new_draft(manifest(), None))
        .unwrap();
    let sample = SkillSample {
        ticket_id: work.id.clone(),
        change: ProposalChange::Blockers {
            blockers: vec!["Waiting for the API key".into()],
        },
        summary: "Blocked on the key".into(),
        evidence: evidence("https://acme.slack.com/archives/C1/p1"),
    };
    // No running dry run: refused.
    let run = store.start_dry_run(&draft.id, 1).unwrap();
    store
        .record_dry_run_sample(&run.id, sample.clone())
        .unwrap();
    store
        .finish_skill_run(&run.id, SkillRunOutcome::Reported, Some("One blocker"))
        .unwrap();
    assert!(matches!(
        store.record_dry_run_sample(&run.id, sample.clone()),
        Err(PmError::Constraint("not a running dry run"))
    ));
    let stored = store.skill_draft(&draft.id).unwrap().unwrap();
    assert_eq!(stored.samples, [sample]);
    assert!(store.ticket_proposals(&work.id).unwrap().is_empty());
    assert!(store.ticket(&work.id).unwrap().unwrap().blockers.is_empty());
}

#[test]
fn feedback_is_recorded_per_version_and_a_rejected_evidence_is_not_suggested_again() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Login", None);
    let skill = installed(&mut store, manifest());
    let origin = |url: &str| {
        Some(ProposalOrigin {
            skill_id: skill.id.clone(),
            skill_version: 1,
            evidence: evidence(url),
        })
    };
    let status = ProposalChange::Status {
        status: TicketStatus::InProgress,
    };
    let first = store
        .propose_ticket_change_from(
            &work.id,
            status.clone(),
            "Work started",
            origin("https://acme.slack.com/archives/C1/p1"),
        )
        .unwrap();
    assert_eq!(
        store
            .skill(&skill.id)
            .unwrap()
            .unwrap()
            .pending_suggestion_count,
        1
    );
    assert_eq!(
        store.skill_suggestions("p1").unwrap(),
        std::slice::from_ref(&first)
    );
    store
        .reject_ticket_proposal_because(&first.id, Some("Not started yet"))
        .unwrap();
    assert!(matches!(
        store.propose_ticket_change_from(
            &work.id,
            status.clone(),
            "Work started",
            origin("https://acme.slack.com/archives/C1/p1"),
        ),
        Err(PmError::Constraint(
            "the project manager rejected this suggestion on the same evidence"
        ))
    ));
    // New evidence may suggest it again.
    let second = store
        .propose_ticket_change_from(
            &work.id,
            status,
            "Work started",
            origin("https://acme.slack.com/archives/C1/p2"),
        )
        .unwrap();
    store.accept_ticket_proposal(&second.id).unwrap();
    assert_eq!(
        store.ticket(&work.id).unwrap().unwrap().status,
        TicketStatus::InProgress
    );
    let feedback = store.skill_feedback(&skill.id).unwrap();
    assert_eq!(feedback.len(), 2);
    assert_eq!(feedback[0].outcome, FeedbackOutcome::Accepted);
    assert_eq!(feedback[1].outcome, FeedbackOutcome::Rejected);
    assert_eq!(feedback[1].reason.as_deref(), Some("Not started yet"));
    assert_eq!(feedback[1].version, 1);
    assert_eq!(feedback[1].sources, ["slack:C1"]);
    assert_eq!(
        evidence_sources(&evidence("https://github.com/acme/pay/pull/7")),
        ["github.com"]
    );
}

#[test]
fn a_revision_is_offered_when_most_recent_suggestions_are_rejected() {
    assert_eq!(revision_reason(9, 9), None, "too few verdicts");
    assert_eq!(revision_reason(20, 12), None, "60% is not more than 60%");
    assert!(revision_reason(20, 13).is_some());
    assert!(revision_reason(10, 7).is_some());

    let mut store = store();
    let work = ticket(&mut store, "p1", "Login", None);
    let skill = installed(&mut store, manifest());
    let reason = |store: &PmStore| store.skill(&skill.id).unwrap().unwrap().revision_reason;
    for index in 0..10 {
        assert_eq!(reason(&store), None);
        let proposal = skill_proposal(
            &mut store,
            &work.id,
            &skill.id,
            &format!("https://acme.slack.com/archives/C1/p{index}"),
        );
        store.reject_ticket_proposal(&proposal.id).unwrap();
    }
    assert_eq!(
        reason(&store).as_deref(),
        Some("You rejected 10 of its last 10 suggestions.")
    );
    // A revision waiting for the PM is not offered again.
    let revision = store
        .submit_skill_draft(new_draft(manifest(), Some(skill.id.clone())))
        .unwrap();
    assert_eq!(reason(&store), None);
    // The new version starts without verdicts.
    let run = store.start_dry_run(&revision.id, 0).unwrap();
    store
        .finish_skill_run(&run.id, SkillRunOutcome::Reported, None)
        .unwrap();
    let revised = store
        .install_skill_draft(&revision.id, &revision.first_use_tools, None)
        .unwrap();
    assert_eq!(revised.version, 2);
    assert_eq!(reason(&store), None);
}

#[test]
fn each_skill_has_its_own_setup_creator() {
    let store = store();
    let general = PmAgentProfile::build(&store, "p1", PmAgentMode::SkillCreator, None).unwrap();
    assert!(general.system_prompt.contains("Bug owner finder: it runs"));
    assert!(
        general
            .system_prompt
            .contains("Slack: the PM holds no Slack connection")
    );

    let bug = PmAgentProfile::build_skill_setup(&store, "p1", SkillSetup::BugOwnerFinder).unwrap();
    assert_eq!(bug.mode, PmAgentMode::SkillCreator);
    assert_eq!(bug.tools, general.tools);
    assert!(bug.system_prompt.contains("Bug owner finder: it runs"));
    assert!(
        !bug.system_prompt
            .contains("Slack: the PM holds no Slack connection")
    );
    let kickoff = bug.first_message.unwrap();
    assert!(kickoff.starts_with("Set up only the skill named below"));
    assert!(kickoff.ends_with("The skill to set up is the Bug owner finder."));

    let slack = PmAgentProfile::build_skill_setup(&store, "p1", SkillSetup::SlackTracker).unwrap();
    assert!(
        slack
            .system_prompt
            .contains("Slack: the PM holds no Slack connection")
    );
    assert!(!slack.system_prompt.contains("Bug owner finder: it runs"));
    assert!(
        slack
            .first_message
            .unwrap()
            .ends_with("The skill to set up is the Slack tracker.")
    );
}

#[test]
fn deployment_control_sets_up_with_its_own_reader_of_the_project() {
    let store = store();
    let setup =
        PmAgentProfile::build_skill_setup(&store, "p1", SkillSetup::DeploymentControl).unwrap();
    assert!(setup.tools.contains(&crate::agent::PM_ENVIRONMENTS_PROPOSE));
    assert!(
        setup
            .system_prompt
            .contains("Mode: Deployment control setup.")
    );
    // It reads the project itself, so the creator's no-commands rule is out.
    assert!(!setup.system_prompt.contains("never run commands"));
    // It researches before it asks, and works with what the project has.
    assert!(setup.system_prompt.contains("Research first"));
    assert!(setup.system_prompt.contains("Never suggest changing it"));
    assert!(
        setup
            .first_message
            .unwrap()
            .starts_with("Research the repository now and call pm_environments_propose")
    );
}

fn proposed(name: &str, production: bool) -> ProposedEnvironment {
    ProposedEnvironment {
        name: name.into(),
        production,
        evidence: ".github/workflows/deploy.yml".into(),
    }
}

fn probe(environment: &str, url: &str) -> NewProbe {
    NewProbe {
        project_id: "p1".into(),
        environment: environment.into(),
        argv: vec!["curl".into(), url.into()],
        matcher: ProbeMatcher::CommitAncestry,
        reason: None,
    }
}

fn environment_proposal(store: &mut PmStore) -> crate::EnvironmentProposal {
    store
        .propose_environments(NewEnvironmentProposal {
            project_id: "p1".into(),
            summary: "Staging and production deploy from the workflow.".into(),
            environments: vec![proposed("staging", false), proposed("production", true)],
            probes: vec![
                probe("staging", "https://staging.example/version"),
                probe("production", "https://example/version"),
            ],
        })
        .unwrap()
}

#[test]
fn an_environment_proposal_lists_and_runs_nothing_until_the_pm_applies_it() {
    let mut store = store();
    let proposal = environment_proposal(&mut store);
    assert_eq!(proposal.probes.len(), 2);
    assert!(store.project_environments("p1").unwrap().is_empty());
    assert!(!store.deploy_tracking_enabled("p1").unwrap());
    // A probe must name a proposed environment.
    assert!(matches!(
        store.propose_environments(NewEnvironmentProposal {
            project_id: "p1".into(),
            summary: "x".into(),
            environments: vec![proposed("staging", false)],
            probes: vec![probe("qa", "https://qa.example/version")],
        }),
        Err(PmError::Invalid("probes"))
    ));

    let staging_probe = proposal.probes[0].id.clone();
    let listed = store
        .apply_environment_proposal(
            "p1",
            &["staging".into()],
            std::slice::from_ref(&staging_probe),
        )
        .unwrap();
    assert_eq!(
        listed,
        [ProjectEnvironment {
            name: "staging".into(),
            production: false
        }]
    );
    assert!(store.environment_proposal("p1").unwrap().is_none());
    let probes = store.project_probes("p1").unwrap();
    assert_eq!(probes.len(), 1, "the unticked probe is dropped");
    assert_eq!(probes[0].id, staging_probe);
    assert_eq!(probes[0].status, crate::ProbeStatus::Approved);
    assert!(store.deployment_control_enabled("p1").unwrap());
}

#[test]
fn a_new_environment_proposal_replaces_the_last_and_discard_drops_its_probes() {
    let mut store = store();
    let first = environment_proposal(&mut store);
    let second = environment_proposal(&mut store);
    assert_ne!(first.probes[0].id, second.probes[0].id);
    assert_eq!(store.project_probes("p1").unwrap().len(), 2);
    assert!(matches!(
        store.apply_environment_proposal("p1", &["qa".into()], &[]),
        Err(PmError::Invalid("environments"))
    ));
    store.discard_environment_proposal("p1").unwrap();
    assert!(store.environment_proposal("p1").unwrap().is_none());
    assert!(store.project_probes("p1").unwrap().is_empty());
    assert!(matches!(
        store.discard_environment_proposal("p1"),
        Err(PmError::NotFound)
    ));
}

#[test]
fn the_creator_revises_a_skill_from_its_manifest_and_verdicts() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Login", None);
    let skill = installed(&mut store, manifest());
    let proposal = skill_proposal(
        &mut store,
        &work.id,
        &skill.id,
        "https://acme.slack.com/archives/C1/p1",
    );
    store
        .reject_ticket_proposal_because(&proposal.id, Some("Only a branch was pushed"))
        .unwrap();

    let profile = PmAgentProfile::build_skill_reviser(&store, "p1", &skill.id).unwrap();
    assert_eq!(profile.mode, PmAgentMode::SkillCreator);
    assert!(profile.system_prompt.contains(&format!(
        "Skill to revise: Standup digest (id {}, version 1)",
        skill.id
    )));
    assert!(
        profile
            .system_prompt
            .contains("\"instructions\": \"Look for blocked tickets.\"")
    );
    assert!(profile.system_prompt.contains(&format!(
        "- rejected status on ticket {} from slack:C1: Only a branch was pushed",
        work.id
    )));
    let kickoff = profile.first_message.unwrap();
    assert!(kickoff.starts_with("Revise the installed skill below"));
    assert!(kickoff.ends_with(&format!(
        "The skill to revise is {} (Standup digest).",
        skill.id
    )));

    assert!(matches!(
        PmAgentProfile::build_skill_reviser(&store, "p2", &skill.id),
        Err(PmError::NotFound)
    ));
    with_environments(&mut store);
    store.ensure_builtin_skills("p1").unwrap();
    let builtin = store
        .skills("p1")
        .unwrap()
        .into_iter()
        .find(|skill| skill.builtin.is_some())
        .unwrap();
    assert!(matches!(
        PmAgentProfile::build_skill_reviser(&store, "p1", &builtin.id),
        Err(PmError::Constraint(_))
    ));
}

#[test]
fn an_assignee_suggestion_accepts_any_shortlisted_person() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Crash on login", None);
    let candidate = |name: &str| crate::AssigneeCandidate {
        name: name.into(),
        reason: format!("{name} changed the login code last"),
        evidence: Vec::new(),
    };
    let proposal = store
        .propose_ticket_change(
            &work.id,
            ProposalChange::Assignee {
                assignee: "Ada".into(),
                shortlist: vec![candidate("Ada"), candidate("Lin")],
            },
            "Ada knows this code",
        )
        .unwrap();
    assert!(matches!(
        store.accept_ticket_proposal_as(&proposal.id, Some("Bob")),
        Err(PmError::Invalid("assignee"))
    ));
    store
        .accept_ticket_proposal_as(&proposal.id, Some("Lin"))
        .unwrap();
    assert_eq!(
        store.ticket(&work.id).unwrap().unwrap().assignee.as_deref(),
        Some("Lin")
    );
}

#[test]
fn a_skill_pauses_after_repeated_failures_and_runs_are_counted() {
    static NOW: AtomicU64 = AtomicU64::new(1_000);
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    let skill = installed(&mut store, manifest());
    for _ in 0..SKILL_PAUSE_AFTER_FAILURES {
        let run = store
            .start_skill_run(&skill.id, SkillRunTrigger::Schedule, 1)
            .unwrap();
        assert!(matches!(
            store.start_skill_run(&skill.id, SkillRunTrigger::Manual, 1),
            Err(PmError::Constraint("the skill is already running"))
        ));
        store
            .finish_skill_run(&run.id, SkillRunOutcome::Failed, None)
            .unwrap();
    }
    let paused = store.skill(&skill.id).unwrap().unwrap();
    assert!(!paused.enabled);
    assert!(paused.paused_reason.is_some());
    assert_eq!(paused.runs_today, SKILL_PAUSE_AFTER_FAILURES);
    assert!(matches!(
        store.start_skill_run(&skill.id, SkillRunTrigger::Schedule, 1),
        Err(PmError::Constraint("the skill is off"))
    ));
    let resumed = store.set_skill_enabled(&skill.id, true).unwrap();
    assert_eq!(resumed.paused_reason, None);
    assert_eq!(resumed.consecutive_failures, 0);

    // A skipped run launched nothing and is not counted.
    store
        .record_skipped_skill_run(&skill.id, SkillRunTrigger::Schedule)
        .unwrap();
    assert_eq!(
        store.skill(&skill.id).unwrap().unwrap().runs_today,
        SKILL_PAUSE_AFTER_FAILURES
    );

    // A run past its deadline is abandoned.
    let run = store
        .start_skill_run(&skill.id, SkillRunTrigger::Manual, 1)
        .unwrap();
    assert!(
        store
            .abandon_stale_skill_runs(NOW.load(Ordering::SeqCst))
            .unwrap()
            .is_empty()
    );
    let abandoned = store
        .abandon_stale_skill_runs(1_000 + SKILL_RUN_DEADLINE_MS)
        .unwrap();
    assert_eq!(abandoned[0].id, run.id);
    assert_eq!(abandoned[0].outcome, Some(SkillRunOutcome::Abandoned));
}

#[test]
fn a_failing_skill_backs_off_doubling_and_pauses_with_the_reason() {
    static NOW: AtomicU64 = AtomicU64::new(1_000);
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    let mut waiting = manifest();
    waiting.trigger = SkillTrigger::Event {
        event: SkillEvent::JiraPulled,
    };
    let skill = installed(&mut store, waiting);
    let fail = |store: &mut PmStore, summary: Option<&str>| {
        let run = store
            .start_skill_run(&skill.id, SkillRunTrigger::Event, 1)
            .unwrap();
        store
            .finish_skill_run(&run.id, SkillRunOutcome::Failed, summary)
            .unwrap();
        store.skill(&skill.id).unwrap().unwrap()
    };
    let due = |store: &PmStore, now: u64| store.due_skills("p1", now).unwrap().len();

    let first = fail(&mut store, None);
    assert_eq!(
        first.next_attempt_at_epoch_ms,
        Some(1_000 + SKILL_RETRY_AFTER_MS)
    );
    store
        .note_skill_event("p1", SkillEvent::JiraPulled)
        .unwrap();
    assert_eq!(due(&store, 1_000 + SKILL_RETRY_AFTER_MS - 1), 0);
    assert_eq!(due(&store, 1_000 + SKILL_RETRY_AFTER_MS), 1);

    // A run that reports clears the backoff.
    let run = store
        .start_skill_run(&skill.id, SkillRunTrigger::Event, 1)
        .unwrap();
    store
        .finish_skill_run(&run.id, SkillRunOutcome::Reported, None)
        .unwrap();
    let cleared = store.skill(&skill.id).unwrap().unwrap();
    assert_eq!(cleared.next_attempt_at_epoch_ms, None);
    assert_eq!(cleared.consecutive_failures, 0);

    fail(&mut store, None);
    let second = fail(&mut store, None);
    assert_eq!(
        second.next_attempt_at_epoch_ms,
        Some(1_000 + 2 * SKILL_RETRY_AFTER_MS)
    );
    assert!(second.enabled);
    let paused = fail(&mut store, Some("Jira said 401"));
    assert!(!paused.enabled);
    assert_eq!(
        paused.paused_reason.as_deref(),
        Some(
            "Paused after 3 failed runs in a row. Last run: Jira said 401. Turn it on to try again."
        )
    );
    let resumed = store.set_skill_enabled(&skill.id, true).unwrap();
    assert_eq!(resumed.next_attempt_at_epoch_ms, None);
}

#[test]
fn events_wake_only_enabled_skills_waiting_for_them_once() {
    let mut store = store();
    let mut waiting = manifest();
    waiting.trigger = SkillTrigger::Event {
        event: SkillEvent::JiraPulled,
    };
    let skill = installed(&mut store, waiting);
    installed(&mut store, manifest());
    assert_eq!(
        store
            .note_skill_event("p1", SkillEvent::BoardChanged)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .note_skill_event("p1", SkillEvent::JiraPulled)
            .unwrap(),
        1
    );
    // A burst of events is one pending run.
    assert_eq!(
        store
            .note_skill_event("p1", SkillEvent::JiraPulled)
            .unwrap(),
        0
    );
    store
        .start_skill_run(&skill.id, SkillRunTrigger::Event, 1)
        .unwrap();
    assert_eq!(
        store
            .note_skill_event("p1", SkillEvent::JiraPulled)
            .unwrap(),
        1
    );
}

#[test]
fn discovery_is_cached_per_project_and_bounded() {
    let mut store = store();
    assert!(store.skill_discovery("p1").unwrap().is_none());
    let report = serde_json::json!({"sources": [{"name": "jira", "ready": true}]});
    store.cache_skill_discovery("p1", &report, "k1").unwrap();
    let (cached, key, _) = store.skill_discovery("p1").unwrap().unwrap();
    assert_eq!((cached, key.as_str()), (report, "k1"));
    let huge = serde_json::json!({"x": "a".repeat(crate::SKILL_DISCOVERY_MAX_BYTES)});
    assert!(matches!(
        store.cache_skill_discovery("p1", &huge, "k2"),
        Err(PmError::Invalid("discovery"))
    ));
}
