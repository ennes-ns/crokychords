# Workflow: maintainer, main session and coding agents

How this project is built. The technical rules for agents are in `CLAUDE.md`; this document is about
who does what and how work moves.

## Roles

| Who                                                                     | Does                                                                                                                                                                                            | Does not                                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Maintainer** (the project owner)                                      | Decides what the product should be. Brings ideas, approves plans and results, uses the app and reports what feels wrong. Decides on domain, hosting, licences and spending.                      | Write code, merge PRs, fix CI.                                         |
| **Main session** (Claude Code on the maintainer's workstation)          | Turns ideas into specs and issues. Reviews every PR, runs the checks and the app locally, merges into `main`. Keeps `docs/ROADMAP.md` and `docs/HANDOVER.md` current.                            | Build large features itself (that is agent work), merge without green CI. |
| **Coding agents** (cloud sessions on GitHub, or local agents in a worktree) | Take one issue, build it on their own branch, open a PR with tests.                                                                                                                           | Touch `main`, combine issues in one PR, commit data or secrets.        |

## The loop

1. **Idea** → the maintainer tells the main session; one sentence is enough.
2. **Spec** → the main session writes `docs/specs/<name>.md` and an issue (template "Agent task", label
   `agent-task`). An issue gets `ready` when an agent can start, `blocked` when a decision is pending.
3. **Build** → an agent takes the issue: branch `feat/<area>-<short>`, PR with `Closes #N`. Issues that
   do not overlap in files may run in parallel; the issue says when one has to wait.
4. **Check** → CI runs (`pnpm check`, `data tests`); the main session reviews (`/code-review` plus the
   `reviewer` agent), pulls the branch into a worktree and tries the app. Label `in-review`.
5. **Merge** → only the main session, only with green CI and resolved review findings. Squash merge, so
   `main` gets one commit per issue.
6. **Status** → the main session updates `ROADMAP.md`; the issues show where everything stands.

`main` is protected: nobody pushes to it directly. Everything goes through a PR.

## Who builds and who reviews

Two labels per issue decide who builds it and how much effort it needs:

| Labels                     | Builder                                 | Model and effort                                             |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `size:S` + `agent:gemini`  | Gemini (Jules or Code Assist), free     | small jobs: docs, renames, one-file fixes                    |
| `size:M` + `agent:claude`  | Claude cloud session                    | Sonnet 5.5, normal effort: one package, spec exists          |
| `size:L` + `agent:claude`  | Claude cloud session                    | Opus 5.5, high effort: several packages or design work       |

Review on every PR, in this order:

1. **CI** (`pnpm check`, `data tests`): required.
2. **CodeRabbit and Gemini Code Assist** comment automatically (both free for this public repo). The
   builder addresses or rebuts every finding in the PR.
3. **Main session**: final review, runs the app in a worktree, merges.

Reviewers from a different vendor than the builder are deliberate: the same model family misses the
same things.

## What the maintainer does

- **Start an agent.** Open a Claude Code cloud session on the repository and say: _"Take issue #N
  according to its spec and open a draft PR."_ The issue and `CLAUDE.md` contain the rest. Several
  `ready` issues can go to several sessions at once.
- **Steer the main session.** Useful phrases:
  - _"Plan X"_ → spec and issue(s).
  - _"Review PR #N"_ → review, test, verdict: merge or back to the agent.
  - _"Merge #N"_ → when the result is already approved.
  - _"Status?"_ → what runs, what waits for a decision.
- **Decide.** Everything labelled `blocked` waits for a decision; questions come bundled, not one at a
  time.
- **Use the app.** `pnpm dev` locally, or the preview in a PR. Anything that feels off is worth an issue.
- **Once:** `gh auth refresh -h github.com -s workflow`, otherwise changes to `.github/workflows/`
  cannot be pushed from the workstation.

## Rules that keep it small and safe

- One issue = one branch = one PR, preferably under ~1500 lines of diff. Bigger? The issue gets split.
- Every PR has tests; green `pnpm check` is the floor, not the goal.
- No data files, caches or `.env` in git. Only data that may be redistributed reaches users.
- No references to other products in code or docs; Croky Chords stands on its own.
- Public repository: no personal data, internal hostnames, tokens or local paths in docs, issues or PRs.
- When an agent gets stuck it stops and writes what it knows in the PR; the main session decides.

## Where things live

| What               | Where                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Backlog            | GitHub Issues (labels `ready`, `blocked`, `in-review`, `maintainer`, `size:*`, `agent:*`) |
| Specs              | `docs/specs/`                                                                             |
| Decisions          | `docs/adr/`                                                                               |
| Progress           | `docs/ROADMAP.md`                                                                         |
| State              | `docs/HANDOVER.md`                                                                        |
| Agent instructions | `CLAUDE.md`, `.claude/agents/`, `.claude/skills/`                                         |
