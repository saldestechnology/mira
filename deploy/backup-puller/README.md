# Tabula backup puller

This standalone Node ESM program runs on a separate Ubuntu host. It pulls the already sealed backup objects and manifests for each hosted workspace to local disk. It imports only Node built-ins, so copy this folder to the pull host; the host does not need an npm install or a checkout of the Tabula repository.

The workspace control plane (or an operator) maintains `workspaces.json`. For each `running` or `stopped` workspace, the puller derives a workspace bearer token from the pull master, pages through the authenticated export listing, downloads objects before manifests, and writes each file through a same-directory temporary file, fsync and rename. A GET can wake a stopped workspace. Transient network failures, 502, 503, 504 and 429 responses are retried; `Retry-After` is honored up to 60 seconds. Suspended, deleted and provisioning workspaces are reported as intentionally skipped.

The pull master is read only from `pullMasterFile`, which must be a regular file that is not group or world writable. The puller never reads or derives the backup encryption key. The pull host holds ciphertext and the pull master only; keep the backup key in an operator-controlled password manager or other location away from the host.

## Config and run

Start from [`puller.example.json`](./puller.example.json). The config file has exactly these fields:

| Field | Meaning |
| --- | --- |
| `storeDir` | Root for local copies. Files are stored under `<storeDir>/<slug>/<prefix>/objects/` and `manifests/`. |
| `stateDir` | Pull state, object last-seen tracking and the Prometheus text file. |
| `pullMasterFile` | File containing the pull master as UTF-8 text. One final newline is removed. |
| `workspacesFile` | JSON array of `{ "id", "slug", "state" }` records supplied by the control plane or an operator. |
| `prefix` | Export prefix, normally `tabula`. |
| `baseUrlTemplate` | HTTPS origin containing exactly one `{slug}` placeholder. |
| `concurrency` | Number of workspaces to pull at once. |
| `keepDaily`, `keepWeekly` | Daily and weekly manifest retention counts. |
| `objectGraceDays` | Days an object must remain unseen before local deletion; default `35`. |
| `metricsFile` | Atomic Prometheus text exposition file. |
| `requestTimeoutSeconds` | Timeout for regular requests. The first request to a stopped workspace is allowed 60 seconds. |

All configured paths must be absolute. Workspace slugs match `[a-z0-9-]{1,63}` and ids match `[A-Za-z0-9._-]{1,128}`. The pull master is not accepted on the command line or from an environment variable.

```sh
node pull.mjs --config /etc/tabula-backup/puller.json
node pull.mjs --config /etc/tabula-backup/puller.json --only studio
node pull.mjs --config /etc/tabula-backup/puller.json --dry-run
```

Exit status is `0` when every workspace succeeded or was intentionally skipped, `1` if one or more workspace pulls failed, and `2` for a config or input error. A failed workspace does not stop the others. Dry run lists planned fetches and deletions and does not write files, state or metrics.

The puller writes `<stateDir>/<slug>.json` with attempt/success timestamps, a short error code, local file and byte totals, files and bytes added by the last attempt, and the newest manifest name. `<stateDir>/<slug>.seen.json` tracks the last successful complete listing time for each object key.

## Retention

The pull host cannot decrypt manifests, so manifest retention uses only their UTC timestamp names. It keeps the newest manifest for each of the last `keepDaily` UTC calendar days, the newest for each of the last `keepWeekly` ISO weeks outside that daily window, and the newest manifest overall. A failed pull never prunes manifests.

Objects cannot be connected to the files named by a manifest without the backup key. The puller therefore deletes an object only after the source has not listed it for `objectGraceDays` (35 days by default), and only after both source listings completed and the whole workspace pull succeeded. A partial or failed listing never advances object age. This intentionally over-retains objects: objects no longer referenced by a retained manifest can remain on disk until the grace period expires, and objects with no recorded successful last-seen time are kept.

## Prometheus

The puller atomically writes these metrics, with one `workspace="<slug>"` sample per configured workspace:

- `tabula_backup_age_seconds`
- `tabula_backup_last_attempt_timestamp_seconds`
- `tabula_backup_last_success_timestamp_seconds`
- `tabula_backup_stored_bytes`
- `tabula_backup_files`
- `tabula_backup_has_manifest`
- `tabula_backup_last_run_ok`
- Global: `tabula_backup_puller_last_run_timestamp_seconds` and `tabula_backup_workspaces_total`

When a workspace has never had a successful pull, its age is emitted as `1e12`; a workspace with no manifest has `tabula_backup_has_manifest 0`. Intentional state skips count as a successful run for `tabula_backup_last_run_ok`.

Example host alert rules:

```yaml
groups:
  - name: tabula-backups
    rules:
      - alert: TabulaBackupTooOld
        expr: tabula_backup_age_seconds > 26*3600
        for: 5m
      - alert: TabulaBackupPullFailing
        expr: tabula_backup_last_run_ok == 0
        for: 2h
      - alert: TabulaBackupDiskLow
        expr: (node_filesystem_avail_bytes{mountpoint="/home"} / node_filesystem_size_bytes{mountpoint="/home"}) < 0.15
        for: 10m
```

Adapt the disk rule's exporter labels and mount point to the host. Alert on both available bytes and percentage if the store volume has a fixed size.

## Restore integrity check from a laptop

Copy one workspace directory from the host with `rsync`, then run the standalone checker on the laptop. Supply the key from the password manager through the local environment; do not put it in shell history or a file.

```sh
rsync -a backup-host:/home/tabula-backup/store/studio/ ./studio-backup/
TABULA_RESTORE_KEY="$(your-local-password-manager-command)" node restore-check.mjs --store "$(pwd)/studio-backup"
```

The checker finds the newest manifest, decrypts it and each referenced object, verifies AES-GCM integrity and the keyed object id, and compares every plaintext size with the manifest. It prints one JSON summary line and exits `0` when all entries verify or `1` otherwise. For an unattended host-side structure check that does not use a key:

```sh
node restore-check.mjs --store /home/tabula-backup/store/studio --structure-only
```

Structure-only mode checks sealed headers, object and manifest names, plausible sealed lengths, and that the newest manifest name is no more than 26 hours old. It cannot verify manifest contents or object references.

## Installing on the host

Copy this whole folder to the host and, as root, run `bash host-setup.sh` (or `bash host-setup.sh --dry-run` first). It asks before every step, is safe to run again, and touches only the user `tabula-backup`, its home `/home/tabula-backup` and that user's lingering flag: it creates the user (locked password, no sudo), the folders `bin`, `etc`, `store`, `state`, copies the two scripts (root-owned), writes the config, asks for the pull master at a hidden prompt (stored root-owned, mode 0440, group `tabula-backup`), creates an empty `workspaces.json`, and installs two systemd user timers: the daily pull (03:30 plus up to 20 minutes) and a weekly `--structure-only` check. Retention defaults to 7 daily and 4 weekly manifests, with objects kept 35 days after the source stops listing them; these are defaults, edit `etc/puller.json` to change them.
