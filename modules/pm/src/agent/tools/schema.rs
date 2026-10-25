//! The MCP definitions of the PM agent tools: name, description, and the
//! JSON Schema of the arguments. The schemas are written by hand to match
//! the parameter structs; tests hold them to the structs' field names.

use serde_json::{Value, json};

use crate::agent::{
    PM_BOARD_READ, PM_CHECK_REPORT, PM_RISKS_READ, PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
    PM_TICKET_PROPOSE_DESCRIPTION, PM_TICKET_READ, PmAgentMode,
};
use crate::{
    CHECK_PROBE_PROPOSALS_MAX, ENVIRONMENT_NAME_MAX_CHARS, PROPOSAL_SUMMARY_MAX_CHARS,
    TICKET_CHECK_NOTES_MAX_BYTES, TICKET_CRITERIA_MAX, TICKET_DESCRIPTION_MAX_CHARS,
    TICKET_ENVIRONMENT_FACTS_MAX, TICKET_ITEM_MAX_CHARS,
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
             risks, recorded facts, and pending proposals. Read-only.",
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
                    "summary": summary()
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
                    "summary": summary()
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
        _ => unreachable!("every PM tool has a definition"),
    };
    PmToolDefinition {
        name,
        description,
        input_schema,
    }
}

/// The tools a mode lists over MCP, in a stable order.
pub fn pm_tool_definitions(mode: PmAgentMode) -> Vec<PmToolDefinition> {
    mode.tools().iter().copied().map(definition).collect()
}
