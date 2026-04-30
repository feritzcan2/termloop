# System Abilities

Reference for the new **system ability** model in TermLoop.

This sits one layer above ordinary project abilities:

- **Project abilities** are the real markdown files under
  `<projectRoot>/.termloop/abilities/<slug>.md`.
- **System abilities** are bundled starter definitions that ship with the app.
  They are not auto-seeded into the repo.
- Each system ability has its **own creator prompt**, so creation is
  specialized per ability family instead of going through one generic creator.

Current built-in families:

- `working-with-worktrees`
- `working-with-git`
- `working-with-cmux`
- `working-with-debugging`

## Why this model exists

The old seeded-worktree-ability direction had two problems:

1. Opening a project could silently create repo files the user did not ask
   for.
2. A single generic creator prompt was too weak for durable repo-specific
   abilities like git/worktrees/cmux, which each need different exploration
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

- `termloop/Sources/TermLoop/Core/Templates/ability-working-with-worktrees-default.md`
- `termloop/Sources/TermLoop/Core/Templates/ability-working-with-git-default.md`
- `termloop/Sources/TermLoop/Core/Templates/ability-working-with-cmux-default.md`
- `termloop/Sources/TermLoop/Core/Templates/ability-working-with-debugging-default.md`

They are **templates**, not injected directly into runs. They only become real
project abilities once written into `.termloop/abilities/`.

### 2. Bundled creator prompts

Each system ability has a dedicated creator prompt:

- `prompt-working-with-worktrees-ability-creator.md`
- `prompt-working-with-git-ability-creator.md`
- `prompt-working-with-cmux-ability-creator.md`
- `prompt-working-with-debugging-ability-creator.md`

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

### `SystemAbilityTemplate`

Defined in:

- `termloop/Sources/TermLoop/Core/Abilities/Ability.swift`

This enum is the catalog of bundled system ability families. For each case it
provides:

- stable slug
- display name
- short summary for the UI
- bundled starter markdown filename
- bundled creator prompt string
- creator workspace title

This is the bridge between the UI and the bundled template files.

### `AbilityPrompts`

Defined in:

- `termloop/Sources/TermLoop/Core/Abilities/AbilityPrompts.swift`

This now exposes:

- `creator`
- `refiner`
- `workingWithWorktreesCreator`
- `workingWithGitCreator`
- `workingWithCmuxCreator`
- `workingWithDebuggingCreator`

So the UI can choose a family-specific creator prompt instead of always using
 the generic one.

## Store behavior

Defined in:

- `termloop/Sources/TermLoop/Core/Abilities/AbilityStore.swift`

Important behavior change:

- `initializeDirectory()` now only creates `.termloop/abilities/`
- it does **not** seed `working-with-worktrees.md`

New helper:

- `installSystemTemplate(_ template: SystemAbilityTemplate) -> Ability?`

Flow:

1. Load bundled markdown via `TermLoopTemplateLoader`
2. Parse frontmatter with `AbilityFrontmatter`
3. Create a normal `Ability`
4. Save it into `.termloop/abilities/<slug>.md`
5. Reload the watched ability list

So "install system template" is just "materialize the bundled template as a
normal project ability file".

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

The old assumption was:

- there is always a seeded `working-with-worktrees.md`

That is no longer true.

Now the tab means:

- edit the project-local `working-with-worktrees.md` **if it exists**
- otherwise offer to install the bundled `working-with-worktrees` starter

So the tab is still focused on the worktree ability, but its source of truth is
 now explicit installation, not automatic seeding.

## Agent creation flow

When a system starter launches via `Agent`, the app uses:

- `TerminalAgentRunner.spawnClaude(...)`

The spawned workspace receives the family-specific creator prompt from
`AbilityPrompts`. That prompt then interviews the user and eventually writes the
project file on approval.

This means the system ability model does **not** bypass the existing interactive
terminal-agent infrastructure. It only changes:

- which prompt is used
- whether a bundled starter exists
- when the project file is created

## Relationship to the generic creator

`prompt-ability-creator.md` still exists for freeform custom abilities.

Use cases:

- **Generic creator**: "Help me create some new repo-specific ability"
- **System creator**: "Create the `working-with-git` ability"

The generic creator is open-ended.
The system creators are opinionated and narrow.

## Design rule

Every system ability should have:

1. a bundled starter markdown file
2. a bundled creator prompt
3. a `SystemAbilityTemplate` entry
4. a visible action in the UI to launch/install it

Do not reintroduce auto-seeding. If a repo file should exist, create it only
because the user explicitly installed it or approved an agent-created draft.

## Source map

| Concern | Code |
|---|---|
| system ability catalog | `termloop/Sources/TermLoop/Core/Abilities/Ability.swift` |
| prompt loading surface | `termloop/Sources/TermLoop/Core/Abilities/AbilityPrompts.swift` |
| bundled template loader | `termloop/Sources/TermLoop/Core/TermLoopTemplateLoader.swift` |
| bundled starter markdown | `termloop/Sources/TermLoop/Core/Templates/ability-*-default.md` |
| family-specific creator prompts | `termloop/Sources/TermLoop/Core/Templates/prompt-*-ability-creator.md` |
| project ability store | `termloop/Sources/TermLoop/Core/Abilities/AbilityStore.swift` |
| sidebar catalog UI | `termloop/Sources/TermLoop/UI/Abilities/AbilitiesPanel.swift` |
| worktree-ability editor tab | `termloop/Sources/TermLoop/UI/Prompts/PromptsTab.swift` |
| live terminal agent spawning | `termloop/Sources/TermLoop/Agents/TerminalAgentRunner.swift` |

## If you add a new system ability

Checklist:

1. Add a new bundled starter markdown file in `Core/Templates/`
2. Add a new bundled creator prompt in `Core/Templates/`
3. Extend `SystemAbilityTemplate`
4. Expose the prompt via `AbilityPrompts`
5. Verify `AbilitiesPanel` surfaces it
6. Decide whether any dedicated editor surface like `PromptsTab` is needed
7. Add a store/UI test for install behavior

If the ability is not durable or not broad enough to deserve its own family,
keep it as a normal custom ability instead of a system ability.
