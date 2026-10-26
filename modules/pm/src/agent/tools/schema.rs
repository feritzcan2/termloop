//! The MCP definitions of the PM agent tools: name, description, and the
//! JSON Schema of the arguments. The schemas are written by hand to match
//! the parameter structs; tests hold them to the structs' field names.

use serde_json::{Value, json};

use super::PmToolContext;
use crate::agent::{
    PM_BOARD_READ, PM_CHECK_REPORT, PM_EPIC_PROPOSE_BREAKDOWN, PM_OWNER_EVIDENCE_READ,
    PM_PLAYBOOK_PROPOSE, PM_RISKS_READ, PM_SKILL_DISCOVERY_READ, PM_SKILL_DRAFT_SUBMIT,
    PM_SKILL_DRY_RUN_REQUEST, PM_SKILL_RUN_FINISH, PM_SKILL_TOOL_VERIFY, PM_TICKET_NOTE_ADD,
    PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA, PM_TICKET_PROPOSE_DESCRIPTION, PM_TICKET_READ,
    PM_TICKET_SUGGEST, SKILL_READ_TOOLS,
};
use crate::commands::{TS_FRACTION_MAX_DIGITS, TS_SECONDS_MAX_DIGITS};
use crate::playbook::{
    PLAYBOOK_BRANCH_MAX_CHARS, PLAYBOOK_EVIDENCE_MAX_CHARS, PLAYBOOK_INSTRUCTIONS_MAX_CHARS,
    PLAYBOOK_RETRY_MINUTES_MAX, PLAYBOOK_RETRY_MINUTES_MIN, PLAYBOOK_STATUS_NAME_MAX_CHARS,
    PLAYBOOK_STATUS_NAMES_MAX, PLAYBOOK_STEP_CHECKS_MAX, PLAYBOOK_STEP_TITLE_MAX_CHARS,
    PLAYBOOK_STEPS_MAX, PLAYBOOK_SUMMARY_MAX_CHARS,
};
use crate::proposal::{ASSIGNEE_SHORTLIST_MAX, JIRA_COMMENT_MAX_CHARS};
use crate::skill::{
    CHANNEL_ID_MAX_BYTES, CHANNEL_NAME_MAX_CHARS, EVIDENCE_LABEL_MAX_CHARS, EVIDENCE_MAX,
    EVIDENCE_QUOTE_MAX_CHARS, SKILL_AGENT_TOOLS_MAX, SKILL_CHANGELOG_MAX_CHARS, SKILL_CHANNELS_MAX,
    SKILL_DESCRIPTION_MAX_CHARS, SKILL_INSTRUCTIONS_MAX_CHARS, SKILL_NAME_MAX_CHARS,
    SKILL_NEEDED_TOOLS_MAX, SKILL_RUN_SUMMARY_MAX_CHARS, SKILL_SCHEDULE_MAX_MINUTES,
    SKILL_SCHEDULE_MIN_MINUTES, SKILL_STEPS_MAX_CHARS, SKILL_TOOLS_MAX,
    SKILL_WHAT_IT_DOES_MAX_CHARS,
};
use crate::{
    BREAKDOWN_TASKS_MAX, EPIC_DESCRIPTION_MAX_CHARS, EPIC_TITLE_MAX_CHARS,
    PROPOSAL_SUMMARY_MAX_CHARS, TICKET_ASSIGNEE_MAX_CHARS, TICKET_BLOCKERS_MAX,
    TICKET_CRITERIA_MAX, TICKET_DESCRIPTION_MAX_CHARS, TICKET_ITEM_MAX_CHARS,
    TICKET_NOTE_LABEL_MAX_CHARS, TICKET_NOTE_MAX_CHARS, TICKET_NOTE_URL_MAX_BYTES,
    TICKET_TITLE_MAX_CHARS,
};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}

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
            "Report, once, whether this check's ticket passed its Playbook step. passed: you \
             read evidence that it did. waiting: you read where it shows and it has not \
             happened yet. blocked: you could not read what the step needs. Recorded in the PM \
             only; nothing external is written.",
            object(
                json!({
                    "ticketId": ticket_id(),
                    "stepId": { "type": "string", "minLength": 1, "description": "The step this check looks at." },
                    "verdict": { "type": "string", "enum": ["passed", "waiting", "blocked"] },
                    "evidence": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": PLAYBOOK_EVIDENCE_MAX_CHARS,
                        "description": "One or two factual sentences: what you read and what it showed, e.g. 'The INT pipeline's last successful run (#812) deployed main at a1b2c3d, which contains PR #7.'"
                    }
                }),
                &["ticketId", "stepId", "verdict", "evidence"],
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
                    },
                    "channelWatermarks": {
                        "type": "array",
                        "maxItems": SKILL_CHANNELS_MAX,
                        "items": object(json!({
                            "channelId": { "type": "string", "pattern": channel_id_pattern() },
                            "ts": { "type": "string", "pattern": format!("^[0-9]{{1,{TS_SECONDS_MAX_DIGITS}}}\\.[0-9]{{1,{TS_FRACTION_MAX_DIGITS}}}$"), "description": "The ts of the newest message you read in the channel." }
                        }), &["channelId", "ts"]),
                        "description": "For a Slack skill: per channel you read, the newest message ts, so the next run starts after it."
                    }
                }),
                &["summary"],
            ),
        ),
        PM_SKILL_DISCOVERY_READ => (
            "Read what this PM project can use: its own sources (Jira, GitHub, the Playbook, \
             Slack) with their tiers, allowlisted command-line tools on the PATH and \
             whether each is logged in, and the MCP servers configured for Claude and Codex \
             (name and transport only). Cached; set refresh to read again. Read-only.",
            object(
                json!({ "refresh": { "type": "boolean", "description": "Read again instead of the cache." } }),
                &[],
            ),
        ),
        PM_OWNER_EVIDENCE_READ => (
            "Rank who most likely owns one ticket, best first, up to 3 people: from commits \
             to the files the ticket names and commits naming similar tickets (the project's \
             code folder), authors and reviewers of related pull requests (GitHub), and \
             assignees of similar past tickets. Each person comes with a one-line reason and \
             evidence; `limitation` says plainly what could not be read. Read-only.",
            object(json!({ "ticketId": ticket_id() }), &["ticketId"]),
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
                        "items": object(json!({
                            "id": { "type": "string", "pattern": channel_id_pattern() },
                            "name": { "type": "string", "minLength": 1, "maxLength": CHANNEL_NAME_MAX_CHARS }
                        }), &["id", "name"]),
                        "description": "For a Slack source: the channels you ranked, best first; the PM ticks which to keep."
                    },
                    "agentTools": {
                        "type": "array",
                        "maxItems": SKILL_AGENT_TOOLS_MAX,
                        "uniqueItems": true,
                        "items": { "type": "string", "pattern": "^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$" },
                        "description": "Read-only tools of your own MCP servers a run may call, exactly as you see them (e.g. a Slack server's channel history read). Never a tool that sends, posts, creates, edits, or deletes."
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
        PM_PLAYBOOK_PROPOSE => (
            "Propose the project's Playbook: the steps a ticket passes on its way to done, in \
             order. A step passes by facts the PM app reads itself (a status, a pull request) or, \
             when no fact shows it, by an agent following the step's instructions. The PM \
             reviews and edits it in the Skills panel; nothing changes until then. A new \
             proposal replaces the previous one.",
            object(
                json!({
                    "summary": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": PLAYBOOK_SUMMARY_MAX_CHARS,
                        "description": "What you read and what each step rests on, in a few plain lines for the PM."
                    },
                    "steps": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": PLAYBOOK_STEPS_MAX,
                        "items": playbook_step()
                    }
                }),
                &["summary", "steps"],
            ),
        ),
        PM_EPIC_PROPOSE_BREAKDOWN => (
            "Propose splitting a goal into tickets: under an existing epic (epicId from \
             pm_board_read) or a new epic (epic), never both. Each task becomes a ticket with \
             its description and acceptance criteria once the PM accepts it. The PM picks the \
             tasks to keep; nothing changes until then, and nothing is written to Jira.",
            object(
                json!({
                    "epicId": { "type": "string", "minLength": 1, "description": "An existing epic's id from pm_board_read." },
                    "epic": object(
                        json!({
                            "title": { "type": "string", "minLength": 1, "maxLength": EPIC_TITLE_MAX_CHARS },
                            "description": { "type": "string", "maxLength": EPIC_DESCRIPTION_MAX_CHARS, "description": "The goal and its scope in Markdown." }
                        }),
                        &["title"],
                    ),
                    "tasks": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": BREAKDOWN_TASKS_MAX,
                        "description": "Independently deliverable tickets, in the order to build them, with distinct titles.",
                        "items": object(
                            json!({
                                "title": { "type": "string", "minLength": 1, "maxLength": TICKET_TITLE_MAX_CHARS },
                                "description": { "type": "string", "maxLength": TICKET_DESCRIPTION_MAX_CHARS, "description": "What to build and why, in Markdown." },
                                "acceptanceCriteria": {
                                    "type": "array",
                                    "maxItems": TICKET_CRITERIA_MAX,
                                    "uniqueItems": true,
                                    "items": { "type": "string", "minLength": 1, "maxLength": TICKET_ITEM_MAX_CHARS }
                                }
                            }),
                            &["title"],
                        )
                    },
                    "summary": summary()
                }),
                &["tasks", "summary"],
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

/// One Playbook step as the setup proposes it.
fn playbook_step() -> Value {
    let label = |max: usize| json!({ "type": "string", "minLength": 1, "maxLength": max });
    object(
        json!({
            "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 64,
                "pattern": "^[a-z0-9-]+$",
                "description": "A short stable id, e.g. on-int."
            },
            "title": label(PLAYBOOK_STEP_TITLE_MAX_CHARS),
            "checks": {
                "type": "array",
                "maxItems": PLAYBOOK_STEP_CHECKS_MAX,
                "description": "Facts that pass the step; any one is enough.",
                "items": {
                    "oneOf": [
                        object(json!({
                            "kind": { "const": "status" },
                            "names": { "type": "array", "maxItems": PLAYBOOK_STATUS_NAMES_MAX, "items": label(PLAYBOOK_STATUS_NAME_MAX_CHARS), "description": "Jira status names, matched ignoring case." },
                            "category": { "type": "string", "enum": ["started", "done"] }
                        }), &["kind"]),
                        object(json!({
                            "kind": { "const": "pullRequest" },
                            "state": { "type": "string", "enum": ["open", "merged"] },
                            "baseBranch": label(PLAYBOOK_BRANCH_MAX_CHARS)
                        }), &["kind", "state"])
                    ]
                }
            },
            "agent": object(
                json!({
                    "instructions": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": PLAYBOOK_INSTRUCTIONS_MAX_CHARS,
                        "description": "For the check agent: what to read, with which read-only command or tool, and what counts as passed. Name the exact command and where you found it."
                    },
                    "retryMinutes": { "type": "integer", "minimum": PLAYBOOK_RETRY_MINUTES_MIN, "maximum": PLAYBOOK_RETRY_MINUTES_MAX }
                }),
                &["instructions", "retryMinutes"],
            )
        }),
        &["id", "title"],
    )
}

fn channel_id_pattern() -> String {
    format!("^[A-Za-z0-9]{{1,{CHANNEL_ID_MAX_BYTES}}}$")
}
