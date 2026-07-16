# Contributing

This project follows the Quality Constitution in the app (Product hub -> Governance, section 7) and the workflow in Product hub -> Workflow. The short version:

## The gate
Before anything is "done" or released:

```bash
npm run check    # typecheck + full test suite; must be green
```

A red test blocks a release. New behaviour without a test is "in progress," not "done." GitHub Actions runs this same command on every push (`.github/workflows/check.yml`) as a visible signal, but this is a solo repo with no branch protection, so a red CI run does not block merging by itself. The gate is enforced locally instead: a **pre-push git hook** runs `npm run check` and refuses the push outright if it fails.

### Installing the pre-push hook
One-time setup per clone (dependency-free - no husky, just a script + a git config setting):

```bash
git config core.hooksPath .githooks
```

The hook lives at `.githooks/pre-push`. After this, every `git push` runs `npm run check` first and aborts the push on a red result. Emergency bypass (not recommended): `git push --no-verify`.

## Where things live
- **Pure, testable logic:** `server/lib.js` (frontmatter write path, date/scalar helpers).
- **Tests:** `tests/` (Vitest). `*.test.js` for server/lib + the Express API (supertest over a fixture vault), `*.test.ts` for frontend utils.
- **The non-negotiable:** `updateFrontmatter` (it edits the user's vault) must keep passing unit + integration tests, including the byte-identical round-trip.

## Releasing
Follow the Release pipeline (Workflow tab): `npm run check` -> update `docs/changelog.md` + `docs/roadmap.yaml` -> vault linter clean (if vault touched) -> verify live -> bump version -> restart the server (it runs as plain `node`, so it does not auto-reload on server edits).

## Data safety
Never delete a job, rewrite a note body, or auto-submit. See `DATA_CONTRACT.md`.
