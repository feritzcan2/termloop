use super::skill::{evidence, installed, manifest, new_draft};
use super::{store, ticket};
use crate::delivery::risks::DAY_MS;
use crate::skill::{
    SkillChannel, SkillManifest, SkillPrefilter, SkillRunTrigger, SkillSource, valid_agent_tool,
};
use crate::{
    ChannelWatermark, PmError, PmStore, ProposalChange, ProposalOrigin, SKILL_SLACK_RETENTION_MS,
    TicketStatus, slack_ts_key,
};

const SHOP: &str = "C0SHOP";
const OPS: &str = "C0OPS";

fn channel(id: &str, name: &str) -> SkillChannel {
    SkillChannel {
        id: id.into(),
        name: name.into(),
    }
}

fn slack_manifest() -> SkillManifest {
    SkillManifest {
        name: "Slack tracker".into(),
        sources: vec![SkillSource::Slack, SkillSource::Board],
        prefilter: SkillPrefilter::SlackMentions,
        channels: vec![channel(SHOP, "shop"), channel(OPS, "ops")],
        agent_tools: vec![
            "mcp__claude_ai_Slack__slack_read_channel".into(),
            "mcp__claude_ai_Slack__slack_read_thread".into(),
        ],
        ..manifest()
    }
}

fn watermark(channel_id: &str, ts: &str) -> ChannelWatermark {
    ChannelWatermark {
        channel_id: channel_id.into(),
        ts: ts.into(),
    }
}

fn reported(store: &mut PmStore, skill_id: &str, watermarks: &[ChannelWatermark]) {
    let run = store
        .start_skill_run(skill_id, SkillRunTrigger::Manual, 1)
        .unwrap();
    store
        .report_skill_run(&run.id, "Read Slack", watermarks)
        .unwrap();
}

#[test]
fn agent_tools_are_read_only_tools_of_the_agents_own_servers() {
    for allowed in [
        "mcp__claude_ai_Slack__slack_read_channel",
        "mcp__slack__conversations_history",
        "mcp__slack__getPermalink",
        "mcp__slack__slack_search_public",
    ] {
        assert!(valid_agent_tool(allowed), "{allowed}");
    }
    for refused in [
        "mcp__claude_ai_Slack__slack_send_message",
        "mcp__claude_ai_Slack__slack_send_message_draft",
        "mcp__claude_ai_Slack__slack_add_reaction",
        "mcp__slack__chatPostMessage",
        "mcp__slack__slack_update_canvas",
        "mcp__termloop_pm__pm_board_read",
        "slack_read_channel",
        "mcp__slack",
        "mcp__slack__read__more",
        "mcp__slack__*",
    ] {
        assert!(!valid_agent_tool(refused), "{refused}");
    }
    let mut manifest = slack_manifest();
    manifest.agent_tools = vec!["mcp__slack__slack_send_message".into()];
    assert_eq!(manifest.invalid_field(), Some("agentTools"));
    let mut manifest = slack_manifest();
    manifest.channels.clear();
    assert_eq!(manifest.invalid_field(), Some("channels"));
    let mut manifest = slack_manifest();
    manifest.channels.push(channel(SHOP, "shop again"));
    assert_eq!(manifest.invalid_field(), Some("channels"));
}

#[test]
fn agent_tools_need_their_own_approval_and_install_keeps_the_ticked_channels() {
    let mut store = store();
    let draft = store
        .submit_skill_draft(new_draft(slack_manifest(), None))
        .unwrap();
    assert!(
        draft
            .first_use_tools
            .contains(&"mcp__claude_ai_Slack__slack_read_channel".to_owned())
    );
    let run = store.start_dry_run(&draft.id, 0).unwrap();
    store.report_skill_run(&run.id, "Samples", &[]).unwrap();
    let without_slack: Vec<String> = draft.manifest.approved_tools.clone();
    assert!(matches!(
        store.install_skill_draft(&draft.id, &without_slack, None),
        Err(PmError::Constraint(_))
    ));
    assert!(matches!(
        store.install_skill_draft(&draft.id, &draft.first_use_tools, Some(&[])),
        Err(PmError::Invalid("channels"))
    ));
    let skill = store
        .install_skill_draft(&draft.id, &draft.first_use_tools, Some(&[SHOP.into()]))
        .unwrap();
    assert_eq!(skill.manifest.channels, [channel(SHOP, "shop")]);
}

#[test]
fn watermarks_only_move_forward_and_stay_within_the_skills_channels() {
    let mut store = store();
    let skill = installed(&mut store, slack_manifest());
    reported(
        &mut store,
        &skill.id,
        &[
            watermark(SHOP, "1712345678.000200"),
            watermark(OPS, "1712345600.1"),
        ],
    );
    // An older position is ignored; a newer one moves forward.
    reported(
        &mut store,
        &skill.id,
        &[
            watermark(SHOP, "1712345678.000100"),
            watermark(OPS, "1712345601.0"),
        ],
    );
    assert_eq!(
        store.skill_channel_watermarks(&skill.id).unwrap(),
        [
            watermark(OPS, "1712345601.0"),
            watermark(SHOP, "1712345678.000200")
        ]
    );
    // A channel the skill does not read, or a malformed ts, is refused and
    // leaves the run running.
    let run = store
        .start_skill_run(&skill.id, SkillRunTrigger::Manual, 1)
        .unwrap();
    assert!(matches!(
        store.report_skill_run(&run.id, "x", &[watermark("C0OTHER", "1.0")]),
        Err(PmError::Invalid("channelWatermarks"))
    ));
    assert!(matches!(
        store.report_skill_run(&run.id, "x", &[watermark(SHOP, "soon")]),
        Err(PmError::Invalid("channelWatermarks"))
    ));
    store.report_skill_run(&run.id, "x", &[]).unwrap();
    assert!(slack_ts_key("1712345678.0002") > slack_ts_key("1712345678.000100"));
    assert_eq!(slack_ts_key("1.5"), slack_ts_key("1.50"));
}

#[test]
fn a_dry_run_keeps_no_watermark() {
    let mut store = store();
    let draft = store
        .submit_skill_draft(new_draft(slack_manifest(), None))
        .unwrap();
    let run = store.start_dry_run(&draft.id, 0).unwrap();
    store
        .report_skill_run(&run.id, "Samples", &[watermark(SHOP, "1712345678.0")])
        .unwrap();
    let skill = store
        .install_skill_draft(&draft.id, &draft.first_use_tools, None)
        .unwrap();
    assert!(
        store
            .skill_channel_watermarks(&skill.id)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn watermarks_and_skill_suggestions_expire_after_30_days() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Login", None);
    let skill = installed(&mut store, slack_manifest());
    reported(&mut store, &skill.id, &[watermark(SHOP, "1712345678.0")]);
    store
        .propose_ticket_change_from(
            &work.id,
            ProposalChange::Status {
                status: TicketStatus::InProgress,
            },
            "Work started",
            Some(ProposalOrigin {
                skill_id: skill.id.clone(),
                skill_version: 1,
                evidence: evidence("https://acme.slack.com/archives/C0SHOP/p1"),
            }),
        )
        .unwrap();
    let now = store.now();
    assert_eq!(store.expire_skill_data(now + DAY_MS).unwrap(), 0);
    assert_eq!(store.skill_channel_watermarks(&skill.id).unwrap().len(), 1);
    assert_eq!(
        store
            .expire_skill_data(now + SKILL_SLACK_RETENTION_MS + 1)
            .unwrap(),
        1
    );
    assert!(
        store
            .skill_channel_watermarks(&skill.id)
            .unwrap()
            .is_empty()
    );
    assert!(store.ticket_proposals(&work.id).unwrap().is_empty());
}
