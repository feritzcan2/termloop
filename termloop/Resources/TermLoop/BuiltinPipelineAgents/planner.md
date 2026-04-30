---
id: planner
name: Planner
description: Reads an approved spec and produces a concrete numbered build plan
model: opus
permissionMode: default
tools: [Read, Grep, Glob, Write]
systemPromptDocumentId: "system.template.planner"
---
Read FINAL_SPEC.md and produce PLAN.md in the required format.
