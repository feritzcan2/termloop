# TermLoop

**Keep every coding agent in the loop.**

TermLoop is a terminal-first workspace for running coding agents across Projects and Tasks. Keep Claude Code, Codex, shell terminals, Git worktrees, reviews, and agent conversations together while the daemon owns the running processes and durable state.

[Download](https://github.com/feritzcan2/termloop/releases/latest) · [Website](https://termloop.ai) · [32 video demos](https://termloop.ai/#features) · [Feature guide](docs/features.md) · [Develop from source](docs/development.md)

## Start using TermLoop

1. Download an installer from [Releases](https://github.com/feritzcan2/termloop/releases/latest). Release **v2.0.4** includes a universal macOS build and Linux AppImage / Debian packages. Choose from the assets actually listed for your platform; this release does not include a Windows desktop installer.
2. Open TermLoop and add a **Project** pointing at your repository or local folder.
3. Start a Claude Code or Codex Session using your provider account, or open an ordinary terminal. Agent CLIs need to be installed and authenticated on the computer running them.
4. Create a **Task** with the change you want and its acceptance criteria. Provision a Task worktree when the change needs its own branch and checkout.
5. Run the work, inspect its changes, and ask another agent for a review before deciding what to keep.

TermLoop uses your existing coding-agent subscriptions and provider sign-ins. A Project can contain several live Sessions, and a Task remains useful without a worktree.

## What you can do

| Area | Capabilities |
| --- | --- |
| Run work | Quick Actions, Task briefs, optional managed worktrees, saved preview and test commands, multiple live agents and terminals |
| Coordinate agents | Ask To second opinions, handoffs to existing Sessions, conversation forks with visible parentage, reusable agent profiles, workflow templates and bounded review cycles |
| Review changes | Checkout diffs, full-file and split views, line-level notes, reviewed-file markers, developer checklists, Task favorites, archive and restore |
| Keep work moving | Project Steward, mobile pairing and terminal access, pause-to-read, Keep Awake, notification preferences, light and dark appearance |
| Manage instructions | Context Bank, instruction-file conflict resolution, skill discovery, MCP tools and inspectable TermLoop-authored prompts |

The [feature guide](docs/features.md) covers **32 features** with usage steps and a video for each. It follows current development and the live product tour; an installed release may lag behind the latest demonstrations.

## Watch the collaboration flows

These are real recordings from the populated Launchpad Demo Project, including source files, Tasks, Git changes, and five release tests.

| Demo | What happens | Watch |
| --- | --- | --- |
| **Ask To** | The current agent composes a question, a visible helper receives it, and its answer returns automatically. | [Guided demo](https://termloop.ai/#ask-to) · [MP4](https://termloop.ai/assets/videos/tour/ask-to.mp4) |
| **Handoff** | The current agent sends the request, findings, and next action to an existing running Session. | [Guided demo](https://termloop.ai/#handoff) · [MP4](https://termloop.ai/assets/videos/tour/handoff.mp4) |
| **Session Fork** | A separate Session inherits the conversation and explores another direction with visible parentage. | [Guided demo](https://termloop.ai/#fork) · [MP4](https://termloop.ai/assets/videos/tour/fork.mp4) |

All three were re-recorded in the current interface using OBS at **30 FPS**. Each explained cut is **38.5 seconds**, delivered at **1920 × 1248**, with written steps and English captions. On the website, visible demos loop silently by default; pause, playback speed, and expand controls remain available. Reduced-motion preferences disable automatic playback.

## Projects, Tasks, and Sessions

- **Project:** the durable scope around a repository or folder, its configuration, Tasks, and Sessions.
- **Task:** a unit of work with a brief and developer notes. It can use an optional managed Git worktree. Closing, archiving, and restoring have separate purposes.
- **Session:** a real running agent, shell, or configured command. The daemon owns its PTY and process; client windows display and attach to it.

Ask To creates a tracked helper request. Handoff targets an existing Session. Fork creates a separate conversation; it does not by itself create a Git worktree. See the [coordination guide](docs/features.md#coordinate) for the individual steps.

## Develop from source

Use **Rust 1.90.0**, **Node.js 22+**, and **pnpm 10.14.0**. Native desktop prerequisites depend on the host; macOS also needs Xcode, Python 3, and **Zig 0.15.2** for the Ghostty host.

```sh
git clone --recurse-submodules https://github.com/feritzcan2/termloop.git
cd termloop
git switch develop
pnpm install --frozen-lockfile
pnpm codegen
```

Then follow the [development guide](docs/development.md) to launch an isolated profile, build a package, or run the checks relevant to your change. There is no single repository-wide application build command.

## Architecture

The Rust daemon owns PTYs, process lifecycles, and durable state. Generated contracts serve Electron, the CLI, Companion, and remote clients through separate control and terminal data paths. Git operations, provider integrations, and persistence have explicit module owners.

See the [repository map](docs/development.md#repository-map), [contract schemas](contract/schema), and boundary-specific `AGENTS.md` files for the engineering contracts.

## Contribute

Use `develop` for day-to-day changes and read the nearest `AGENTS.md` before editing. Keep changes focused, preserve unrelated work, and include the relevant validation results in a pull request. Report bugs with your OS, app version, reproduction steps, and the observed behavior in [Issues](https://github.com/feritzcan2/termloop/issues).

## License

TermLoop is dual-licensed under **GPL-3.0-or-later** and a commercial license. See [LICENSE](LICENSE); commercial licensing enquiries can be sent to [feritzcan93@gmail.com](mailto:feritzcan93@gmail.com).
