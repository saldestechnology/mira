# CDX-47: tracker filter grammar black-box report

- **Task:** CDX-47, revision 1; follow-up CDX-48
- **Repository base:** `a408f08b97e2dfdc21d5d876e186e415cdcab096`
- **Branch:** `codex/filter-bb`
- **Worktree:** `/Volumes/External/tabula/wt/codex-filter-bb`
- **Implementation scope:** HTTP regression tests and this report only; no product source changes.

## Coverage

The new test uses the accounts-mode real relay with `TABULA_TRACKER=on`. It creates tickets, members, a project, milestone, parent and blocking relation through HTTP; timestamps are seeded in the isolated harness database to make UTC boundary checks deterministic. It checks negation, comma any-of lists, creators, priorities, state categories, UTC created/updated boundaries, no-assignee, project and milestone names, parent and blocking relations, and a saved view using a compound filter. Hostile HTTP filters cover overlong lists, Unicode, quote/escape syntax, SQL metacharacters and impossible dates. Each hostile filter checks for a clear 400 response and that the tracker remains available.

## Query size behavior

- **A 10,000-character search query returns HTTP 413 as expected.** The response is a clear `limit_exceeded` error with path `q`, and it is not a 500. The regression test asserts status 413 and the error code/path. The shared `limit_exceeded` mapping is at `server/api.mjs:1460`; the ticket route renames the query error path to `q` at `server/tracker/api-routes.mjs:544`.

No other product defects were observed in the tested grammar.

## Checks

- CDX-47 focused real-HTTP test: passed.
- CDX-47 Windows-branch repeat across the new test and five existing filter/API files: passed all 15 runs (83 tests per run).
- CDX-47 TypeScript, lint, changelog, and full Vitest gates: passed; full suite reported 390 files, 8,664 passed and one expected failure at that revision.
- CDX-48 updated focused test: passed, 11 tests.
- CDX-48 Windows-branch repeat: `npm run test:repeat -- test/cdx47-filter-grammar-http.test.ts --times 15 --platform win32` passed all 15 runs (11 tests per run).
- Changes remain uncommitted.
