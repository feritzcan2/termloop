# Developing TermLoop

[Overview](../README.md) · [Feature guide](features.md)

This guide describes the current `develop` checkout. `main` is the release integration branch; published binaries and their available platforms are listed in [Releases](https://github.com/feritzcan2/termloop/releases). Read the nearest `AGENTS.md` before changing a code boundary.

## Prerequisites

| Dependency | Required version or purpose |
| --- | --- |
| Git | Clone the repository and its pinned submodules |
| Rust | **1.90.0**, with `clippy` and `rustfmt`, as pinned in `rust-toolchain.toml` |
| Node.js | **22 or newer**, as declared in `package.json` |
| pnpm | **10.14.0**, as pinned by `packageManager` |
| macOS native tools | Xcode with a selected SDK, Python 3 for node-gyp, and **Zig 0.15.2** for the native Ghostty host |
| Linux development session | A working `systemd --user` manager for the persistent development launcher, plus host build tools and Electron runtime dependencies |
| Coding-agent CLIs | Install and authenticate the providers you want to exercise in real agent Sessions |

The native Ghostty build script verifies its exact Zig version and pinned submodule revision. Cross-platform targets have different native build requirements; use the corresponding jobs in [CI](../.github/workflows/ci.yml) as the executable reference for host verification.

## Bootstrap

```sh
git clone --recurse-submodules https://github.com/feritzcan2/termloop.git
cd termloop
git switch develop
pnpm install --frozen-lockfile
pnpm codegen
```

If you cloned without submodules, run `git submodule update --init --recursive` before the native desktop build. Generated protocol files come from `contract/schema`; change the schema and run code generation rather than editing generated files directly.

## Run an isolated development profile

On macOS or Linux, use the repository launcher from the checkout root:

```sh
tools/dev/termloop-dev start --checkout "$PWD" --tag docs-demo
tools/dev/termloop-dev status --checkout "$PWD" --tag docs-demo
```

Use a descriptive feature tag of your own. Each tag has isolated application state, runtime discovery, desktop state, and logs. The supervisor manages the daemon and desktop together. On macOS, confirm a later `status` reports `Supervisor: ready` and `Build: current`.

After source changes, rebuild and restart that same profile:

```sh
tools/dev/termloop-dev restart --checkout "$PWD" --tag docs-demo
```

Stop it when finished:

```sh
tools/dev/termloop-dev stop --checkout "$PWD" --tag docs-demo
```

Do not launch the daemon or Electron separately as a substitute for this workflow. The `--main` profile is reserved for human operation. The persistent launcher supports macOS and Linux; it does not offer a Windows launch path. Full launcher ownership and cleanup rules are in [tools/dev/AGENTS.md](../tools/dev/AGENTS.md).

## Build and validate a change

There is no single build command for the whole application. Examples from the package scripts:

| Scope | Build | Validate |
| --- | --- | --- |
| Generated TypeScript contract | `pnpm --filter @termloop/contract build` | `pnpm contract:drift` |
| Desktop JavaScript bundle | `pnpm --filter @termloop/desktop build` | `pnpm --filter @termloop/desktop check` and `pnpm --filter @termloop/desktop test` |
| CLI | `pnpm --filter @termloop/cli build` | `pnpm --filter @termloop/cli check` and `pnpm --filter @termloop/cli test` |
| Rust daemon | `cargo build -p termloop-server` | Use the owning Rust crate's tests and boundary instructions |

The desktop bundle alone is not a packaged native app. Use the launcher for a development instance; packaging also needs its native components. Desktop tests include an Electron smoke run and therefore need a suitable graphical environment.

For broad or cross-boundary verification:

```sh
pnpm check
pnpm test
```

`pnpm check` covers generated-contract drift, Rust formatting and Clippy, package checks, architecture boundaries, ownership checks, version consistency, and operational scripts. `pnpm test` runs Rust and package tests plus the repository's architecture and operational fixtures. For a local module change, run its focused checks and tests first. A successful local run does not substitute for required native platform release gates.

## Command-line client

Build the CLI, then query the daemon using its private runtime discovery file:

```sh
pnpm --filter @termloop/cli build
node clients/cli/dist/index.js project-list --runtime /absolute/path/to/runtime.json --json
node clients/cli/dist/index.js session-list --runtime /absolute/path/to/runtime.json --json
```

Use the runtime belonging to your intended profile. Keep its credentials private; do not paste tokens into command arguments or publish the runtime file. The CLI also exposes Task, Session, archive, and access operations through the generated contract. See [the CLI source](../clients/cli/src/index.ts) for supported commands and flags.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/server` | Daemon entry point and service composition |
| `apps/companion` | Companion process |
| `clients/desktop` | Electron desktop, React UI, and native terminal host |
| `clients/cli` | Scriptable client over the generated protocol |
| `clients/mobile` | Mobile client |
| `contract/schema` | Authoritative protocol and MCP schemas |
| `contract/generated` | Generated Rust and TypeScript bindings |
| `modules/domain`, `modules/core` | Domain concepts and application orchestration |
| `modules/store`, `modules/platform`, `modules/terminal` | Durable storage, OS primitives, and terminal ownership |
| `modules/gitio`, `modules/providers` | Git operations and external provider adapters |
| `modules/agents`, `modules/invocation` | Agent integration and invocation ownership |
| `resources/prompts` | Inspectable TermLoop-authored prompts |
| `tools/dev`, `tools/ci`, `tools/release` | Development supervision, validation, and release tooling |
| `tools/marketing`, `landing` | Demo preparation, video guide tooling, and the public website |
| `tests`, `spikes` | Acceptance scenarios and focused investigations |

## Feature videos

The [public feature guide](features.md) links to the current hosted videos so it works from both repository branches. The [marketing index on develop](https://github.com/feritzcan2/termloop/blob/develop/artifacts/marketing/README.md) documents capture and rendering; `tools/marketing/catalog.json` owns the feature labels, descriptions, and steps.

The Launchpad demo template contains fictional releases, source files, and five release tests. Video playback checks and demo tests validate the tour; they are not a substitute for application integration or release tests.
