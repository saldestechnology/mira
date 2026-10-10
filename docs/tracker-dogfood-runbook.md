# Tracker dogfood on tabulahq: release checklist

Goal: turn the tracker on for **tabulahq only** (the HQ workspace), import Linear, and use it. Every production step below needs Johan's explicit go in the tech lead's session (one phrase per step, see "Go phrases"). Nothing here runs by itself.

Status of the preconditions (update before the run):

| Precondition | Where it stands |
|---|---|
| Migration gate G (v4 retired) | Done 2026-10-10: v5.0.1 `current`, v4 and v5 withdrawn. |
| Tracker slices 1, 2, 3a, 6 on `main` behind `TABULA_TRACKER=off` | Merging through the manager's queue. |
| UI: frame, shell, list, ticket page, inbox | Designer, tech lead and devops branches; merge before the build. |
| Control plane can set `TABULA_TRACKER` per workspace | `TRACKER_WORKSPACES` setting, branch `feat/tracker-workspaces` in tabula-cloud. Needs a control-plane deploy ("go control-plane deploy"). |
| Importer in the image | **Not yet.** `scripts/` is not in the Dockerfile. See step 5. |
| Off-site backups | **Not configured** (no `TABULA_BACKUP_*` values). Only Fly volume snapshots (14 days, same region) protect HQ. Linear stays on, read-only, until the restore drill passes. |

## 1. Build the release candidate (go phrase: "go tracker build")

1. Make sure `main` has every tracker piece above and is green in CI.
2. Build and push the image from a clean checkout of `main` (the build routine of the v5 release: `fly deploy --build-only --push --image-label <label> --app tabula-app --remote-only`), read the digest back from the registry, and register it as a candidate with `scripts/release.sh` (version `v5.1`, notes naming the commit). The schema numbers come from `npm run release-info`: directory schema must be at least 14, `maxReader` 11 (see "Rollback").
3. Do **not** promote. `UPGRADES` stays off. acme is not touched.

## 2. Control plane: the per-workspace flag (go phrase: "go control-plane deploy")

1. Deploy the control plane with `feat/tracker-workspaces` (merged, CI green). Nothing changes until the setting is used.
2. Set `TRACKER_WORKSPACES=ws_Qz43ux4p5HNJ` (tabulahq's id) in the control plane's environment. A hand-set `TABULA_TRACKER` on the machine would be removed by the next upgrade, which is why the control plane owns it.
3. `POST /admin/workspaces/ws_Qz43ux4p5HNJ/upgrade {"release":"v5.1","dryRun":true}`: the diff must show the image and `env.TABULA_TRACKER` only, `rollbackSafe: true`.

## 3. Backup first (part of "go tracker tabulahq")

1. `fly volumes snapshots create <tabulahq volume>`; wait for `created`.
2. Download a copy of the board data: with the machine started, `fly ssh sftp get` is not safe for a live database, so instead rely on the snapshot and on step 5's stopped-machine copy. Record the snapshot id in the audit note.
3. Confirm the previous image digest (`imagePreviousRef`) so a rollback is one action.

## 4. Upgrade tabulahq and switch the tracker on (go phrase: "go tracker tabulahq")

1. Quiet moment: `GET https://tabulahq.thetabula.cloud/api/health` shows 0 connections (or the people on it agree). No `force` (tabulahq's image is known).
2. `POST /admin/workspaces/ws_Qz43ux4p5HNJ/upgrade {"release":"v5.1"}`. Wait for `imageVerifiedAt`.
3. Checks: `/api/health` ok; `GET /api/internal/version` shows `capabilities.tracker.enabled: true` and `fts5: true`; `/mcp` answers 401 without a token; open the board as an owner; `/api/me` has `tracker: true` for an owner and not for a guest.
4. Smoke test as an owner: create the tracker frame on HQ, create a ticket (check the key is `TAB-1`), edit it, move its state, comment, subscribe, search it, archive and restore it. Via MCP: `create_ticket`, `list_tickets`, `search_tickets`.
5. Leave the feature **on**. Linear remains the record until the importer run is verified.

## 5. Importer run (go phrase: "go linear import")

The importer is `scripts/linear-import.mjs` (docs/linear-import.md). It must write to the workspace's `directory.sqlite` while no relay runs. Plan:

1. Add `scripts/linear-import.mjs`, `scripts/linear-verify.mjs` and `scripts/lib/` to the image (a `COPY scripts ...` line in the Dockerfile, plus `server/tracker/linear-import.mjs`, already in `server/`). This is part of the step 1 build; if the candidate lacks it, rebuild before this step.
2. On the operator machine, with the Linear key in the environment only (the env-get flow, never in argv): `node scripts/linear-import.mjs fetch --out ./linear-work` (add `--record` for a rehearsal fixture).
3. Rehearse against a copy: restore the pre-import snapshot to a **scratch volume** (never the live one), run `dry-run` and a limited `import --max-issues 50` there, and read the report (no titles or bodies in it). Fix mappings (states, users) before the real run.
4. Real run: stop the tabulahq machine (control plane `stop`, with the people warned); update the machine config with `init.cmd` set to the import command and the snapshot file in the machine `files`, start it once, read its exit code and the report, then restore the normal config (`update-machine` with `init.cmd` removed). Use `--actor-email` of the owner and `--numbering keep` if every Linear team key is `TAB`, otherwise `allocate`.
5. Start the machine normally, run `verify` against a final fetch, spot-check 50 tickets, 20 comments, 10 relations and every project.
6. Start the two-week dual run (Linear read-only for edits that matter). Cancel Linear only after the off-site backup restore drill passes (docs/tracker-architecture.md section 9).

## Rollback

- **Flag only:** remove tabulahq from `TRACKER_WORKSPACES`, run `update-machine`. Data stays in the database; the UI disappears.
- **Image:** upgrade tabulahq back to v5.0.1 (`imagePreviousRef`). Allowed because every tracker migration keeps `min_reader` at 11 (decision of 2026-10-10): v5.0.1 ignores the tables. Check `release-info` `maxReader` is 11 before the first upgrade.
- **Data:** restore the volume snapshot from step 3 (this loses everything written after it, including imported tickets: import again).

## Go phrases

| Phrase | What it authorises |
|---|---|
| go tracker build | Step 1: build and register the candidate. |
| go control-plane deploy | Step 2: deploy the control plane with `TRACKER_WORKSPACES`. |
| go tracker tabulahq | Steps 3 and 4: snapshot, upgrade tabulahq, tracker on. |
| go linear import | Step 5: stop the machine and write the import. |

## Open points to settle before the first run

1. Off-site backups credentials (Johan): without them, HQ's tickets are protected by volume snapshots only.
2. Who may use the tracker on tabulahq: owners, admins and members (decision 7 of the tracker spec); guests do not see it.
3. Linear API key handling for the fetch (stored as a Fly/CP secret or typed once into the env-get flow).
4. Whether acme gets the tracker later (`TRACKER_WORKSPACES`), and the same snapshot-first routine.
