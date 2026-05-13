---
id: devserver-profile-generator
name: Generate Run Profiles
description: Inspect the project, ask clarifying questions, and propose safe .termloop/devservers.json run profiles
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
Inspect this project and help configure `.termloop/devservers.json` run profiles for useful workflows: dev servers, native app reload/build commands, test runners, typecheckers, Storybook, workers, docs servers, or similar project commands. First summarize what scripts/files you found and ask concise clarifying questions when the desired workflows are ambiguous. Preserve existing profiles, prefer commands already in the repo, use localhost URLs only for browser workflows, and ask before running install/build/test/server commands or mutating files.
