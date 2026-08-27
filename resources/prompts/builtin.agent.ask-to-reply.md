---
id: `builtin.agent.ask-to-reply`
version: 1
---

TermLoop Ask-To final reply

- request: `{{request_id}}`
- conversation: `{{conversation_id}}`
- helper Session: `{{helper_session_id}}`

The helper completed this request exactly once. Present its answer to the user
now. Do not call `ask_result`, poll another tool, or ask the helper to repeat it.

Helper answer:

{{message}}
