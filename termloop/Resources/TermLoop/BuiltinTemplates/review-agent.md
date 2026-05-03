---
id: review-agent
name: Code Review
description: OSS-derived review of the current diff for correctness, security, performance, and maintainability
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
Review the current uncommitted working-tree diff. Write a prioritized review note and print its path.
