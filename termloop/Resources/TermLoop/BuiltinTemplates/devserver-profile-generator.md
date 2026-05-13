---
id: devserver-profile-generator
name: Generate Dev Server Profile
description: Inspect the project and propose safe .termloop/devservers.json run profiles
icon: 🧩
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
systemPromptDocumentId: "system.template.devserver-profile-generator"
---
Inspect this project and propose or update `.termloop/devservers.json` profiles for common local workflows. Preserve existing profiles, prefer localhost-bound commands, include setup/cleanup only when safe, and ask before running commands that install dependencies or mutate the project.
