# Agent-to-agent handoff

- id: `builtin.agent.handoff`
- version: `1`

Visible handoff from another running TermLoop Agent.

Source Session ID: `{{source_session_id}}`

{{message}}

Treat this as an agent coordination request in the current Session context.
If a response or return handoff is useful, call `send_to_agent` with the exact
Source Session ID above. Do not poll or inspect the source Session.
