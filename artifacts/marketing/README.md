# TermLoop feature video guide

The website now includes **32 feature demos**, up from 13. The pre-existing marketing archive contained 16 recording folders, including alternate cuts. There are **19 new feature recordings** from the working Launchpad Demo Project; the original 13 website demos are re-edited with the same three-step caption treatment.

Each published demo has MP4, WebM, a JPEG poster, English WebVTT captions, and three written usage steps. Short source clips have deliberate orientation and result holds. Videos default to manual playback, with optional viewport autoplay and 0.75×–1.5× speed controls. Reduced-motion preferences suppress automatic playback.

## Feature list

### Run

- [Quick Actions](../../landing/assets/videos/tour/quick-actions.mp4): Open the command palette, compose a free prompt, choose the agent, model, permissions, and reasoning, then launch an inspected Session in seconds.
  1. Open Quick Action with Shift Shift. 2. Describe the change and choose the agent settings. 3. Launch a Session with the context attached.
- [Task Worktrees](../../landing/assets/videos/tour/task-worktrees.mp4): Create a Task first, then provision one managed worktree when implementation should happen on its own branch. The Task stays useful even without a checkout.
  1. Create a Task for one focused change. 2. Give the Task its own branch and managed worktree. 3. Keep parallel changes in separate checkouts.
- [Dev Server](../../landing/assets/videos/tour/dev-server.mp4): Save a Project dev-server command and fallback URL, then launch the real process from the Project or its Task worktrees. Its terminal and discovered URLs stay visible.
  1. Save a preview command for the Project. 2. Start the command in the checkout you are using. 3. Follow the process output and discovered preview URL.
- [Task briefs](../../landing/assets/videos/tour/task-briefs.mp4): Give each Task a title, a focused brief, and acceptance criteria. Open its detail view to keep the goal beside Sessions and checkout state.
  1. Open the onboarding Task from the sidebar. 2. Read its brief and concrete acceptance criteria. 3. Keep the goal attached to the work as the Task evolves.
- [Run configurations](../../landing/assets/videos/tour/run-configurations.mp4): Save named commands for preview servers, tests, and other local processes. Configure setup commands and fallback URLs in the same editor.
  1. Open the saved Launchpad preview configuration. 2. Review pnpm dev, the setup command, and fallback URL. 3. Reuse the configuration when starting work in a checkout.

### Coordinate

- [Multi-Agent](../../landing/assets/videos/tour/multi-agent.mp4): Run multiple Claude and Codex Sessions across tasks and worktrees. See who is active, which checkout changed, and which terminal needs attention.
  1. Keep several agent Sessions in one Project. 2. Use the sidebar to see which Session needs attention. 3. Open the right terminal without losing the other Sessions.
- [Ask To](../../landing/assets/videos/tour/ask-to.mp4): Ask one agent to consult another provider. TermLoop creates a visible helper Session, preserves the relationship, and returns the answer to the requester.
  1. Ask the current agent for a second opinion. 2. A visible helper Session receives the question and context. 3. The answer returns to the requesting agent.
- [Handoff](../../landing/assets/videos/tour/handoff.mp4): Send a visible, composed handoff from one running Project Session to another. The target receives the brief in its own real terminal and continues from there.
  1. Choose the existing Session that should receive the brief. 2. Compose the context and the next action. 3. The destination Session receives the handoff in its terminal.
- [Session Fork](../../landing/assets/videos/tour/fork.mp4): Fork a Session from the sidebar, see the parent-child relationship, and continue in a new Ghostty terminal. The branch in thinking is explicit instead of becoming another anonymous tab.
  1. Choose a conversation to explore in a new direction. 2. Fork it from the Session menu. 3. Continue in a separate Session with visible parentage.
- [Agent library](../../landing/assets/videos/tour/agent-library.mp4): Browse reusable agent profiles with a defined purpose. Inspect their provider, working mode, reasoning, and instructions before running one.
  1. Open the Agents library. 2. Inspect the Edge Case Hunter profile and its working mode. 3. Choose a profile whose instructions match the task.
- [Custom agents](../../landing/assets/videos/tour/custom-agents.mp4): Create a reusable agent with its own name, provider settings, and instructions. The Launchpad example checks progress bounds, tests, and keyboard accessibility.
  1. Start from a duplicate of an existing specialist. 2. Give the Launchpad reviewer focused, project-specific instructions. 3. Save the profile so the same brief can be used again.
- [Workflow templates](../../landing/assets/videos/tour/workflow-templates.mp4): Define discussion, implementation, review, and fix steps in a Project template. Choose the agent conversation and instructions for each step before running it in a ready Task worktree.
  1. Open the saved Discuss, build, review template. 2. Inspect the ordered discussion, implementation, and review steps. 3. Reuse the template for the next Task with a ready worktree.
- [Review cycles](../../landing/assets/videos/tour/review-cycles.mp4): Configure review and fix steps together, including a maximum number of review rounds. The template makes the review instructions and return path visible.
  1. Select the accessibility and tests review step. 2. Give the reviewer a specific checklist to assess. 3. Bound the fix-and-review cycle with a maximum round count.

### Review

- [Changes](../../landing/assets/videos/tour/changes.mp4): Changed-file counts appear on Tasks and active Agents. Open the Git changes view, inspect the real diff, and leave line-level notes for the agent to address.
  1. Open the changed files for the checkout. 2. Read the diff and attach a note to a relevant line. 3. Send review notes to the selected active agent.
- [Task Lifecycle](../../landing/assets/videos/tour/task-lifecycle.mp4): Tasks have a deliberately small lifecycle: open or closed. Close finished work, keep its current state visible, and reopen it when the next change arrives.
  1. Close a Task when the work is finished. 2. Keep completed work in the Closed section. 3. Reopen the Task when another change is needed.
- [Session Refresh](../../landing/assets/videos/tour/session-refresh.mp4): Recover a stale agent display from the Session menu while keeping the same durable Session and process model. Lifecycle actions remain explicit.
  1. Open the Session actions menu. 2. Refresh the provider display for the same conversation. 3. Return to the durable Session after the display restarts.
- [Developer notes](../../landing/assets/videos/tour/developer-notes.mp4): Turn the human checks around a change into a short checklist. Mark individual notes complete while keeping their context visible in the sidebar.
  1. Start with the onboarding Task and its three checks. 2. Mark the completed tests and keyboard check as done. 3. See the checklist reach three of three without leaving the Task.
- [Task favorites](../../landing/assets/videos/tour/task-favorites.mp4): Mark a Task as a favorite directly from its row. The explicit favorite state lets you distinguish priority work from the rest of the Project.
  1. Reveal the actions on the onboarding Task. 2. Toggle the Task favorite with its star control. 3. Keep the Task marked while its notes and brief stay intact.
- [Full-file review](../../landing/assets/videos/tour/full-file-review.mp4): Switch from changed lines to the whole file when more context helps. Use unified or split comparison to inspect the same checkout changes.
  1. Open the actual changes in src/releases.mjs. 2. Switch from Change focus to Full file. 3. Choose Split to compare the old and new versions side by side.
- [Review progress](../../landing/assets/videos/tour/review-progress.mp4): Mark changed files as reviewed as you work through the diff. A visible counter shows what remains in the current review.
  1. Start with two changed files in the Launchpad checkout. 2. Mark each file after inspecting its changes. 3. See two of two reviewed before returning to the Task.
- [Task archive](../../landing/assets/videos/tour/task-archive.mp4): Use the archive preview to inspect whether a Task can be parked safely. Eligible Tasks move out of active work and remain available in Archived items.
  1. Choose Archive Task from the Task actions. 2. Read the archive preview before confirming. 3. The Task moves out of the active list and into the archive.
- [Restore archived work](../../landing/assets/videos/tour/task-restore.mp4): Expand Archived items and restore the Task when work resumes. Its brief and developer notes return with it; eligible agent recovery follows the archive restore flow.
  1. Expand Archived items to find the onboarding Task. 2. Restore the Task from its archived row. 3. Its brief and completed developer notes return to active work.

### Operate

- [Steward](../../landing/assets/videos/tour/steward.mp4): Ask the persistent Steward what should ship next, let it coordinate Tasks and Sessions through its constrained tools, and keep the conversation attached to the Project.
  1. Open the Project Steward workspace. 2. Keep project-level instructions beside the work. 3. Coordinate Tasks through a persistent Project assistant.
- [Mobile Companion](../../landing/assets/videos/tour/mobile.mp4): Pair your phone, keep Project visibility and terminal input scoped to your computer, and follow long-running agents over your trusted network.
  1. Open Connect Mobile from the desktop. 2. Use the pairing flow on your trusted network. 3. Continue with project visibility and terminal input on your phone.
- [Mcp & Prompts](../../landing/assets/videos/tour/mcp-prompts.mp4): Browse role-scoped MCP tools and the built-in prompt catalog. TermLoop-generated instructions remain visible and editable; provider-managed opaque layers are labeled honestly.
  1. Open the tools and prompt libraries. 2. Read the instructions and tool descriptions agents receive. 3. Keep TermLoop-authored context inspectable.
- [Pause to read](../../landing/assets/videos/tour/terminal-reading.mp4): Pause the terminal display to inspect output at your own pace. Return to live when you are ready; pausing the view does not stop the process.
  1. Run the five real Launchpad release tests. 2. Use Pause to read to hold the displayed output. 3. Return to live without ending the Session.
- [Keep Awake](../../landing/assets/videos/tour/keep-awake.mp4): Choose whether to keep the computer awake while agents run, continuously, or for a limited time. Keeping the display on is a separate option.
  1. Open Keep Awake from the sidebar. 2. Compare Off, While agents run, and Always. 3. Use a timer or the separate display option when needed.
- [Notification preferences](../../landing/assets/videos/tour/notifications.mp4): Configure desktop, iPhone, and Apple Watch notification preferences. Separate input requests, review-ready alerts, and Steward messages by device.
  1. Open Settings and choose Notifications. 2. Review alerts for agent input, completed turns, and Steward messages. 3. Choose device-specific sound and active-computer behavior.
- [Appearance](../../landing/assets/videos/tour/appearance.mp4): Choose Light, Dark, or System appearance. The resolved theme applies to the app and terminal panes, with System following the computer preference.
  1. Open Appearance in Settings. 2. Compare the Light and Dark workspace themes. 3. Choose System to follow the computer automatically.

### Customize

- [Context Bank](../../landing/assets/videos/tour/context-bank.mp4): Browse project and folder-level instruction files in a searchable tree. Open the real file, inspect its contents, and see its recommended line budget.
  1. Open Context for the Launchpad Project. 2. Read the root instructions, then the source-folder instructions. 3. Use the file path and line budget to keep context focused.
- [Instruction consistency](../../landing/assets/videos/tour/context-sync.mp4): Context Bank flags differing sibling instruction files such as AGENTS.md and CLAUDE.md. Choose the source of truth and review the overwrite count before applying it.
  1. Rescan after sibling instruction files change. 2. Compare the source choices in the conflict resolver. 3. Choose the source file and apply the explicit synchronization.
- [Skill library](../../landing/assets/videos/tour/skill-library.mp4): Search discovered skills and open their actual instructions. The library shows their locations and provider deployment state so you can understand what is installed.
  1. Search the skill library for simplify. 2. Open the skill and read its instructions in the editor. 3. Inspect its discovered locations and provider installation state.

## Demo Project

The template is in [tools/marketing/demo-project](../../tools/marketing/demo-project). It contains a local release dashboard, sample data, source-level agent instructions, and five real release tests. The seed command creates an exclusive new Git checkout, a local tracking base, three Tasks with briefs, developer notes, preview/test commands, a workflow template, a terminal, and reviewable changes. It never overwrites an existing destination.

`node tools/marketing/seed-demo.mjs <runtime.json> <absolute-new-demo-folder>`

Use a launcher-owned feature profile for a repeat capture. The September recording was made through the existing desktop's Launchpad Demo Project because native automation selected that window. Other Projects and existing Sessions were preserved.

## Reproduce the assets

1. Import `tools/marketing/capture.mjs` in the CUA REPL and pass its documented App binding and a temporary capture directory to `createRecorder`. Record actual app operations with `record(name, actions)`. Capture and UI actions are serialized so accessibility IDs cannot change between lookup and click.
2. Install Pillow in a temporary Python environment and have `ffmpeg` / `ffprobe` on PATH. Set `TERMLOOP_MARKETING_CAPTURES` to that directory, then run `python tools/marketing/render.py`. The font can be supplied with `TERMLOOP_MARKETING_FONT` on other hosts. Raw PNGs and render QA sheets stay outside the repository.
3. Run `node tools/marketing/build-guide.mjs`, then `node --test tools/marketing/*.test.mjs tools/marketing/demo-project/test/*.test.mjs` and `node tools/marketing/verify.mjs`.

`catalog.json` owns the labels, copy, source mapping, and three explanation steps. The website HTML is generated statically so the guide and direct video links remain available without JavaScript. Original source videos stay unchanged; captioned deliveries live in `landing/assets/videos/tour/`.

## Capture limits

These videos demonstrate real UI operations, not comprehensive integration tests. Notification delivery, phone pairing, and provider-to-provider routing were not re-tested in this editing session. The original recordings retain their prior UI version. A new Playbook template recording was excluded after the running app reported a schema mismatch; no success claim or failed footage was added to the guide.
