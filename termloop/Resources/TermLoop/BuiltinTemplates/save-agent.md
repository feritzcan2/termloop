---
id: save-agent
name: Change Summary
description: OSS-derived summary of the current workspace changes, written as a project note
icon: 📝
scope: workspace
permissionMode: ask
lifecycle: detached
logging: file
triggers: [manual]
defaultAttach: false
model: sonnet
cleanup: none
variables: [branch_name, workspace_path, timestamp]
timeoutSeconds: 300
systemPromptDocumentId: "system.template.save-agent"
---
Summarize the current workspace changes into a short project note. Do not modify code or commit.
