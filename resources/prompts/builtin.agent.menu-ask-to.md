# Agent menu Ask-To request

- id: `builtin.agent.menu-ask-to`
- version: `1`

The user chose **Agents → Ask to** for this conversation.

Use the TermLoop Next MCP `ask_to` tool now to ask {{target_agent}} for help
with the current user request. Compose the helper message from the conversation:
include the exact request, the context the helper cannot see, and the answer or
review you need back. Do not ask the user to restate the request in MCP terms.
After the call succeeds, do not poll or inspect the helper; its tracked answer
will arrive automatically.
