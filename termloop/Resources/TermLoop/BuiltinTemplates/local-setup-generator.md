---
id: local-setup-generator
name: Generate Local Setup
description: Inspect the project and propose .termloop/worktree-setup.json steps for ignored local files and per-worktree preparation
icon: 🛠️
scope: folder
permissionMode: ask
lifecycle: app-bound
logging: history
triggers: [manual]
defaultAttach: false
model: default
cleanup: none
variables: []
timeoutSeconds: 1200
systemPromptDocumentId: "system.template.local-setup-generator"
---
Inspect this project and help configure `.termloop/worktree-setup.json` Local setup for task worktrees. Focus on project-wide preparation that should happen once per worktree: copying ignored local config from the main project checkout, creating local directories/files, or running safe restore/install commands when the user confirms. First summarize what you found, ask concise questions when needed, and do not run or write anything until the user confirms.
