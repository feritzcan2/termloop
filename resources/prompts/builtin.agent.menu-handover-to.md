# Agent menu handover request

- id: `builtin.agent.menu-handover-to`
- version: `1`

The user chose **Agents → Handover to** for this conversation and selected a
running TermLoop Agent.

Use the TermLoop Next MCP `send_to_agent` tool now to hand the current user
request to exact Session ID `{{target_session_id}}`. Compose the message from this conversation and
include the request plus all context the target Agent cannot see. This is a
one-way delivery: after the call succeeds, do not wait for or poll for a reply.
