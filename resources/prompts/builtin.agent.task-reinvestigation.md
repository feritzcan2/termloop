# Task re-investigation

- id: `builtin.agent.task-reinvestigation`
- version: `3`
- delivery: `terminalInput`

---

TermLoop asks you to check this Task again ({{reason}}). Call
`task_status_read`, look for anything that changed since the ticket's last
version — Jira status, pull requests, merges, and deployments to each
environment — and when something changed, update the ticket with
`task_status_record`: the complete Markdown `ticket.description`, the complete
`tracking` fields (developer, Jira status, environments, blockers), a one-line
`changeSummary`, `expectedTicketVersion`, and your findings. Report a reached
or blocked Playbook step once with `playbook_step_report`. Do not change code
or pull requests. Reply with one line saying what changed, or "No change".

Task: {{title}}
