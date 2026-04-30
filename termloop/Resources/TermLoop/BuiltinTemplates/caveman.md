---
id: caveman
name: Caveman
description: Ultra-compressed caveman-style responses (~75% fewer tokens, full technical accuracy preserved). Agent-agnostic.
icon: 🪨
scope: workspace
permissionMode: ask
lifecycle: detached
logging: history
triggers: [manual]
defaultAttach: false
model: default
cleanup: none
variables: []
timeoutSeconds: 600
systemPromptDocumentId: "system.template.caveman"
---
Respond to the user's request.
