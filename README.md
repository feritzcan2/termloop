<h1 align="center">TermLoop</h1>

<p align="center">
  <strong>Keep every coding agent in the loop.</strong><br>
  Run Claude Code, Codex, and terminals in one workspace, on this computer or any server.<br>
  Give agents context, ask for a second opinion, and keep the work connected.
</p>

<p align="center">
  <a href="https://github.com/feritzcan2/termloop/releases/latest"><img src="https://img.shields.io/github/v/release/feritzcan2/termloop?label=release&color=f0b860" alt="Latest release"></a>
  <a href="https://github.com/feritzcan2/termloop/releases"><img src="https://img.shields.io/github/downloads/feritzcan2/termloop/total?color=4c9" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-555" alt="Platforms: macOS, Windows, Linux">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later%20%7C%20commercial-blue" alt="License: GPL-3.0-or-later or commercial"></a>
  <a href="https://github.com/feritzcan2/termloop/stargazers"><img src="https://img.shields.io/github/stars/feritzcan2/termloop?style=flat" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#download"><strong>Download</strong></a> ·
  <a href="#remote-servers">Remote servers</a> ·
  <a href="https://termloop.ai">Website</a> ·
  <a href="https://termloop.ai/#features">Video tour</a> ·
  <a href="docs/features.md">Feature guide</a> ·
  <a href="docs/development.md">Build from source</a>
</p>

<a href="https://termloop.ai/#ask-to"><img src="artifacts/marketing/readme/ask-to.gif?v=3d96d2f93fcc" alt="Ask To: The answer returns to the requesting agent." width="960"></a>

## Why TermLoop

- **No more copy-paste between agents.** Ask Codex to review what Claude Code wrote, or hand a brief to a Session that is already running. Answers come back to the agent that asked.
- **Remote servers feel local.** Connect a Linux server, cloud VM, or another computer over SSH or Tailscale. Its Projects and live terminals appear in the same sidebar as your local ones.
- **Sessions survive the window.** A background daemon owns every terminal and process. Close the app, reopen it, and reattach to the same live Sessions.
- **Work stays organized.** Projects, Tasks with acceptance criteria, optional Git worktrees, diffs, and review notes live next to the agents doing the work.
- **Bring your own agents.** TermLoop launches the Claude Code and Codex CLIs with your existing subscriptions and sign-ins. It does not proxy model traffic.
- **Follow along from anywhere.** Pair the mobile Companion for Project visibility, terminal input, and iPhone or Apple Watch notifications.

## Download

Get the latest installer from [Releases](https://github.com/feritzcan2/termloop/releases/latest):

| Platform | Package |
| --- | --- |
| macOS (Apple silicon and Intel) | Universal `.dmg` or `.zip` |
| Windows (x64) | `.exe` installer |
| Linux (x86_64) | `.AppImage` or `.deb` |

Each release also ships a headless `termloop-server` archive for [remote servers](#remote-servers), plus a `SHA256SUMS` file for verifying downloads.

**Requirements:** to run agent Sessions, install and sign in to the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) CLI on the computer running TermLoop. Ordinary terminal Sessions need nothing extra.

## Remote servers

Run agents on a Linux server, a cloud VM, or another desktop, and drive them from your laptop as if they were local. Remote Projects appear in the same sidebar, grouped under each computer's name.

- **One window, many computers.** Use this computer plus up to eight remote computers at the same time. If one goes offline, work on the others continues.
- **Agents keep running when you disconnect.** The remote daemon runs as a background service and owns its terminals. Close the laptop, reconnect later, and the same Sessions are still running.
- **Set up from the app.** Open **Settings → Computers → Add a Linux server**, verify the server's SSH fingerprint, and TermLoop installs the server, starts it as a background service, and connects.
- **Kept up to date.** Managed Linux servers check hourly for new stable releases and roll back automatically if an update fails.
- **Private by default.** The server listens only on `127.0.0.1`. You reach it through an SSH tunnel or Tailscale Serve over HTTPS, and every connecting device gets its own credential that the server can revoke.
- **Dev servers open locally.** Opening a remote dev-server URL forwards it to a local port.

| How to connect | Use it when |
| --- | --- |
| **Add a Linux server** (Settings → Computers) | You have SSH access to a Debian or Ubuntu x64 server with systemd. The first setup needs root or passwordless sudo. |
| **On your Tailscale network** | The server shares over Tailscale. TermLoop finds it on your tailnet and connects with one click. |
| **Share this computer** | You want to reach another Mac, Windows, or Linux desktop running TermLoop over SSH or Tailscale. |
| **Headless install** | You prefer the terminal. Extract the `termloop-server-linux-x64` archive from [Releases](https://github.com/feritzcan2/termloop/releases/latest), run `./install.sh install` as the user that will own the server, then enable access with `termloopctl access enable`. |

Claude Code and Codex run on the server, so sign them in there from **Settings → Computers → Agent accounts**. The desktop and server must run matching TermLoop versions; the setup wizard installs the version that matches your desktop.

## Quick start

1. Open TermLoop and add a **Project** pointing at a repository or local folder.
2. Start a Claude Code or Codex Session, or open an ordinary terminal.
3. Create a **Task** with the change you want and its acceptance criteria. Add a Task worktree if the change needs its own branch and checkout.
4. Run the work, inspect the changes, and use **Ask To** to get another agent's review before you decide what to keep.

## Feature tour

Each preview is a short loop from a real Project. Click one to open the 1080p video with playback controls and written steps.

### Tasks: define the work, add a worktree when needed

Keep the goal, acceptance criteria and checklist in one Task. When the change needs its own checkout, create a branch and worktree from that same Task.

<a href="https://termloop.ai/#tasks"><img src="artifacts/marketing/readme/tasks.gif?v=a0f4d09ed5a4" alt="Tasks: define the work, complete checks, then create an optional worktree from the same Task." width="960"></a>

### Changes: turn review notes into the next change

Open the diff, leave a note on a line and send the review to a running agent.

<a href="https://termloop.ai/#changes"><img src="artifacts/marketing/readme/changes.gif?v=034f576eaa16" alt="Changes: Send the notes to the active agent and follow the update." width="960"></a>

<details>
<summary><strong>More demos: Quick Actions, Handoff, Session Fork, Code review</strong></summary>

### Quick Actions: from a prompt to a running agent

Open Quick Actions, write the request and launch an agent with the right context.

<a href="https://termloop.ai/#quick-actions"><img src="artifacts/marketing/readme/quick-actions.gif?v=e7ee5021a7f1" alt="Quick Actions: Launch the Session and follow its work in the terminal." width="960"></a>

### Handoff: move context to the agent already in the work

Send a visible, composed handoff from one running Project Session to another. The target receives the brief in its own real terminal and continues from there.

<a href="https://termloop.ai/#handoff"><img src="artifacts/marketing/readme/handoff.gif?v=5b3652d04424" alt="Handoff: The destination receives the handoff in its own terminal." width="960"></a>

### Session Fork: explore another direction in a real terminal

Fork a Session from the sidebar, see the parent-child relationship, and continue in a new Ghostty terminal. The branch in thinking is explicit instead of becoming another anonymous tab.

<a href="https://termloop.ai/#fork"><img src="artifacts/marketing/readme/fork.gif?v=f6d4a78d45af" alt="Session Fork: Continue in a separate Session with visible parentage." width="960"></a>

### Code review: review changes where they happened

Read the diff, compare versions side by side and keep track of the files you have checked.

<a href="https://termloop.ai/#full-file-review"><img src="artifacts/marketing/readme/full-file-review.gif?v=4a187822c00c" alt="Code review: Mark files reviewed and revisit them from the reviewed list." width="960"></a>

</details>

### Coordinate and automate

| Feature | What it helps with |
| --- | --- |
| [Steward](docs/features.md#steward) | A persistent Project assistant that suggests what should ship next and coordinates Tasks and Sessions. |
| [Workflow templates](docs/features.md#workflow-templates) | Reusable discuss, build, review, and fix steps, run in a ready Task worktree. |
| [Review cycles](docs/features.md#review-cycles) | Pair review and fix steps with a bounded number of rounds. |
| [Agent library](docs/features.md#agent-library) | Reusable agent profiles with their own provider, working mode, and instructions. |
| [Context Bank](docs/features.md#context-bank) | Browse and keep `AGENTS.md` / `CLAUDE.md` instruction files consistent across the Project. |
| [Skill library](docs/features.md#skill-library) | Search installed skills, read their instructions, and see where they are deployed. |
| [Mobile Companion](docs/features.md#mobile-companion) | Pair your phone to follow long-running agents and type into their terminals. |

### Useful every day

| Feature | What it helps with |
| --- | --- |
| [Keep Awake](docs/features.md#keep-awake) | Keep the computer awake while agents work. Add a timer, or keep the display on too. |
| [Pause to Read](docs/features.md#pause-to-read) | Freeze the terminal view to read the output. The Session keeps running in the background. |
| [Task Favorites](docs/features.md#task-favorites) | Star the Tasks that matter, so priority work is easy to spot in the Project. |
| [Developer Notes](docs/features.md#developer-notes) | Keep a small checklist beside each Task and tick off the checks as you finish them. |
| [Notifications](docs/features.md#notification-preferences) | Choose which input requests and review alerts reach your desktop, iPhone and Apple Watch. |
| [Appearance](docs/features.md#appearance) | Choose Light, Dark or System. Your terminal panes follow the workspace theme. |

See the [complete feature guide](docs/features.md) for every feature with written steps.

## Projects, Tasks, and Sessions

- **Project:** the durable scope around a repository or folder, its configuration, Tasks, and Sessions.
- **Task:** a unit of work with a brief and developer notes. It can use an optional managed Git worktree. Closing, archiving, and restoring have separate purposes.
- **Session:** a real running agent, shell, or configured command. The daemon owns its PTY and process; client windows display and attach to it.

Ask To creates a tracked helper request. Handoff targets an existing Session. Fork creates a separate conversation; it does not by itself create a Git worktree. See the [coordination guide](docs/features.md#coordinate) for the individual steps.

## FAQ

<details>
<summary><strong>Which agents does TermLoop support?</strong></summary>

Claude Code and OpenAI Codex are the first-class agent launch paths, alongside ordinary terminal and dev-run Sessions. TermLoop uses your existing provider sign-ins rather than proxying model traffic.
</details>

<details>
<summary><strong>Where do my code and credentials go?</strong></summary>

Your code stays on your filesystem, and agents connect directly to their providers. TermLoop keeps secrets out of durable product state, logs, URLs, and generated evidence.
</details>

<details>
<summary><strong>Does every Task create a worktree?</strong></summary>

No. A Task can have zero or one worktree. Create the Task to track the work, and add a managed checkout only when branch isolation helps.
</details>

<details>
<summary><strong>Can multiple agents write in the same worktree?</strong></summary>

Yes. TermLoop does not impose a write lease. You choose whether agents share a checkout or work in isolated Task worktrees.
</details>

<details>
<summary><strong>Is TermLoop open source?</strong></summary>

Yes. The source and releases are on GitHub under GPL-3.0-or-later, with a commercial license available. See [License](#license).
</details>

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
