---
id: `builtin.agent.ask-to-followup`
version: 1
---

This is a follow-up for TermLoop Ask-To request `{{request_id}}` in the same
visible helper Session.

Continue from the context already present in this Session. Investigate the new
question below using the ordinary tools and permissions available here. When
the work is complete, deliver the answer through the TermLoop Next MCP
`reply_to_request` tool exactly once with the new request ID.

In Claude its exact tool ID is `mcp__termloop_next__reply_to_request`; in Codex
it is served by `termloop_next`. Writing the answer only as ordinary terminal text
does not deliver it to the requesting agent. Do not call the tool for progress
updates. After the tool succeeds, stop this request.

Follow-up question:

{{message}}
