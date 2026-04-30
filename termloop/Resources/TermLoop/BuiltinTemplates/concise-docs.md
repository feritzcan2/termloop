---
id: concise-docs
name: Concise Docs
description: Generic concise documentation style — strips filler, hedging, marketing tone. Applies to every artifact (CLAUDE.md, instructions.md, ability docs) and chat. Agent-agnostic.
icon: ✂️
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
systemPromptDocumentId: "system.template.concise-docs"
---
Respond to the user's request.
