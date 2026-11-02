# Task Playbook evaluation retry

- id: `builtin.agent.playbook-evaluator-retry`
- version: `1`

Your turn ended without an accepted report, and this evaluation is still open.
The TermLoop MCP server has had time to connect since you started. A notice
that names other MCP servers as disconnected does not concern `termloop_next`.

If `playbook_evaluation_read` is still not in your tool list, search for it
with your tool-search tool, which waits for servers that are still connecting.
Then carry out the evaluation instructions you received at launch: read the
assignment, check the active step against current evidence, and submit one
report with `playbook_evaluation_complete`. If the tools remain unavailable
after that search, stop and say so; TermLoop does not send this reminder again.
