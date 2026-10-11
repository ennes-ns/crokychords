---
name: agent-task-spec
description: How to write a task for an implementer or data-engineer agent in this repo; use when launching an Opus agent or when a request is too vague to hand off.
---

# Writing an agent task

An agent gets one prompt and no follow-up questions, so the prompt must carry everything.
Template (also mirrored in `.github/ISSUE_TEMPLATE/agent-task.md`):

```
You are the implementer for <package>. Work ONLY inside <paths>. Do not commit/push.
Spec: <docs/specs/x.md>. Read first: <files>.
Addenda (override the spec): <bullets with concrete edge cases you found>
Verification: <exact commands that must pass>
Report back: files, API, deviations + why, ambiguities + choice, test count, check tail.
```

Rules of thumb:
- One deliverable per agent, one package per agent. Parallel agents must touch disjoint
  directories (core vs data vs docs). `apps/web` waits for `packages/core`.
- Resolve ambiguities yourself before launching; a guess in the spec beats a guess in code.
- Give the fixture facts: e.g. the one lowercase sus token `vii°sus2/iv`.
- Ask for a report, then **review the diff yourself** before committing; the report is a map,
  not the territory.
- Model: implementation on `opus`; planning/review on the main model.
