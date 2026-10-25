//! The MCP definitions of the PM agent tools: name, description, and the
//! JSON Schema of the arguments. The schemas are written by hand to match
//! the parameter structs; tests hold them to the structs' field names.

use serde_json::{Value, json};

use super::PmToolContext;
use crate::agent::{
    PM_BOARD_READ, PM_CHECK_REPORT, PM_RISKS_READ, PM_SKILL_DISCOVERY_READ, PM_SKILL_DRAFT_SUBMIT,
    PM_SKILL_DRY_RUN_REQUEST, PM_SKILL_RUN_FINISH, PM_SKILL_TOOL_VERIFY, PM_TICKET_NOTE_ADD,
    PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA, PM_TICKET_PROPOSE_DESCRIPTION, PM_TICKET_READ,
    PM_TICKET_SUGGEST, SKILL_READ_TOOLS,
};
use crate::proposal::{ASSIGNEE_SHORTLIST_MAX, JIRA_COMMENT_MAX_CHARS};
use crate::skill::{
    EVIDENCE_LABEL_MAX_CHARS, EVIDENCE_MAX, EVIDENCE_QUOTE_MAX_CHARS, SKILL_CHANGELOG_MAX_CHARS,
    SKILL_CHANNELS_MAX, SKILL_DESCRIPTION_MAX_CHARS, SKILL_INSTRUCTIONS_MAX_CHARS,
    SKILL_NAME_MAX_CHARS, SKILL_NEEDED_TOOLS_MAX, SKILL_RUN_SUMMARY_MAX_CHARS,
    SKILL_SCHEDULE_MAX_MINUTES, SKILL_SCHEDULE_MIN_MINUTES, SKILL_STEPS_MAX_CHARS, SKILL_TOOLS_MAX,
    SKILL_WHAT_IT_DOES_MAX_CHARS,
};
use crate::{
    CHECK_PROBE_PROPOSALS_MAX, ENVIRONMENT_NAME_MAX_CHARS, PROPOSAL_SUMMARY_MAX_CHARS,
    TICKET_ASSIGNEE_MAX_CHARS, TICKET_BLOCKERS_MAX, TICKET_CHECK_NOTES_MAX_BYTES,
    TICKET_CRITERIA_MAX, TICKET_DESCRIPTION_MAX_CHARS, TICKET_ENVIRONMENT_FACTS_MAX,
    TICKET_ITEM_MAX_CHARS, TICKET_NOTE_LABEL_MAX_CHARS, TICKET_NOTE_MAX_CHARS,
    TICKET_NOTE_URL_MAX_BYTES,
};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}

const DEPLOY_STATES: [&str; 4] = ["deployed", "inProgress", "notDeployed", "unknown"];

fn ticket_id() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "The PM ticket id." })
}

fn summary() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": PROPOSAL_SUMMARY_MAX_CHARS,
        "description": "One line for the PM: what changes and why."
    })
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn deploy_state() -> Value {
    json!({ "type": "string", "enum": DEPLOY_STATES })
}

fn evidence() -> Value {
    json!({
        "type": "array",
        "maxItems": EVIDENCE_MAX,
        "description": "The links the suggestion rests on, e.g. a Slack permalink with a quote of at most 280 characters, a pull request, or a commit.",
        "items": object(
            json!({
                "label": { "type": "string", "minLength": 1, "maxLength": EVIDENCE_LABEL_MAX_CHARS },
                "url": { "type": "string", "pattern": "^https://", "maxLength": 2048 },
                "quote": { "type": "string", "minLength": 1, "maxLength": EVIDENCE_QUOTE_MAX_CHARS }
            }),
            &["label"],
        )
    })
}

fn items(max: usize) -> Value {
    json!({
        "type": "array",
        "minItems": 1,
        "maxItems": max,
        "uniqueItems": true,
        "items": { "type": "string", "minLength": 1, "maxLength": TICKET_ITEM_MAX_CHARS }
    })
}

fn person() -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": TICKET_ASSIGNEE_MAX_CHARS })
}

/// The suggested change, one kind at a time.
fn change() -> Value {
    let kind = |name: &str| json!({ "const": name });
    json!({
        "oneOf": [
            object(json!({ "kind": kind("blockers"), "blockers": items(TICKET_BLOCKERS_MAX) }), &["kind", "blockers"]),
            object(json!({
                "kind": kind("status"),
                "status": { "type": "string", "enum": ["todo", "inProgress", "inReview", "done"] }
            }), &["kind", "status"]),
            object(json!({
                "kind": kind("assignee"),
                "assignee": person(),
                "shortlist": {
                    "type": "array",
                    "maxItems": ASSIGNEE_SHORTLIST_MAX,
                    "description": "Up to 3 people, best first; the first is the assignee.",
                    "items": object(json!({
                        "name": person(),
                        "reason": { "type": "string", "minLength": 1, "maxLength": EVIDENCE_LABEL_MAX_CHARS },
                        "evidence": evidence()
                    }), &["name", "reason"])
                }
            }), &["kind", "assignee", "shortlist"]),
            object(json!({
                "kind": kind("sprint"),
                "sprintId": { "type": ["string", "null"], "minLength": 1, "description": "An open sprint id from pm_board_read, or null for the backlog." }
            }), &["kind", "sprintId"]),
            object(json!({
                "kind": kind("jiraComment"),
                "body": { "type": "string", "minLength": 1, "maxLength": JIRA_COMMENT_MAX_CHARS }
            }), &["kind", "body"]),
            object(json!({
                "kind": kind("description"),
                "description": { "type": "string", "minLength": 1, "maxLength": TICKET_DESCRIPTION_MAX_CHARS }
            }), &["kind", "description"]),
            object(json!({ "kind": kind("acceptanceCriteria"), "criteria": items(TICKET_CRITERIA_MAX) }), &["kind", "criteria"])
        ]
    })
}

fn skill_trigger() -> Value {
    json!({
        "oneOf": [
            object(json!({ "kind": { "const": "manual" } }), &["kind"]),
            object(json!({
                "kind": { "const": "schedule" },
                "everyMinutes": { "type": "integer", "minimum": SKILL_SCHEDULE_MIN_MINUTES, "maximum": SKILL_SCHEDULE_MAX_MINUTES }
            }), &["kind", "everyMinutes"]),
            object(json!({
                "kind": { "const": "event" },
                "event": { "type": "string", "enum": ["jiraPulled", "deployChanged", "boardChanged"] }
            }), &["kind", "event"])
        ]
    })
}

fn definition(name: &'static str) -> PmToolDefinition {
    let (description, input_schema) = match name {
        PM_BOARD_READ => (
            "Read the project board: open sprints and their tickets with delivery stage, risk \
             count, and check reasons. Read-only.",
            object(
                json!({
                    "scope": {
                        "type": "string",
                        "enum": ["activeSprint", "all"],
                        "description": "activeSprint (default) or every ticket including the backlog."
                    }
                }),
                &[],
            ),
        ),
        PM_TICKET_READ => (
            "Read one ticket: its description, acceptance criteria, blockers, delivery stage, \
             risks, recorded facts, pending proposals, and notes (facts learned and sources \
             followed; a pending note is not in the description yet). Read-only.",
            object(json!({ "ticketId": ticket_id() }), &["ticketId"]),
        ),
        PM_TICKET_PROPOSE_DESCRIPTION => (
            "Propose a complete new description for a ticket. The PM accepts or rejects it; \
             nothing changes until then, and nothing is written to Jira.",
            object(
                json!({
                    "ticketId": ticket_id(),
                    "description": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": TICKET_DESCRIPTION_MAX_CHARS,
                        "description": "The full Markdown description, written for the developers doing the work."
                    },
                    "summary": summary(),
                    "evidence": evidence()
                }),
                &["ticketId", "description", "summary"],
            ),
        ),
        PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA => (
            "Propose acceptance criteria to add to a ticket. The PM accepts or rejects them; \
             nothing changes until then, and nothing is written to Jira.",
            object(
                json!({
                    "ticketId": ticket_id(),
                    "criteria": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": TICKET_CRITERIA_MAX,
                        "uniqueItems": true,
                        "items": { "type": "string", "minLength": 1, "maxLength": TICKET_ITEM_MAX_CHARS }
                    },
                    "summary": summary(),
                    "evidence": evidence()
                }),
                &["ticketId", "criteria", "summary"],
            ),
        ),
        PM_RISKS_READ => (
            "Read the delivery risks of the project's tickets, or of one ticket. Read-only.",
            object(json!({ "ticketId": ticket_id() }), &[]),
        ),
        PM_CHECK_REPORT => (
            "Report what this delivery check found about its ticket, once. Records environment \
             states, blockers, and notes in the PM; probe commands are proposed for the PM to \
             approve. Nothing external is written.",
            object(
                json!({
                    "ticketId": ticket_id(),
                    "environments": {
                        "type": "array",
                        "maxItems": TICKET_ENVIRONMENT_FACTS_MAX,
                        "items": object(
                            json!({
                                "name": { "type": "string", "minLength": 1, "maxLength": ENVIRONMENT_NAME_MAX_CHARS },
                                "state": deploy_state(),
                                "detail": { "type": "string", "minLength": 1 }
                            }),
                            &["name", "state"],
                        )
                    },
                    "blockers": { "type": "string", "minLength": 1 },
                    "notesMarkdown": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": TICKET_CHECK_NOTES_MAX_BYTES,
                        "description": "Markdown with ## Observed, ## Inferred, and ## Unknown sections."
                    },
                    "agentProbe": object(
                        json!({
                            "probeId": { "type": "string", "minLength": 1 },
                            "state": deploy_state(),
                            "detail": { "type": "string", "minLength": 1 }
                        }),
                        &["probeId", "state"],
                    ),
                    "probeProposals": {
                        "type": "array",
                        "maxItems": CHECK_PROBE_PROPOSALS_MAX,
                        "items": object(
                            json!({
                                "environment": { "type": "string", "minLength": 1 },
                                "argv": {
                                    "type": "array",
                                    "minItems": 1,
                                    "items": { "type": "string" }
                                },
                                "matcher": { "type": "string", "enum": ["commitAncestry", "agent"] },
                                "reason": { "type": "string", "minLength": 1 }
                            }),
                            &["environment", "argv", "matcher"],
                        )
                    }
                }),
                &["ticketId", "environments", "notesMarkdown"],
            ),
        ),
        PM_TICKET_SUGGEST => (
            "Suggest one ticket change: blockers to add, a status, an assignee with a ranked \
             shortlist, a sprint move, a Jira comment draft, a description, or acceptance \
             criteria. The PM accepts or rejects it; nothing changes until then, and nothing is \
             written to Jira.",
            object(
                json!({
                    "ticketId": ticket_id(),
                    "change": change(),
                    "summary": summary(),
                    "evidence": evidence()
                }),
                &["ticketId", "change", "summary"],
            ),
        ),
        PM_SKILL_RUN_FINISH => (
            "Close this skill run once, after your last suggestion. Stop afterwards.",
            object(
                json!({
                    "summary": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": SKILL_RUN_SUMMARY_MAX_CHARS,
                        "description": "One line: what you looked at and what you suggested."
                    }
                }),
                &["summary"],
            ),
        ),
        PM_SKILL_DISCOVERY_READ => (
            "Read what this PM project can use: its own sources (Jira, GitHub, environments, \
             probes, Slack) with their tiers, allowlisted command-line tools on the PATH and \
             whether each is logged in, and the MCP servers configured for Claude and Codex \
             (name and transport only). Cached; set refresh to read again. Read-only.",
            object(
                json!({ "refresh": { "type": "boolean", "description": "Read again instead of the cache." } }),
                &[],
            ),
        ),
        PM_SKILL_TOOL_VERIFY => (
            "Check one discovered tool with a harmless read-only call before you claim it \
             works. Read-only.",
            object(
                json!({
                    "kind": { "type": "string", "enum": ["source", "cli", "mcp"] },
                    "name": { "type": "string", "minLength": 1, "maxLength": 64, "description": "A source (board, jira, deployments, slack, git, github), an allowlisted CLI, or a configured MCP server name." }
                }),
                &["kind", "name"],
            ),
        ),
        PM_SKILL_DRAFT_SUBMIT => (
            "Submit a skill draft for the PM to review: a plain-language name, description, and \
             what it will do; when it runs; what it reads; the exact read tools a run may call; \
             the run instructions; and the tools it needs, with exact human steps for any that \
             are missing. Nothing is installed; the PM installs it after a dry run.",
            object(
                json!({
                    "name": { "type": "string", "minLength": 1, "maxLength": SKILL_NAME_MAX_CHARS },
                    "description": { "type": "string", "minLength": 1, "maxLength": SKILL_DESCRIPTION_MAX_CHARS },
                    "trigger": skill_trigger(),
                    "sources": {
                        "type": "array",
                        "minItems": 1,
                        "uniqueItems": true,
                        "items": { "type": "string", "enum": ["board", "jira", "deployments", "slack", "git", "github"] }
                    },
                    "prefilter": {
                        "type": "string",
                        "enum": ["boardChanges", "slackMentions", "bugTickets"],
                        "description": "The deterministic check that decides whether a run has anything new: changed tickets, Slack messages naming tickets, or new bug-like tickets."
                    },
                    "tools": {
                        "type": "array",
                        "maxItems": SKILL_TOOLS_MAX,
                        "uniqueItems": true,
                        "items": { "type": "string", "enum": SKILL_READ_TOOLS },
                        "description": "The read tools a run may call. Proposal tools are always added."
                    },
                    "instructions": { "type": "string", "minLength": 1, "maxLength": SKILL_INSTRUCTIONS_MAX_CHARS },
                    "channels": {
                        "type": "array",
                        "maxItems": SKILL_CHANNELS_MAX,
                        "uniqueItems": true,
                        "items": { "type": "string", "pattern": "^[A-Za-z0-9]{1,32}$" },
                        "description": "Slack channel ids to read, for a Slack source only."
                    },
                    "whatItWillDo": { "type": "string", "minLength": 1, "maxLength": SKILL_WHAT_IT_DOES_MAX_CHARS },
                    "neededTools": {
                        "type": "array",
                        "maxItems": SKILL_NEEDED_TOOLS_MAX,
                        "items": object(json!({
                            "name": { "type": "string", "minLength": 1, "maxLength": 80 },
                            "available": { "type": "boolean" },
                            "steps": { "type": "string", "minLength": 1, "maxLength": SKILL_STEPS_MAX_CHARS, "description": "Exact human steps to add a missing tool." }
                        }), &["name", "available"])
                    },
                    "changelog": { "type": "string", "minLength": 1, "maxLength": SKILL_CHANGELOG_MAX_CHARS },
                    "baseSkillId": { "type": "string", "minLength": 1, "description": "The installed skill this draft revises." }
                }),
                &[
                    "name",
                    "description",
                    "trigger",
                    "sources",
                    "prefilter",
                    "tools",
                    "instructions",
                    "whatItWillDo",
                ],
            ),
        ),
        PM_SKILL_DRY_RUN_REQUEST => (
            "Run a submitted draft once against the last 3 days of data. Its suggestions are \
             kept as samples on the draft for the PM, never as proposals. Returns at once; the \
             PM watches the draft card.",
            object(
                json!({ "draftId": { "type": "string", "minLength": 1 } }),
                &["draftId"],
            ),
        ),
        PM_TICKET_NOTE_ADD => (
            "Record what you learned about a ticket as a note: a fact (a decision, a changed \
             scope, an answer to an open question) or a source to read again for new facts \
             (a Slack thread, a document). A note never changes the ticket; propose a \
             description that merges the pending notes afterwards. A note already recorded \
             from the same sourceKey or source link is refused.",
            object(
                json!({
                    "ticketId": ticket_id(),
                    "kind": { "type": "string", "enum": ["fact", "source"] },
                    "text": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": TICKET_NOTE_MAX_CHARS,
                        "description": format!("A fact in your own words, or a source's one-line label of at most {TICKET_NOTE_LABEL_MAX_CHARS} characters.")
                    },
                    "url": {
                        "type": "string",
                        "maxLength": TICKET_NOTE_URL_MAX_BYTES,
                        "pattern": "^https://",
                        "description": "Where the fact was read (e.g. a Slack permalink); required for a source."
                    },
                    "sourceKey": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "pattern": "^[!-~]+$",
                        "description": "A stable id of what the fact was read from, e.g. slack:<channel>:<message ts>."
                    }
                }),
                &["ticketId", "kind", "text"],
            ),
        ),
        _ => unreachable!("every PM tool has a definition"),
    };
    PmToolDefinition {
        name,
        description,
        input_schema,
    }
}

/// The tools a caller lists over MCP, in a stable order.
pub fn pm_tool_definitions(context: &PmToolContext) -> Vec<PmToolDefinition> {
    context.tools().into_iter().map(definition).collect()
}
