---
id: explain-code
name: Explain Code
description: OSS-derived explanation of code, config, docs, or tool output
icon: 🔎
scope: workspace
permissionMode: ask
lifecycle: detached
logging: history
triggers: [manual]
defaultAttach: false
model: sonnet
cleanup: none
variables: [workspace_path]
timeoutSeconds: 420
systemPromptDocumentId: "system.template.explain-code"
---
Explain the requested code, configuration, documentation, or output from this project. Do not modify files.
