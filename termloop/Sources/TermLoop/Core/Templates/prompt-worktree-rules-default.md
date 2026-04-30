# Working With Worktrees

You are operating inside a git worktree. Treat this checkout as the source of
truth for the current task.

Core rules:

- Stay inside this worktree's cwd. Do not `cd` into the parent repo or sibling
  worktrees unless the user explicitly asks.
- Treat the currently checked out branch as the task branch. When asked to
  commit or push, operate on this branch only.
- Do not assume files visible in another checkout also exist here. Use the
  current worktree contents as ground truth.
- If submodule paths look empty or missing, check whether they simply need
  initialization before concluding the repo is broken.

When the task is about documenting workflow, setup, repo conventions, or "how
this project works", do this before writing docs:

1. Inspect the current worktree and understand how this branch is laid out.
2. Read any existing repo guidance files if present, especially `CLAUDE.md`,
   `AGENTS.md`, `.claude/CLAUDE.md`, `.agents/AGENTS.md`, `README.md`, and
   nearby docs for the area you are changing.
3. Infer what is branch-specific versus what is true for the whole repo. Do
   not accidentally document temporary branch-only details as if they were
   universal.
4. Prefer updating an existing guidance file over creating a new one.

Guidance-file policy:

- If `CLAUDE.md` exists at the repo root, prefer updating it for Claude-
  specific working instructions.
- If `AGENTS.md` exists at the repo root, prefer updating it for broader agent
  workflow instructions.
- If both exist, keep responsibilities clear: put model-specific advice in
  `CLAUDE.md`, shared agent/repo workflow in `AGENTS.md`.
- If neither exists and the user asks you to capture learned workflow, create
  the smallest sensible file:
  `AGENTS.md` for general agent workflow,
  `CLAUDE.md` only when the guidance is explicitly Claude-oriented.

When writing or updating `CLAUDE.md` / `AGENTS.md`:

- Base the content on what you verified in this worktree: commands, paths,
  scripts, test entrypoints, branch/worktree gotchas, and failure modes.
- Write concrete instructions, not generic advice.
- Mention worktree-specific pitfalls when they matter, such as stale cwd,
  missing submodules, branch-bound paths, or generated files living only in
  this checkout.
- Keep the file scoped to durable guidance. Do not dump one-off debugging
  notes or temporary branch context unless the user explicitly wants that.
- If you are unsure whether something is globally true or only true in this
  branch, say so or leave it out.

Before finishing a docs-writing task, quickly self-check:

- Did I document the current repo reality, not an assumption from another
  checkout?
- Did I update the right file (`CLAUDE.md` vs `AGENTS.md`)?
- Did I avoid leaking branch-local quirks into permanent guidance unless they
  are real recurring worktree rules?
