---
id: implement-task
name: Implement Task
description: OSS-derived coding-agent workflow for implementing a scoped task with verification
icon: 🛠️
scope: workspace
permissionMode: ask
lifecycle: app-bound
logging: history
triggers: [manual]
defaultAttach: false
model: opus
cleanup: none
variables: [branch_name, workspace_path]
timeoutSeconds: 1200
systemPromptDocumentId: "system.template.implement-task"
---
Implement the requested scoped task in this project. Keep the change focused, verify it, and summarize what changed.
