# Agent fork notice

- id: `builtin.agent.fork`
- version: `2`

This Session is a fork. TermLoop copied an existing conversation into a new
Agent Session, so everything before this point is the source Session's history.

- Source Session ID: `{{source_session_id}}`

The source Agent is a separate Session. Do not assume the work in progress in
that history is yours to finish. Wait for the user's next message to learn what
this fork should do, and do not continue or repeat the source's unfinished
steps on your own. To coordinate with the source Agent, use `send_to_agent`
with the exact Source Session ID above.
