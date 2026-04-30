---
id: scattered-orchestration-finder-agent
name: Scattered Orchestration Finder
description: Scans the codebase for write-side orchestration drifted across multiple call sites and proposes a single coordinator/lifecycle layer to consolidate it. Language-agnostic.
icon: 🧵
scope: workspace
permissionMode: ask
lifecycle: app-bound
logging: history
triggers: [manual]
defaultAttach: false
model: opus
cleanup: none
variables: [branch_name, workspace_path, timestamp]
timeoutSeconds: 600
systemPromptDocumentId: "system.template.scattered-orchestration-finder"
---
Audit the requested code area for scattered write-side orchestration and report the consolidation shape with anchored findings.
