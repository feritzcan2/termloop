---
id: edge-case-hunter-agent
name: Edge Case Hunter
description: Exhaustive edge-case analysis of the working tree diff, writes findings as JSON
icon: 🧭
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
systemPromptDocumentId: "system.template.edge-case-hunter"
---
Review the current working-tree diff for unhandled execution paths. Write the findings file for this checkout and print its path.
