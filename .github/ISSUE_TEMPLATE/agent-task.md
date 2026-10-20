---
name: Agent task
about: A unit of work sized for one implementer agent (Opus 5.5)
title: "[task] <package>: <what>"
labels: agent-task
---

## Goal

## Spec

Link to `docs/specs/<name>.md` (write one first if it does not exist; see `/agent-task-spec`).

## Package / paths the agent may touch

## Acceptance criteria

- [ ] `pnpm check` green (and `uv run pytest` if `packages/data` changed)
- [ ] tests for every exported function
- [ ] spec updated with deviations

## Notes for the agent (edge cases, fixtures, decisions already made)

## Setup for the agent

- Read `CLAUDE.md`, `docs/WORKFLOW.md`, `docs/HANDOVER.md` and the linked spec before writing code.
- Toolchain: `mise install && pnpm install --frozen-lockfile`; Python: `cd packages/data && uv sync`.
- Branch from `main`: `feat/<area>-<short>`. Never commit to `main`.
- Gates before every push: `pnpm format && pnpm check`; `uv run pytest -q` for Python.
- Open a **draft** PR with `.github/pull_request_template.md`, `Closes #<this issue>` in the body.
- Public repository: no personal data, hostnames, local paths, secrets or data files in the diff.
- Stuck? Stop and write what you know in the PR; the maintainer decides.
