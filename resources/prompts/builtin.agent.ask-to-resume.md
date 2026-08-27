# Ask-To Resume Recovery

Template id: `builtin.agent.ask-to-resume`

The TermLoop daemon restarted before it could confirm delivery of the current
Ask-To response. Continue from your resumed provider conversation and submit the
answer again for request `{{request_id}}` using the TermLoop Next MCP
`reply_to_request` tool exactly once.

Do not start a new review and do not call `ask_to`. Reuse the answer and context
already present in this conversation. In Claude the exact tool ID is
`mcp__termloop_next__reply_to_request`; in Codex it is
`mcp__termloop_next__reply_to_request`.
