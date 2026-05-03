# System Abilities

Reference for the new **system ability** model in TermLoop.

This sits one layer above ordinary project abilities:

- **Project abilities** are the real markdown files under
  `<projectRoot>/.termloop/abilities/<slug>.md`.
- **System abilities** are bundled starter definitions that ship with the app.
  They are not auto-seeded into the repo.
- Each system ability has its **own creator prompt**, so creation is
  specialized per ability family instead of going through one generic creator.

Current built-in starter families live under
`termloop/Sources/TermLoop/Core/Templates/starters/`:

- `working-with-debugging`
- `working-with-jira`

## Why this model exists

The old seeded-worktree-ability direction had two problems:

1. Opening a project could silently create repo files the user did not ask
   for.
2. A single generic creator prompt was too weak for durable repo-specific
   abilities like debugging and Jira, which each need different exploration
   steps and interview questions.

The new model fixes that:

- No automatic `.termloop/abilities/*.md` creation.
- System starters live in the app bundle.
- The user explicitly chooses one of:
  - **Agent**: launch a specialized creator agent for that ability family.
  - **Install**: write the bundled starter markdown into the project as a
    normal ability file.

## The layers

### 1. Bundled starter markdown

These are starter ability files that already contain frontmatter plus a rough
body shape:

- `termloop/Sources/TermLoop/Core/Templates/starters/working-with-debugging/ability.json`
- `termloop/Sources/TermLoop/Core/Templates/starters/working-with-debugging/prompt-customizer.md`
- `termloop/Sources/TermLoop/Core/Templates/starters/working-with-jira/ability.json`
- `termloop/Sources/TermLoop/Core/Templates/starters/working-with-jira/prompt-customizer.md`

They are **templates**, not injected directly into runs. They only become real
project abilities once written into `.termloop/abilities/`.

### 2. Bundled creator prompts

Each system ability has a dedicated creator prompt:

- `starters/working-with-debugging/prompt-customizer.md`
- `starters/working-with-jira/prompt-customizer.md`

These prompts tell the agent:

- which docs to inspect first
- which repo facts to verify
- which interview questions to ask
- what activation mode to prefer
- which output file to write when approved

This is the key difference from the generic `prompt-ability-creator.md`.

### 3. Real project ability files

Once installed or written by an agent, the result is an ordinary ability file:

`<projectRoot>/.termloop/abilities/<slug>.md`

From this point on, the normal ability system takes over:

- `AbilityStore` watches the folder
- `AbilitiesPanel` lists the ability
- `AbilityInjector` includes it in run context based on `activation`

## Core types

### `AbilityStarter`

Defined in:

- `termloop/Sources/TermLoop/Core/Abilities/Ability.swift`

This struct describes a bundled starter family loaded from
`Sources/TermLoop/Core/Templates/starters/<slug>/`. For each starter it
provides:

- stable slug
- display name and summary
- activation metadata
- optional prompt customizer
- optional installable runtime skill content

This is the bridge between the UI and the bundled template files.

### `ProjectInstructionStore`

Defined in:

- `termloop/Sources/TermLoop/AgentInputs/ProjectInstructionStore.swift`

This loads bundled starters, resolves installed starter abilities, and writes
project-owned runtime skill files when a customizer is approved.

## Store behavior

Defined in:

- `termloop/Sources/TermLoop/Core/Abilities/AbilityStore.swift`

Important behavior change:

- `initializeDirectory()` now only creates `.termloop/abilities/`
- it does **not** seed project ability files automatically

Install helper:

- `installStarter(_ starter: AbilityStarter) -> Ability?`

Flow:

1. Load the starter from `Sources/TermLoop/Core/Templates/starters/<slug>/`
2. Parse `ability.json` and any bundled instructions/reminders
3. Create a normal `Ability`
4. Save it into `.termloop/abilities/<slug>/ability.json`
5. Materialize any approved project runtime skill under `.termloop/skills/<slug>/`
6. Reload the watched ability list

So "install starter" is just "materialize the bundled starter as a normal
project ability".

## Sidebar behavior

Defined in:

- `termloop/Sources/TermLoop/UI/Abilities/AbilitiesPanel.swift`

The abilities sidebar now has two separate concepts:

### Project abilities

These are files already present under `.termloop/abilities/`.

They behave exactly like before:

- list rows
- inline detail
- activation picker
- refine
- open in editor
- delete

### System starters

This is a second section in the panel that shows the bundled system ability
families even if the repo has no ability files yet.

For each starter the user can:

- `Agent` → spawn the family-specific creator prompt
- `Install` → write the bundled starter markdown into the project
- `Reset` → overwrite the installed project ability from the bundled starter
- `Open` → open the installed project file, if one exists

This keeps the bundled catalog visible without polluting the repo.

## Prompts tab behavior

Defined in:

- `termloop/Sources/TermLoop/UI/Prompts/PromptsTab.swift`

Prompt templates shown to users are loaded through the agent input stores. Do
not add hidden inline prompts for starter creation or refinement; starter
customizers should remain visible as bundled prompt documents.

## Agent creation flow

When a system starter launches via `Create with agent`, the app uses the
agent-input launch plane and `TerminalAgentRunner` to start an agent with the
starter's customizer prompt.

The spawned workspace receives the starter customizer prompt. That prompt then
interviews the user and eventually writes the project runtime skill on approval.

This means the system ability model does **not** bypass the existing interactive
terminal-agent infrastructure. It only changes:

- which prompt is used
- whether a bundled starter exists
- when the project file is created

## Relationship to the generic creator

The generic ability creator still exists for freeform custom abilities.

Use cases:

- **Generic creator**: "Help me create some new repo-specific ability"
- **Starter customizer**: "Create the `working-with-debugging` skill"

The generic creator is open-ended.
Starter customizers are opinionated and narrow.

## Design rule

Every system ability should have:

1. a bundled starter directory under `Core/Templates/starters/<slug>/`
2. an `ability.json`
3. a visible prompt customizer when the starter needs project-specific content
4. a visible action in the UI to launch/install it

Do not reintroduce auto-seeding. If a repo file should exist, create it only
because the user explicitly installed it or approved an agent-created draft.

## Source map

| Concern | Code |
|---|---|
| starter type | `termloop/Sources/TermLoop/Core/Abilities/Ability.swift` |
| starter loading and project materialization | `termloop/Sources/TermLoop/AgentInputs/ProjectInstructionStore.swift` |
| bundled starter directories | `termloop/Sources/TermLoop/Core/Templates/starters/<slug>/` |
| starter customizer prompts | `termloop/Sources/TermLoop/Core/Templates/starters/<slug>/prompt-customizer.md` |
| project ability store | `termloop/Sources/TermLoop/Core/Abilities/AbilityStore.swift` |
| sidebar catalog UI | `termloop/Sources/TermLoop/UI/Abilities/AbilitiesPanel.swift` |
| prompt/template visibility | `termloop/Sources/TermLoop/AgentInputs/AgentPromptStore.swift` |
| live terminal agent spawning | `termloop/Sources/TermLoop/Agents/TerminalAgentRunner.swift` |

## If you add a new system ability

Checklist:

1. Add `Core/Templates/starters/<slug>/ability.json`
2. Add `prompt-customizer.md` when project-specific content must be generated
3. Add bundled runtime instructions/reminders only when the starter can install directly
4. Verify `ProjectInstructionStore.loadStarters()` loads it
5. Verify `AbilitiesPanel` surfaces it
6. Add a store/UI test for install and customizer behavior

If the ability is not durable or not broad enough to deserve its own family,
keep it as a normal custom ability instead of a system ability.
