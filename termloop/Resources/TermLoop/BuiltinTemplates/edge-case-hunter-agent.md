---
id: edge-case-hunter-agent
name: Edge Case Review
description: OSS-derived review pass focused on boundary conditions, failure modes, and missing guards
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
Review the current working-tree diff for boundary-condition bugs and missing failure handling. Write the findings file and print its path.
