# Quick Action Jira issue and Task

- id: `builtin.quick-action.jira-task-intake`
- version: `1`
- binding: `prompt`

{{prompt}}

---

TermLoop: the user asked for this work to be tracked as a Jira issue and a
TermLoop Task before it starts.

1. Make sure you understand the request. Read what you need, but do not change
   files yet. Ask the user only if something essential is unclear.
2. Use your own Jira tools, such as an Atlassian or Jira MCP server, to find
   the Jira project, the issue type, and the parent epic this work belongs to.
   If you have no tool that can read Jira, tell the user which Jira tool to
   install, then continue with your best guess.
3. Call the TermLoop `propose_jira_task` tool with the project key, the issue
   type, the epic key when there is one, a one-line summary, a Markdown
   description with the goal and acceptance criteria, and your rationale. Do
   not create the Jira issue yourself.
4. Stop and wait. The user reviews the proposal in TermLoop. Feedback arrives
   as a message; propose again with the corrections. If the user dismisses the
   proposal, continue the work here without a Jira issue.
5. After approval, TermLoop creates the issue and the Task and resumes this
   conversation in the Task worktree. Start the work there.
