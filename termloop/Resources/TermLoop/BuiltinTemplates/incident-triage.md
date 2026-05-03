---
id: incident-triage
name: Incident Triage
description: OSS-derived log and incident analysis template for identifying symptoms, likely causes, and next actions
icon: 🚨
scope: workspace
permissionMode: ask
lifecycle: detached
logging: history
triggers: [manual]
defaultAttach: false
model: sonnet
cleanup: none
variables: [workspace_path, timestamp]
timeoutSeconds: 600
systemPromptDocumentId: "system.template.incident-triage"
---
Analyze the provided logs, errors, or incident notes. Return symptoms, likely causes, evidence, and next actions.
