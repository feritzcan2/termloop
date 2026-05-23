# Git & PR Skill Customizer

You are customizing the **Git & PR Rules** project rule for the repository the user is currently in.

Your job is to generate a short, practical, project-specific skill at:

`.termloop/skills/working-with-git/SKILL.md`

Keep the final skill 120–300 words. Do not write the skill until the user explicitly approves the draft. Do not invent conventions; mark anything detected from repo history as a candidate unless docs or the user confirm it.

## Phase 1 — Detect repo conventions

Run best-effort checks and summarize briefly:

```bash
git branch --show-current 2>/dev/null || true
git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin 2>/dev/null \
  | sed 's#^origin/##' | sort -u | head -120 || true
git log --oneline -n 120 2>/dev/null || true
grep -RniE 'branch|commit|pull request|PR title|rebase|merge|conventional commit|jira|ticket' \
  README.md CONTRIBUTING.md CLAUDE.md AGENTS.md .github docs .termloop .claude .codex .agents \
  2>/dev/null | head -120 || true
find .github -maxdepth 3 -type f 2>/dev/null | sort || true
```

Look for:
- branch naming convention
- commit message convention
- PR title/body/checklist convention
- merge vs rebase preference
- ticket key rules
- protected/generated paths agents should not touch
- existing local or global `working-with-git` skill

## Phase 2 — Ask only missing questions

Ask only narrow questions the evidence did not answer. Group them in one message with proposed defaults:
- default branch naming shape
- whether commits/PR titles must include a ticket key
- merge vs rebase preference
- whether agents should commit automatically or leave changes unstaged
- required checks before opening a PR

Skip generic best-practice questions.

## Phase 3 — Draft and approval

Show the proposed `SKILL.md` in a markdown code block and ask for approval.
The file must include frontmatter:

```markdown
---
name: working-with-git
description: Use when working with branches, commits, pull requests, merge conflicts, or repository history in <Project>.
---
```

Keep the body concrete and short. Good sections are: Branches, Commits, PRs, Reviews / conflicts, Pitfalls. Omit sections with no repo-specific content.

## Phase 4 — Write

After approval, write `.termloop/skills/working-with-git/SKILL.md`. If the file already exists, show a concise replace-vs-merge diff and ask for a second explicit approval before overwriting.

After writing, tell the user that TermLoop will sync the native skill files and enable this rule for worktrees automatically.
