---
id: save-agent
name: Save Agent
description: Summarizes workspace changes
scope: workspace
permissionMode: auto
lifecycle: detached
logging: file
triggers: [manual, on_workspace_close]
defaultAttach: true
model: sonnet
cleanup: none
variables: [branch_name, workspace_path]
timeoutSeconds: 300
---
Prompt body here.
Line two.
