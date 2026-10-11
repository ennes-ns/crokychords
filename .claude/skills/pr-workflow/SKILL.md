---
name: pr-workflow
description: Branch, verify, commit and open a draft PR for Croky Chords; use when a change is ready to leave the working tree or when the user says "maak een PR" / "ship it".
---

# PR workflow

1. **Branch**: `git switch -c feat/<area>-<short>` from the default branch, unless the
   session already has a designated branch (then stay on it).
2. **Verify**: `pnpm format && pnpm check`; `cd packages/data && uv run pytest -q` if Python
   changed. Both must be green; never skip or delete tests to get there.
3. **Review**: run `/code-review` (or the `reviewer` agent) on the diff. Fix or explicitly
   decline each finding; declined findings go in the PR body.
4. **Commit**: conventional commit per logical change (`feat(core): …`, `fix(web): …`,
   `docs: …`, `chore: …`). Body explains why, not what. Never commit data files or `.env`.
5. **Push**: `git push -u origin <branch>`.
6. **PR**: draft, using `.github/pull_request_template.md`. Title = the commit subject style.
   Link the spec in `docs/specs/` and list deviations. Keep PRs reviewable (< ~1500 lines).
7. **After opening**: subscribe to PR activity if the tooling allows; fix CI and review
   comments until green; move out of draft only after a review pass.
