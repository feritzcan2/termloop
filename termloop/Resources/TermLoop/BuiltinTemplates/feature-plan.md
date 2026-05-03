---
id: feature-plan
name: Feature Plan
description: OSS-derived product/design planning template for turning an idea into an implementable plan
icon: 🧩
scope: workspace
permissionMode: ask
lifecycle: detached
logging: history
triggers: [manual]
defaultAttach: false
model: opus
cleanup: none
variables: [branch_name, workspace_path, timestamp]
timeoutSeconds: 900
systemPromptDocumentId: "system.template.feature-plan"
---
Turn the requested feature idea into a scoped design and implementation plan. Do not modify code.
