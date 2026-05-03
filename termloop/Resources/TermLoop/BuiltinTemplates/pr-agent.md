---
id: pr-agent
name: Prepare Pull Request
description: OSS-derived change summary plus TermLoop GitHub adapter for opening or reusing a pull request
icon: 🔀
scope: folder
permissionMode: ask
lifecycle: detached
logging: file
triggers: [manual, on_workspace_close]
defaultAttach: false
model: sonnet
cleanup: none
variables: [branch_name, repo_name]
timeoutSeconds: 240
systemPromptDocumentId: "system.template.pr-agent"
---
Summarize branch "{{branch_name}}", push it, open or reuse its pull request in "{{repo_name}}", print the PR URL, and stop.
