# AGENTS.md: rules for coding agents (Codex and others) in this repo

## Where you work
- Work ONLY in a git worktree at `/Volumes/External/tabula/wt/<agent>-<task>`, outside every main checkout. Never create folders in `/Volumes/External/tabula` itself, and never put a worktree inside a repo folder.
- Never edit the main checkout (`/Volumes/External/tabula/tabula`).
- First command of every job: `git rev-parse --show-toplevel`. If it is not your worktree, STOP and report.
- Use relative paths only, in shell commands and in apply_patch. Never write an absolute path (a dropped path segment once wrote into the main checkout).
- The orchestrating agent checks `git -C /Volumes/External/tabula/tabula status --short` after every job.

## What you may do
- Leave your changes UNCOMMITTED. The sandbox cannot write the git metadata of a linked worktree; the orchestrating agent reviews the diff and commits.
- No push, no deploy, no release, no secrets, no `.env` files, no `pkill` by name (stop only PIDs you started).
- Start every `codex exec` with `</dev/null` (otherwise it waits for stdin and hangs) and detach long jobs.

## Gates before you call a change done
- `npx tsc --noEmit`, `npm run lint`, `npm run changelog:check` (add `changelog.d/<id>.md`, never edit CHANGELOG.md), and the full `npm test` (vitest).
- Timing- or Windows-sensitive change: also `npm run test:repeat -- <files> --times 15 --platform win32`.
- Write tests the way `docs/testing.md` says (barriers, polling, injected clocks, lower bounds only).

## When your branch is merged
After your work is merged to main and the manager confirms, the owner removes the worktree: `git -C /Volumes/External/tabula/tabula worktree remove /Volumes/External/tabula/wt/<agent>-<task>` (no `--force`, never `rm -rf`), then `git worktree prune`. That removes the `node_modules` inside it too (each worktree has its own, and they fill the disk). Keep the branch; delete it only when the manager says so. A worktree with changes you still want, or one still named in the manager's queue, is not removed: say so instead.
