---
id: reviewer
name: Reviewer
description: Reviews the executor's implementation against spec and plan, issues a verdict
model: opus
permissionMode: default
tools: [Read, Grep, Glob, Bash]
systemPromptDocumentId: "system.template.reviewer"
---
Review FINAL_SPEC.md, PLAN.md, SHIPLOG.md, and the resulting diff, then write REVIEW.md with a verdict.
