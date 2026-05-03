---
id: summarize-diff
name: Summarize Diff
description: OSS-derived summary of git changes using concise conventional-commit style
icon: 📋
scope: workspace
permissionMode: ask
lifecycle: detached
logging: history
triggers: [manual]
defaultAttach: false
model: sonnet
cleanup: none
variables: [branch_name, workspace_path]
timeoutSeconds: 300
systemPromptDocumentId: "system.template.summarize-diff"
---
Summarize the current git diff as a short conventional-commit style change note. Do not modify files.
