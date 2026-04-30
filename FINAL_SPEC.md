## Goal
Make gstack feel native inside TermLoop without porting gstack itself. TermLoop should become the cockpit for running gstack workflows across Claude Code and Codex CLI workspaces: users connect an existing gstack install, launch the right gstack flow from Quick Action, see each run as a normal TermLoop workspace/worktree, and keep plans/browsers/review work in the surfaces they already use. This matters because gstack brings a strong sprint methodology, while TermLoop already owns the live workspace, browser, worktree, and parallel-agent experience.

## User-facing behavior
- In **Integrations**, TermLoop shows a new detected item for **gstack** when it finds a supported install for the selected host environment:
  - Claude Code via `~/.claude/skills/gstack`
  - Codex CLI via `~/.codex/skills/gstack*`
- The gstack row shows:
  - which host(s) are ready (`Claude Code`, `Codex CLI`)
  - whether short names or prefixed names are installed (`/qa` vs `/gstack-qa`)
  - a simple readiness result (`Ready`, `Missing`, `Needs attention`)
- If gstack is missing, the detail pane shows a **copyable install command** and a short explanation instead of pretending TermLoop can run it.
- **Quick Action** gains a compact built-in template group named **gstack** with exactly these templates in v1:
  - `gstack /office-hours`
  - `gstack /autoplan`
  - `gstack /review`
  - `gstack /qa`
  - `gstack /ship`
- Launching one of those templates creates a normal TermLoop run using the currently selected terminal agent (`Claude Code` or `Codex CLI`) and the current workspace/worktree context.
- The first user-visible prompt body is generated for the user, not authored manually each time. Example shape: “Load gstack. Run `/review` on this branch. Work only in this workspace.” TermLoop substitutes the detected command name (`/review` or `/gstack-review`) automatically.
- Runs launched from a worktree-backed workspace stay in that worktree. The workspace title defaults to the gstack action label so parallel runs are easy to scan in the sidebar.
- `gstack /qa` asks for one required variable: a URL. Before launching the run, TermLoop opens or reuses a browser split for that workspace with the same URL so the QA run and live browser sit together.
- `gstack /office-hours` and `gstack /autoplan` ask for an optional output filename. If the run is launched from a project, TermLoop tells the agent to save the resulting markdown into the project’s existing plan folders (`docs/superpowers/specs` or `docs/superpowers/plans`), so the result shows up in the current **Plan** picker flow.
- If the user launches a gstack template while gstack is not installed for the chosen agent, TermLoop blocks the launch and opens the gstack integration detail with the install guidance.
- Nothing changes for users who do not use gstack.

## Out of scope
- Porting gstack’s slash-command implementation into TermLoop.
- Rebuilding gstack’s browser stack inside TermLoop or replacing gstack’s `/browse` implementation.
- Supporting every gstack skill in v1; only the five templates above ship.
- One-click installation, auto-upgrade, or team-mode repo mutation from TermLoop.
- A new top-level “gstack” tab or a separate orchestration system outside Quick Action / Integrations / Plan.
- Special handling for agents TermLoop does not currently launch as terminal agents.

## Technical approach
This should be a thin product layer over existing TermLoop primitives, not a new workflow engine. Reuse the current **Integrations** tab for readiness/discovery, the current **Quick Action template** path for launch, the current **browser split** behavior for QA context, and the current **Plan** folder flow for saved plan artifacts. gstack remains the methodology source of truth; TermLoop remains the runtime shell around it.

For discovery, add a lightweight gstack detector that checks known install roots for the hosts TermLoop already supports (`claude`, `codex`). In this slice, gstack should be represented as one integration item with per-host readiness details rather than a brand-new integration category. The detail pane should explain what was found, what command prefix style is active, and what install command the user should run if it is missing.

For launch, add built-in Quick Action templates rather than inventing a new launcher. Each template is just a structured first-turn prompt with small variable slots (`url`, optional output filename) plus existing workspace/project/worktree context. This keeps the user in one familiar flow: pick template, confirm preview, launch. It also means all the normal TermLoop behaviors still apply: default terminal agent resolution, worktree routing, sidebar visibility, notifications, and restore behavior.

For saved outputs, do not add a gstack-specific document browser. Planning templates should simply instruct the run to write the resulting markdown into the project’s existing plan folders so TermLoop’s current **PlanPicker** can surface it. That keeps gstack artifacts visible without adding a second document system.

For QA, keep the integration shallow but tangible: when the user launches the QA template, TermLoop prepares the browser surface next to the run. That is the first “beautiful together” moment in v1: gstack provides the testing method, TermLoop provides the persistent browser/workspace cockpit.

## Open questions
- Should the Integrations row expose a manual **“I installed it, re-check”** action only, or also offer a shell-backed install action later?
- For planning templates, should TermLoop always force saves into `docs/superpowers/*`, or only suggest those paths and let the agent pick a different markdown location?
- When both Claude Code and Codex CLI are installed, should the gstack template default to the workspace’s resolved terminal agent, or prefer Claude Code because gstack originated there?
