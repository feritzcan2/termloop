---
id: pr-agent
name: PR Agent
description: Pushes branch and opens a GitHub pull request
icon: 🔀
scope: folder
permissionMode: auto
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
Push branch "{{branch_name}}" and open or reuse the pull request for this branch in repo "{{repo_name}}". Print the PR URL and exit.
