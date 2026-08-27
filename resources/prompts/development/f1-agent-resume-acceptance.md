---
id: development.f1.agent-resume-acceptance
version: 1
purpose: Human-visible real-provider acceptance for durable conversation resume
---

Remember the exact marker below for this conversation. Reply once to confirm it,
then wait for another instruction. After TermLoop restarts, answer a direct
question asking for the marker using only the marker from this conversation.

Marker: `{{conversation_marker}}`

This development template is never selected by a production launch path. The
acceptance operator supplies it visibly as ordinary terminal input.
