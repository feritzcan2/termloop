# TermLoop feature guide

[Overview](../README.md) · [Development](development.md) · [Interactive video tour](https://termloop.ai/#features)

Explore **32 features** with real desktop demonstrations and three usage steps each. This guide follows the current development UI and the live tour; released builds may differ. The videos use a populated Launchpad Demo Project with Tasks, source files, Git changes, and release tests.

The tour contains **22 current OBS recordings** and **10 re-edited original clips**. Ask To, Handoff, and Session Fork were refreshed at 30 FPS, with 38.5-second explained cuts. Current outputs are 1920 × 1248; older clips retain their original 15–20 FPS motion. On the website, visible videos loop silently by default, with pause, speed, expand, and caption controls. Reduced-motion preferences suppress autoplay.

## Choose the right action

| Intent | Action |
| --- | --- |
| Ask an agent to obtain a second opinion | **Ask To** creates a tracked helper; its final answer returns to the requesting agent |
| Send context to someone already running | **Handoff** delivers a composed message to the selected existing Session |
| Explore another direction from this conversation | **Session Fork** creates a separate Session with inherited context and visible parentage |
| Isolate a code change on its own branch | Create a **Task worktree**; a conversation fork does not create one automatically |
| Remove finished work from the active list while retaining recoverable context | Inspect the **archive** action; closing a Task and archiving it are separate operations |

## Run

### Quick Actions

Open the command palette, compose a free prompt, choose the agent, model, permissions, and reasoning, then launch an inspected Session in seconds.

1. Open Quick Action with Shift Shift.
2. Describe the change and choose the agent settings.
3. Launch a Session with the context attached.

[Watch the guided demo](https://termloop.ai/#quick-actions) · [MP4 video](https://termloop.ai/assets/videos/tour/quick-actions.mp4)

### Task Worktrees

Create a Task first, then provision one managed worktree when implementation should happen on its own branch. The Task stays useful even without a checkout.

1. Create a Task for one focused change.
2. Give the Task its own branch and managed worktree.
3. Keep parallel changes in separate checkouts.

[Watch the guided demo](https://termloop.ai/#task-worktrees) · [MP4 video](https://termloop.ai/assets/videos/tour/task-worktrees.mp4)

### Dev Server

Save a Project dev-server command and fallback URL, then launch the real process from the Project or its Task worktrees. Its terminal and discovered URLs stay visible.

1. Save a preview command for the Project.
2. Start the command in the checkout you are using.
3. Follow the process output and discovered preview URL.

[Watch the guided demo](https://termloop.ai/#dev-server) · [MP4 video](https://termloop.ai/assets/videos/tour/dev-server.mp4)

### Task briefs

Give each Task a title, a focused brief, and acceptance criteria. Open its detail view to keep the goal beside Sessions and checkout state.

1. Open the onboarding Task from the sidebar.
2. Read its brief and concrete acceptance criteria.
3. Keep the goal attached to the work as the Task evolves.

[Watch the guided demo](https://termloop.ai/#task-briefs) · [MP4 video](https://termloop.ai/assets/videos/tour/task-briefs.mp4)

### Run configurations

Save named commands for preview servers, tests, and other local processes. Configure setup commands and fallback URLs in the same editor.

1. Open the saved Launchpad preview configuration.
2. Review pnpm dev, the setup command, and fallback URL.
3. Reuse the configuration when starting work in a checkout.

[Watch the guided demo](https://termloop.ai/#run-configurations) · [MP4 video](https://termloop.ai/assets/videos/tour/run-configurations.mp4)

## Coordinate

### Multi-Agent

Run multiple Claude and Codex Sessions across tasks and worktrees. See who is active, which checkout changed, and which terminal needs attention.

1. Keep several agent Sessions in one Project.
2. Use the sidebar to see which Session needs attention.
3. Open the right terminal without losing the other Sessions.

[Watch the guided demo](https://termloop.ai/#multi-agent) · [MP4 video](https://termloop.ai/assets/videos/tour/multi-agent.mp4)

### Ask To

Ask one agent to consult another agent. TermLoop creates a visible helper Session, preserves the relationship, and returns the answer to the requester.

1. Open Agents > Ask to and choose a provider for the second opinion.
2. A visible helper Session receives the question and context.
3. The answer returns to the requesting agent.

[Watch the guided demo](https://termloop.ai/#ask-to) · [MP4 video](https://termloop.ai/assets/videos/tour/ask-to.mp4)

### Handoff

Send a visible, composed handoff from one running Project Session to another. The target receives the brief in its own real terminal and continues from there.

1. Open Agents > Handover to and choose an existing Session.
2. The current agent composes the request, findings, and next action.
3. The destination receives the handoff in its own terminal.

[Watch the guided demo](https://termloop.ai/#handoff) · [MP4 video](https://termloop.ai/assets/videos/tour/handoff.mp4)

### Session Fork

Fork a Session from the sidebar, see the parent-child relationship, and continue in a new Ghostty terminal. The branch in thinking is explicit instead of becoming another anonymous tab.

1. Choose a conversation to explore in a new direction.
2. Fork it from the Session menu.
3. Continue in a separate Session with visible parentage.

[Watch the guided demo](https://termloop.ai/#fork) · [MP4 video](https://termloop.ai/assets/videos/tour/fork.mp4)

### Agent library

Browse reusable agent profiles with a defined purpose. Inspect their provider, working mode, reasoning, and instructions before running one.

1. Open the Agents library.
2. Inspect the Edge Case Hunter profile and its working mode.
3. Choose a profile whose instructions match the task.

[Watch the guided demo](https://termloop.ai/#agent-library) · [MP4 video](https://termloop.ai/assets/videos/tour/agent-library.mp4)

### Custom agents

Create a reusable agent with its own name, provider settings, and instructions. The Launchpad example checks progress bounds, tests, and keyboard accessibility.

1. Open your saved Launchpad reviewer profile.
2. Give the Launchpad reviewer focused, project-specific instructions.
3. Save the profile so the same brief can be used again.

[Watch the guided demo](https://termloop.ai/#custom-agents) · [MP4 video](https://termloop.ai/assets/videos/tour/custom-agents.mp4)

### Workflow templates

Define discussion, implementation, review, and fix steps in a Project template. Choose the agent conversation and instructions for each step before running it in a ready Task worktree.

1. Open the saved Discuss, build, review template.
2. Inspect the ordered discussion, implementation, and review steps.
3. Reuse the template for the next Task with a ready worktree.

[Watch the guided demo](https://termloop.ai/#workflow-templates) · [MP4 video](https://termloop.ai/assets/videos/tour/workflow-templates.mp4)

### Review cycles

Configure review and fix steps together, including a maximum number of review rounds. The template makes the review instructions and return path visible.

1. Select the accessibility and tests review step.
2. Give the reviewer a specific checklist to assess.
3. Bound the fix-and-review cycle with a maximum round count.

[Watch the guided demo](https://termloop.ai/#review-cycles) · [MP4 video](https://termloop.ai/assets/videos/tour/review-cycles.mp4)

## Review

### Changes

Changed-file counts appear on Tasks and active Agents. Open the Git changes view, inspect the real diff, and leave line-level notes for the agent to address.

1. Open the changed files for the checkout.
2. Read the diff and attach a note to a relevant line.
3. Send review notes to the selected active agent.

[Watch the guided demo](https://termloop.ai/#changes) · [MP4 video](https://termloop.ai/assets/videos/tour/changes.mp4)

### Task Lifecycle

Tasks have a deliberately small lifecycle: open or closed. Close finished work, keep its current state visible, and reopen it when the next change arrives.

1. Close a Task when the work is finished.
2. Keep completed work in the Closed section.
3. Reopen the Task when another change is needed.

[Watch the guided demo](https://termloop.ai/#task-lifecycle) · [MP4 video](https://termloop.ai/assets/videos/tour/task-lifecycle.mp4)

### Session Refresh

Recover a stale agent display from the Session menu while keeping the same durable Session and process model. Lifecycle actions remain explicit.

1. Open the Session actions menu.
2. Refresh the provider display for the same conversation.
3. Return to the durable Session after the display restarts.

[Watch the guided demo](https://termloop.ai/#session-refresh) · [MP4 video](https://termloop.ai/assets/videos/tour/session-refresh.mp4)

### Developer notes

Turn the human checks around a change into a short checklist. Mark individual notes complete while keeping their context visible in the sidebar.

1. Start with the onboarding Task and its three checks.
2. Mark the completed tests and keyboard check as done.
3. See the checklist reach three of three without leaving the Task.

[Watch the guided demo](https://termloop.ai/#developer-notes) · [MP4 video](https://termloop.ai/assets/videos/tour/developer-notes.mp4)

### Task favorites

Mark a Task as a favorite directly from its row. The explicit favorite state lets you distinguish priority work from the rest of the Project.

1. Reveal the actions on the onboarding Task.
2. Toggle the Task favorite with its star control.
3. Keep the Task marked while its notes and brief stay intact.

[Watch the guided demo](https://termloop.ai/#task-favorites) · [MP4 video](https://termloop.ai/assets/videos/tour/task-favorites.mp4)

### Full-file review

Switch from changed lines to the whole file when more context helps. Use unified or split comparison to inspect the same checkout changes.

1. Open the actual changes in src/releases.mjs.
2. Switch from Change focus to Full file.
3. Choose Split to compare the old and new versions side by side.

[Watch the guided demo](https://termloop.ai/#full-file-review) · [MP4 video](https://termloop.ai/assets/videos/tour/full-file-review.mp4)

### Review progress

Mark changed files as reviewed as you work through the diff. A visible counter shows what remains in the current review.

1. Start with two changed files in the Launchpad checkout.
2. Mark each file after inspecting its changes.
3. See two of two reviewed before returning to the Task.

[Watch the guided demo](https://termloop.ai/#review-progress) · [MP4 video](https://termloop.ai/assets/videos/tour/review-progress.mp4)

### Task archive

Use the archive preview to inspect whether a Task can be parked safely. Eligible Tasks move out of active work and remain available in Archived items.

1. Choose Archive Task from the Task actions.
2. Read the archive preview before confirming.
3. The Task moves out of the active list and into the archive.

[Watch the guided demo](https://termloop.ai/#task-archive) · [MP4 video](https://termloop.ai/assets/videos/tour/task-archive.mp4)

### Restore archived work

Expand Archived items and restore the Task when work resumes. Its brief and developer notes return with it; eligible agent recovery follows the archive restore flow.

1. Expand Archived items to find the onboarding Task.
2. Restore the Task from its archived row.
3. Its brief and completed developer notes return to active work.

[Watch the guided demo](https://termloop.ai/#task-restore) · [MP4 video](https://termloop.ai/assets/videos/tour/task-restore.mp4)

## Operate

### Steward

Ask the persistent Steward what should ship next, let it coordinate Tasks and Sessions through its constrained tools, and keep the conversation attached to the Project.

1. Open the Project Steward workspace.
2. Keep project-level instructions beside the work.
3. Coordinate Tasks through a persistent Project assistant.

[Watch the guided demo](https://termloop.ai/#steward) · [MP4 video](https://termloop.ai/assets/videos/tour/steward.mp4)

### Mobile Companion

Pair your phone, keep Project visibility and terminal input scoped to your computer, and follow long-running agents over your trusted network.

1. Open Connect Mobile from the desktop.
2. Use the pairing flow on your trusted network.
3. Continue with project visibility and terminal input on your phone.

[Watch the guided demo](https://termloop.ai/#mobile) · [MP4 video](https://termloop.ai/assets/videos/tour/mobile.mp4)

### Mcp & Prompts

Browse role-scoped MCP tools and the built-in prompt catalog. TermLoop-generated instructions remain visible and editable; provider-managed opaque layers are labeled honestly.

1. Open the tools and prompt libraries.
2. Read the instructions and tool descriptions agents receive.
3. Keep TermLoop-authored context inspectable.

[Watch the guided demo](https://termloop.ai/#mcp-prompts) · [MP4 video](https://termloop.ai/assets/videos/tour/mcp-prompts.mp4)

### Pause to read

Pause the terminal display to inspect output at your own pace. Return to live when you are ready; pausing the view does not stop the process.

1. Run the five real Launchpad release tests.
2. Use Pause to read to hold the displayed output.
3. Return to live without ending the Session.

[Watch the guided demo](https://termloop.ai/#terminal-reading) · [MP4 video](https://termloop.ai/assets/videos/tour/terminal-reading.mp4)

### Keep Awake

Choose whether to keep the computer awake while agents run, continuously, or for a limited time. Keeping the display on is a separate option.

1. Open Keep Awake from the sidebar.
2. Compare Off, While agents run, and Always.
3. Use a timer or the separate display option when needed.

[Watch the guided demo](https://termloop.ai/#keep-awake) · [MP4 video](https://termloop.ai/assets/videos/tour/keep-awake.mp4)

### Notification preferences

Configure desktop, iPhone, and Apple Watch notification preferences. Separate input requests, review-ready alerts, and Steward messages by device.

1. Open Settings and choose Notifications.
2. Review alerts for agent input, completed turns, and Steward messages.
3. Choose device-specific sound and active-computer behavior.

[Watch the guided demo](https://termloop.ai/#notifications) · [MP4 video](https://termloop.ai/assets/videos/tour/notifications.mp4)

### Appearance

Choose Light, Dark, or System appearance. The resolved theme applies to the app and terminal panes, with System following the computer preference.

1. Open Appearance in Settings.
2. Compare the Light and Dark workspace themes.
3. Choose System to follow the computer automatically.

[Watch the guided demo](https://termloop.ai/#appearance) · [MP4 video](https://termloop.ai/assets/videos/tour/appearance.mp4)

## Customize

### Context Bank

Browse project and folder-level instruction files in a searchable tree. Open the real file, inspect its contents, and see its recommended line budget.

1. Open Context for the Launchpad Project.
2. Read the root instructions, then the source-folder instructions.
3. Use the file path and line budget to keep context focused.

[Watch the guided demo](https://termloop.ai/#context-bank) · [MP4 video](https://termloop.ai/assets/videos/tour/context-bank.mp4)

### Instruction consistency

Context Bank flags differing sibling instruction files such as AGENTS.md and CLAUDE.md. Choose the source of truth and review the overwrite count before applying it.

1. Rescan after sibling instruction files change.
2. Compare the source choices in the conflict resolver.
3. Choose the source file and apply the explicit synchronization.

[Watch the guided demo](https://termloop.ai/#context-sync) · [MP4 video](https://termloop.ai/assets/videos/tour/context-sync.mp4)

### Skill library

Search discovered skills and open their actual instructions. The library shows their locations and provider deployment state so you can understand what is installed.

1. Search the skill library for simplify.
2. Open the skill and read its instructions in the editor.
3. Inspect its discovered locations and provider installation state.

[Watch the guided demo](https://termloop.ai/#skill-library) · [MP4 video](https://termloop.ai/assets/videos/tour/skill-library.mp4)

## What the demonstrations verify

The refreshed collaboration recordings exercised a real Codex helper reply, a handoff to an existing Codex Session, and a fork continued with a new prompt. Cross-provider routing, notification delivery, and phone pairing were not re-tested during this capture. Workflow videos show configuration and review steps; they do not establish that every provider or workflow combination has passed integration testing.

For capture settings, the demo template, and reproduction commands, see the [marketing index on develop](https://github.com/feritzcan2/termloop/blob/develop/artifacts/marketing/README.md). Feature wording and step definitions come from `tools/marketing/catalog.json` on that branch.
