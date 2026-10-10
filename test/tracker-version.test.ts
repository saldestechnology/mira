import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { ftsAvailable, MIGRATIONS, openDirectory } from '../server/directory.mjs';
import { canRead, maxReaderOf, migrate, readSchemaState } from '../server/schema.mjs';

const CONTROL_TOKEN = 'v'.repeat(48);
const roots: string[] = [];
const opened: ReturnType<typeof openDirectory>[] = [];

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function apiFor(tracker: boolean) {
  const root = fs.mkdtempSync(fileURLToPath(new URL('./tracker-version-', import.meta.url)));
  roots.push(root);
  const config = loadConfig({
    PORT: '8787',
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: 'owner@example.test',
    TABULA_TRACKER: tracker ? 'on' : 'off',
    TABULA_CLOUD_TOKEN: CONTROL_TOKEN,
    TABULA_CLOUD_URL: 'https://cloud.example.test',
    TABULA_CLOUD_WORKSPACE_ID: 'tracker-version',
  });
  const directory = openDirectory(path.join(root, 'directory.sqlite'));
  opened.push(directory);
  const mailer = { send: async () => {} };
  const auth = createAuth({ directory, config, mailer });
  const cloud = {
    tokenOk: (authorization: string | undefined) => authorization === `Bearer ${CONTROL_TOKEN}`,
    limits: () => ({ readOnly: false }),
    autoUpgrade: () => true,
  };
  const api = createApi({ directory, auth, config, roomExists: () => false, events: new EventEmitter(), cloud: cloud as never, mailer });
  return { api, directory };
}

async function version(api: ReturnType<typeof apiFor>['api']) {
  const response = {
    headersSent: false,
    status: 0,
    body: '',
    writeHead(status: number) { this.status = status; this.headersSent = true; },
    end(body?: string) { this.body = body ?? ''; },
    setHeader() {},
  };
  await api.handle({ url: '/api/internal/version', method: 'GET', headers: { authorization: `Bearer ${CONTROL_TOKEN}` } } as never, response as never);
  return { status: response.status, body: response.body ? JSON.parse(response.body) : undefined };
}

describe('tracker version capability and release reader', () => {
  it('reports the SQLite FTS5 probe and the configured feature flag', async () => {
    const enabled = apiFor(true);
    const on = await version(enabled.api);
    expect(on.status).toBe(200);
    expect(on.body.capabilities).toEqual({ tracker: { fts5: ftsAvailable(enabled.directory.db), enabled: true } });

    const disabled = apiFor(false);
    const off = await version(disabled.api);
    expect(off.body.capabilities).toEqual({ tracker: { fts5: ftsAvailable(disabled.directory.db), enabled: false } });
    expect(loadConfig({}).tracker).toBe(false);
    expect(() => loadConfig({ TABULA_TRACKER: 'maybe' })).toThrow(/TABULA_TRACKER must be on or off/);
  });

  it('declares the latest schema with v5.0.1 as its oldest reader and lets that build open it', () => {
    const latest = MIGRATIONS.length;
    const v501 = MIGRATIONS.slice(0, 11);
    expect(latest).toBeGreaterThanOrEqual(14);
    expect(maxReaderOf(MIGRATIONS)).toBe(11);
    const db = new DatabaseSync(':memory:');
    try {
      expect(migrate(db, MIGRATIONS, 'directory')).toEqual({ version: latest, minReader: 11, legacy: false });
      const state = readSchemaState(db);
      expect(state).toEqual({ version: latest, minReader: 11, legacy: false });
      expect(canRead(state, 11)).toBe(true);
      // the v5.0.1 build knows 11 migrations: it opens the file, changes nothing and its own tables still work
      expect(migrate(db, v501, 'v5.0.1 directory build')).toEqual(state);
      expect(migrate(db, MIGRATIONS.slice(0, latest - 1), 'previous directory build')).toEqual(state);
      expect(Number(db.prepare('PRAGMA user_version').get()!.user_version)).toBe(latest);
      db.prepare("INSERT INTO users (id, email, name, role, created_at) VALUES ('u1', 'a@example.com', 'A', 'owner', 1)").run();
      expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }

    const result = spawnSync(process.execPath, ['scripts/release-info.mjs'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: { directory: MIGRATIONS.length }, maxReader: { directory: 11 } });
  });
});
