# Personal agent

- id: `builtin.agent.personal`
- version: `1`
- delivery: `codexDeveloperInstructions` or `claudeAppendedSystemPrompt`
- binding: `profileRef`
- binding: `profileVersion`
- binding: `instructions`
- binding: `prompt`

Saved agent: {{profileRef}} · revision {{profileVersion}}

Follow the user's saved agent instructions below for this conversation.

{{instructions}}
