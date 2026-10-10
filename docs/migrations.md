# Database migrations

The directory and chat databases record a minimum reader generation so a newly deployed image can be rolled back when the schema still fits the older build. A migration is expand-only when the previous build can keep reading and writing after it runs.

## Migration entries

Each numbered migration is either a SQL string or an object:

```js
// Expand-only: generation 4 can still use this database.
'CREATE TABLE board_labels (board_id TEXT NOT NULL, label TEXT NOT NULL)'

// Breaking: only generation 5 or newer can use the rebuilt schema.
{ sql: `ALTER TABLE users DROP COLUMN legacy_name`, minReader: 5 }
```

A string declares `minReader` as `n - 1`, where `n` is its 1-based migration number. An additive SQL string may start with `-- minReader: k` to preserve a lower, reviewed reader floor. An object declares it explicitly with an integer from 0 through `n`. Use `minReader: n` for a breaking change. Use `minReader: n - 1` for an object entry after reviewing it as expand-only. Lower values are for cases where older generations have also been checked.

Expand-only changes include new tables, nullable columns, columns with a `DEFAULT`, and non-unique indexes. These can affect other SQL too: a unique index can make an older build's insert fail. Breaking changes include dropping tables, columns, indexes, triggers or views; renaming tables or columns; adding `NOT NULL` without a default; unique indexes; triggers; and data rewrites or removals. `INSERT` seed rows are allowed. `UPDATE` and `DELETE FROM` are treated as data changes.

Table rebuilds are always breaking. SQLite uses the create-new, copy, drop, rename pattern to change a constraint such as `CHECK`; mark that migration with `minReader`, even when the copied rows still fit the new table.

Directory migration 12 adds the nullable `access_tokens.tracker` capability and the tracker tables, indexes and seed rows. It is expand-only, so it records `min_reader = 11`; the release reports directory `schema: 12` and `maxReader: 11`. A build that knows schema 11 can open the migrated database unchanged. A v4 reader cannot open a schema-12 directory: it knows only four generations, below the recorded minimum reader of 11.

Directory migration 13 adds projects, milestones, ticket relations and saved views with their indexes. It is an additive SQL string annotated `minReader: 11`; it preserves existing ticket rows and leaves the release at directory `schema: 13` and `maxReader: 11`.

Directory migration 14 adds the notification inbox and email outbox. It is an additive SQL string annotated `minReader: 11`; it leaves the release at directory `schema: 14` and `maxReader: 11`.

Directory migration 15 adds linked-kanban mappings, card links and the SQL-to-Yjs projection outbox. It is declared as `{ sql, minReader: 11 }` because a tracker schema rollback to v5.0.1 remains supported while `TABULA_TRACKER` is off in production. The migration has no board foreign keys and no user foreign keys with restrictive delete behavior. It leaves the release at directory `schema: 15` and `maxReader: 11`.

The migration lint runs in `test/migrations-lint.test.ts`. It flags SQL patterns that need review. A plain-string entry with a flagged pattern fails; make it an object and choose `minReader: n` for a breaking change or `minReader: n - 1` after review confirms it is expand-only. The lint is a review aid, so read the migration and consider behavior the patterns may not recognize.

## Reader generations and legacy databases

`schema_meta` has a `min_reader` row in both `directory.sqlite` and `chat.sqlite`. Its value is the lowest migration generation of a build that can still read the file. It is updated in the same transaction as each migration and `user_version`.

Inspect it with:

```sh
sqlite3 directory.sqlite 'select * from schema_meta'
```

A build knowing `K` migrations can open a database when `min_reader <= K`. The build refuses one with a higher minimum reader. If the file is ahead of the build but still readable, it is left unchanged: no migration runs and `user_version` is not lowered.

A database with no valid `schema_meta` row is legacy. Its minimum reader is its `user_version`, so it is strict: only a build that knows at least that generation can open it. The first successful open records that generation before applying any later migrations.

Rolling back from a newer release `N` to an older release `O` is data-safe when `O.schema >= N.maxReader`: `N.maxReader` is the highest minimum reader that `N`'s migrations record in the database, and `O` can open the file only if it knows at least that many migrations. A string migration defaults to `n - 1`, so it permits one generation of rollback. A breaking migration can require the current generation and prevent rollback to the immediately previous build. The first release with this mechanism cannot safely be rolled back to a build from before the mechanism existed.

Backups and restores use the same reader rule. A restore accepts a newer backup when its `min_reader` permits this build to read it; legacy backups remain strict.

## Release information

`npm run release-info` prints the directory and chat schema generations and each list's highest declared reader generation (`maxReader`). Pass `-- --version <label>` to include a release label. The control plane can also read the running image and its database files from `GET /api/internal/version`, authenticated with the cloud bearer token; see [cloud.md](cloud.md). The Docker build argument `TABULA_VERSION` sets the reported image label.

## Contracting

Use two releases for a contract change. First deploy an expand-only release and move readers to the new representation. Remove the old representation only in a later release, after the control plane confirms that no live workspace runs an image that still reads it. A new image may otherwise be rolled back while an older workspace remains live.
