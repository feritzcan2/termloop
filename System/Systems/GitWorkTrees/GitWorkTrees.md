# GitWorkTrees

Project-level reference for how TermLoop models Git worktrees and how that
relates to termloop workspaces. Read this before changing attach/detach behavior,
workspace cwd resolution, or any UI that shows branch/worktree state.

## 1. Core model

In this system, a **workspace is not a Git worktree**.

- A workspace is a termloop UI/runtime object: tabs, panels, terminal surfaces,
  agent state, notifications.
- A worktree is a Git checkout on disk, identified by `(projectId, branch)`.
- The bridge between them is `WorkspaceMetadataStore.Metadata.branch`.
  `nil` means "use the project root checkout". A non-nil branch means
  "this workspace should operate in that branch's worktree".

Important consequences:

- Multiple workspaces can point at the same branch, so multiple workspaces can
  share one worktree.
- Attaching a workspace to the branch already checked out in the main project
  checkout does not create a duplicate worktree. It resolves back to the
  project root.
- Direction is intentionally asymmetric: worktree-backed workspaces may move
  back to the main/project-root checkout, but main/project-root workspaces may
  not be moved into a non-main worktree.
- The supported UI path for `main/root -> worktree` is to create a **new**
  workspace already rooted at the worktree, not to retarget an existing root
  workspace after the fact.
- Features/folders are orthogonal. `featureId` is grouping metadata, not a
  worktree identifier.

## 2. Source of truth

Three layers matter:

1. `WorkspaceMetadataStore`
   Stores the workspace's `projectId`, `featureId`, and optional `branch`.
2. Git worktree registry
   `git worktree list --porcelain` is the source of truth for which worktrees
   are actually registered.
3. Resolved filesystem path
   Worktree paths live at:
   `<project>/.termloop-worktrees/<sanitized-branch>/`

The important distinction is:

- `workspace.branch` says what the workspace is attached to.
- Git says whether that worktree really exists and where.
- A directory under `.termloop-worktrees/` by itself is not enough. If it is not
  in `git worktree list`, treat it as an unregistered/stale folder, not a live
  worktree.

## 3. Attach behavior

`WorktreeCoordinator.attach(...)` is the single coordination point.

High-level flow:

1. Resolve the project from the workspace metadata.
2. Normalize the requested branch and compute its expected path.
3. Ask Git for the current worktree list.
4. If the branch is already the main checkout branch, bind the workspace to the
   project root.
5. If another worktree already has that branch, reuse that existing path.
6. Otherwise create a new Git worktree under `.termloop-worktrees/<branch>`.
7. Reject the transition if the workspace is currently rooted at the main
   checkout and the target is a non-main worktree.
8. Persist the workspace's `branch` metadata.
9. Initialize direct submodules in the new worktree in the background.

Operational rules:

- Do not run `git worktree add` by hand as part of normal product behavior.
  Go through the app/CLI/socket path so metadata and UI stay consistent.
- New worktrees branch from the current HEAD commit, not from uncommitted
  working-tree changes.
- Because of that, creating a worktree from a dirty source checkout does not
  bring local edits with it.
- The system allows `worktree -> main/root` moves but forbids
  `main/root -> non-main worktree` moves.

## 3a. Create-with-worktree behavior

Sidebar `+` menus expose a separate create flow:

- `Add <default agent>`
- `Add <default agent> with Worktree`

The important distinction is:

- `Add <default agent>` creates a normal workspace at the project root checkout.
- `Add <default agent> with Worktree` creates or reuses the Git worktree
  first, then creates the workspace already rooted at that worktree path.

That flow does **not** violate the `main -> worktree` restriction because no
existing root workspace is being moved. The workspace is born in the worktree.

The sheet asks for:

- branch name
- base ref

Then it:

1. Resolves `<project>/.termloop-worktrees/<sanitized-branch>/`
2. Reuses an existing worktree for that branch when present
3. Otherwise runs `git worktree add` / `git worktree add -b`
4. Creates a workspace with `workingDirectory = worktreePath`
5. Persists `workspace.branch`
6. Starts submodule init if needed

If the requested branch is already the main checkout branch, the create flow
rejects it. That branch already resolves to the project root, so a separate
non-main worktree would be misleading.

## 3b. Dirty source checkout behavior

Creating a worktree still branches from the current **HEAD commit**, not from
the working tree. Uncommitted changes stay behind in the source checkout.

The UI now treats a dirty source checkout as a warning/choice, not a hard stop:

- Default: block create-with-worktree and explain that local changes will not
  appear in the new worktree.
- Explicit override: allow the user to continue with
  "Create from HEAD only and leave local changes in the current checkout".

That override means:

- new branch/worktree starts from `HEAD`
- modified files stay in the current checkout
- untracked files stay in the current checkout
- parent-repo submodule pointer changes also count as "dirty" and stay behind

Example:

- Parent repo shows `M termloop`
- `termloop/` itself may be clean
- create-with-worktree still warns, because the **source checkout** is dirty
- continuing creates the worktree from `HEAD`; the pointer change remains only
  in the parent checkout

## 4. Detach behavior

Detaching a workspace clears the workspace's `branch` metadata first. After
that, the workspace is back on the project root checkout.

Pruning is separate:

- `keep`
  Leave the worktree on disk even after detaching this workspace.
- `auto`
  Remove the worktree only if no other workspace still references it and Git
  reports it clean.
- `force`
  Remove it even if it has local changes.

The important model is that **detach changes workspace binding**. Worktree
removal is a follow-up policy decision, not the same thing.

## 5. Workspace-facing surface area

Anything consuming workspace state should treat these fields as the public
summary:

- `branch`
- `worktree_path`

`workspace.list` exposes both so the UI/mobile/bridge layers can reason about
where a workspace is actually rooted.

Socket methods for the worktree control plane:

- `worktree.list`
- `worktree.attach`
- `worktree.detach`
- `worktree.prune`
- `worktree.branches`

That means:

- `workspace.list` answers "what is this workspace currently bound to?"
- `worktree.*` answers "what Git worktrees exist and how should they change?"

## 6. Invariants worth preserving

If you change this subsystem, these invariants should remain true:

- A workspace with `branch=nil` runs in the main project checkout.
- A workspace with `branch=<name>` resolves to either an existing Git worktree
  for that branch or the main checkout when that branch is already the main
  branch.
- A workspace currently rooted at main/project-root may not transition into a
  non-main worktree.
- Two workspaces attached to the same branch share the same filesystem
  checkout.
- Unregistered folders under `.termloop-worktrees/` are not trusted as live state.
  Git registration wins.
- Submodules in a newly created worktree are initialized automatically so the
  checkout is usable without a manual repair step.

## 7. Debugging checklist

When the system looks wrong, check in this order:

1. `workspace.list`
   Confirm the workspace's `branch` and `worktree_path`.
2. `git worktree list --porcelain`
   Confirm Git agrees that the branch/path exists.
3. `.termloop-worktrees/`
   Check whether the folder exists only on disk but is no longer registered.
4. Submodule branch state inside the worktree
   Direct submodules like `termloop` should be on the matching branch, not on
   detached HEAD.

Common failure modes:

- User expects uncommitted changes to appear in a newly created worktree.
  They will not.
- User thinks a clean submodule means the parent repo is also clean. A parent
  repo can still be dirty because its submodule pointer changed.
- A stale folder exists under `.termloop-worktrees/` and gets mistaken for a live
  worktree.
- A direct submodule inside a worktree ends up detached and someone commits on
  top of that detached HEAD.

## 8. Relevant implementation files

- `termloop/Sources/TermLoop/Core/WorkspaceMetadataStore.swift`
- `termloop/Sources/TermLoop/Worktrees/WorktreeCoordinator.swift`
- `termloop/Sources/TermLoop/Worktrees/GitWorktreeService.swift`
- `termloop/Sources/TermLoop/Worktrees/WorktreeResolver.swift`
- `termloop/Sources/TermLoop/Worktrees/SubmoduleInitService.swift`
- `termloop/Sources/TermLoop/AgentTerminals/NewWorkspaceSheet.swift`
- `termloop/Sources/TermLoop/Hooks/TerminalController+TermLoop.swift`
- `termloop/Sources/TermLoop/UI/TermLoopSidebarInjection.swift`
- `docs/superpowers/specs/2026-04-14-cmux-worktree-design.md`
- `CLAUDE.md`
