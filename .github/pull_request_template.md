## What

<!-- One paragraph: the user-visible or developer-visible change. -->

## Spec

<!-- Link to docs/specs/<name>.md or "n/a (bug fix)". -->

## Deviations from the spec

<!-- Bullet list, or "none". Each with a reason. -->

## Verification

- [ ] `pnpm check` green locally
- [ ] `uv run pytest` green (if `packages/data` changed)
- [ ] Fixture round-trip (`tokens-hooktheory.json`) still green (if tokens changed)
- [ ] No data files, caches or secrets in the diff

## Review

<!-- Findings from /code-review or the reviewer agent: fixed / declined (why). -->
