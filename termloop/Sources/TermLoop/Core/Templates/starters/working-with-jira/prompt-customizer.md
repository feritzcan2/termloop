# Jira Ability Customizer

You are customizing the **Working With Jira** ability for the repository the user is currently in.

Your job is to generate a short, practical, project-specific skill at:

`.termloop/skills/working-with-jira/SKILL.md`

Keep the final skill 200–450 words. Do not mention any external project unless the repository evidence explicitly shows that name.
The ability's Agent payload only tells agents to use this skill; durable Jira behavior belongs in the skill body.

Do not write the skill until the user explicitly approves the draft.

## Phase 1 — Detect repo conventions

Run best-effort checks and summarize briefly:

```bash
git log --oneline -n 300 2>/dev/null \
  | grep -oE '[A-Z][A-Z0-9]{1,9}-[0-9]+' \
  | sort | uniq -c | sort -rn | head -10 || true
```

```bash
grep -RhoE '[A-Z][A-Z0-9]{1,9}-[0-9]+' \
  README.md CONTRIBUTING.md CLAUDE.md AGENTS.md .termloop .claude .codex .agents \
  2>/dev/null | sort | uniq -c | sort -rn | head -10 || true
```

```bash
git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin 2>/dev/null \
  | sed 's#^origin/##' | sort -u | head -100 || true
```

```bash
git log --oneline -n 80 2>/dev/null || true
```

Look for:
- likely Jira key(s)
- branch naming convention
- commit/PR title convention
- existing local or global `working-with-jira` skill

## Phase 2 — Detect Jira access

Check whether Atlassian/Jira MCP is configured in repo or global config, but never print config contents.
Prefer MCP. If MCP is unavailable, try Atlassian's official CLI (`acli`):

```bash
command -v acli || true
acli --version 2>&1 | head -3 || true
acli jira auth status 2>&1 | head -5 || true
```

If neither Jira MCP nor authenticated `acli` is available, do not continue to Phase 3 yet. Help the user get Jira access working first:

- Explain that Jira access is needed before repo-specific workflow recommendations can be grounded in real tickets.
- Offer to install `acli` on macOS with Homebrew:

```bash
brew tap atlassian/homebrew-acli
brew install acli
acli auth login
```

- Offer to register Atlassian's official remote MCP under the server name `atlassian` for the current agent, using that agent's MCP configuration mechanism. Use `https://mcp.atlassian.com/v1/mcp` as the remote MCP URL. Do not print or request secrets in chat; direct the user through the agent's auth/config flow.
- After the user installs or authenticates one access path, rerun Phase 2 checks.
- Only proceed without Jira access if the user explicitly says to continue in offline mode; mark the resulting skill as evidence-only and do not claim Jira-backed workflow facts.

If a likely issue key was detected and Jira is reachable, inspect 1–3 matching issues and note status, assignee, and available transitions.

## Phase 3 — Ask only missing questions

Ask only narrow questions the evidence and Jira access did not answer. Group them in one message with defaults:
- workflow states
- when to move to In Review
- when to move to Done
- required fields before Done
- one ticket per PR vs multi-ticket PRs

## Phase 4 — Draft and approval

Show the proposed `SKILL.md` in a markdown code block and ask for approval.
Do not write anything until the user says `ok`, `yes`, `approve`, or similar.

## Phase 5 — Write

After approval, write `.termloop/skills/working-with-jira/SKILL.md` with:
- `name: working-with-jira`
- a project-specific context section
- ticket identification rules
- TermLoop workspace context rules:
  - remote item bindings are user/app-owned; do not try to report or mutate the sidebar chip from the agent
- pre-transition checks
- transition rules
- PR ↔ ticket linking rules
- common pitfalls for this repo

Keep the body concrete, short, and aligned with the repo's actual evidence.
After writing, tell the user that TermLoop will sync the native skill files
and enable this ability for worktrees automatically.
