---
id: review-agent
name: Review Agent
description: Self-review of uncommitted changes, writes findings to a review note
icon: 🔍
scope: workspace
permissionMode: ask
lifecycle: app-bound
logging: history
triggers: [manual]
defaultAttach: false
model: opus
cleanup: none
variables: [branch_name, workspace_path, timestamp]
timeoutSeconds: 420
systemPromptDocumentId: "system.template.review-agent"
---
Review the current uncommitted working tree, write the review note for this checkout, and print the file path.
