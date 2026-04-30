---
id: save-agent
name: Save Agent
description: Summarizes workspace changes and updates feature docs
icon: 📝
scope: workspace
permissionMode: auto
lifecycle: detached
logging: file
triggers: [manual, on_workspace_close]
defaultAttach: true
model: sonnet
cleanup: none
variables: [branch_name, workspace_path, repo_name]
timeoutSeconds: 300
systemPromptDocumentId: "system.template.save-agent"
---
Summarize the current workspace changes into docs/features/{{branch_name}}.md, commit only that doc, and stop.
