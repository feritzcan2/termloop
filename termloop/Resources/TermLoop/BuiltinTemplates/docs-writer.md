---
id: docs-writer
name: Docs Writer
description: OSS-derived documentation pass that turns project context into concise usage docs
icon: 📚
scope: workspace
permissionMode: ask
lifecycle: detached
logging: history
triggers: [manual]
defaultAttach: false
model: sonnet
cleanup: none
variables: [branch_name, workspace_path, timestamp]
timeoutSeconds: 600
systemPromptDocumentId: "system.template.docs-writer"
---
Improve or create the requested documentation from the current project context. Keep changes focused and print the files touched.
