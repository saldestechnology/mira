import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, type BackupEngineStatus, type BackupSummary } from '../src/api';
import { ADMIN_TABS } from '../src/route';
import { visibleAdminTabs } from '../src/ui/admin-logic';
import {
  CONFIRM_WORD, ERROR_CODES, POLL_CAP_MS, POLL_FACTOR, POLL_GIVE_UP_MS, POLL_START_MS, RELOAD_GUARD_MS, classifyHealth, confirmMatches, errorReason, errorSentence,
  formatSize, formatUtc, formatUtcDate, intervalLabel, lastRestoreSentence, manifestTime, mayReload, nextPollDelay, nextScreen, noteOf,
  pollDelays, relativeTime, restoreGate, selectable, shortKey, statusRows, submitOutcome, waitLabel, watchServer, type Screen, type WatchDeps,
} from '../src/ui/backups-logic';

// docs/backups.md, "In the app": the rules and the text of the Backups tab, and the restoring screen's polling.

const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NAME = '20260115T093000Z.json.enc';

describe('times', () => {
  it('formats UTC the same everywhere', () => {
    expect(formatUtc(Date.UTC(2026, 9, 8, 19, 30, 59))).toBe('2026-10-08 19:30 UTC');
    expect(formatUtc(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01 00:00 UTC');
    expect(formatUtc(Date.UTC(2026, 11, 31, 23, 59, 0))).toBe('2026-12-31 23:59 UTC');
    expect(formatUtcDate(Date.UTC(2026, 9, 8, 19, 30))).toBe('2026-10-08');
  });

  it.each<[number, string]>([
    [0, 'just now'],
    [-44_000, 'just now'],
    [-45_000, '1 minute ago'],
    [-89_000, '1 minute ago'],
    [-5 * MIN, '5 minutes ago'],
    [-59 * MIN, '59 minutes ago'],
    [-60 * MIN, '1 hour ago'],
    [-3 * HOUR - 59 * MIN, '3 hours ago'],
    [-47 * HOUR, '47 hours ago'],
    [-48 * HOUR, '2 days ago'],
    [-59 * DAY, '59 days ago'],
    [-60 * DAY, '2 months ago'],
    [-400 * DAY, '13 months ago'],
    [30_000, 'in less than a minute'],
    [42 * MIN + 59_000, 'in 42 minutes'],
    [2 * HOUR, 'in 2 hours'],
    [3 * DAY, 'in 3 days'],
  ])('says %i ms from now as %s', (offset, words) => {
    expect(relativeTime(NOW + offset, NOW)).toBe(words);
  });

  it.each<[string, number | null]>([
    ['20261008T193000Z.json.enc', Date.UTC(2026, 9, 8, 19, 30, 0)],
    ['20260101T000000Z.json.enc', Date.UTC(2026, 0, 1)],
    ['20260115T093000Z.json', null],
    ['2026-01-15.json.enc', null],
    ['../20260115T093000Z.json.enc', null],
    ['', null],
  ])('reads the time in the name %s', (name, at) => {
    expect(manifestTime(name)).toBe(at);
  });

  it('has no time for what is not a name', () => {
    expect(manifestTime(null)).toBeNull();
    expect(manifestTime(undefined)).toBeNull();
  });

  it.each<[number, string]>([
    [1, '1 second'], [30, '30 seconds'], [59.2, '60 seconds'], [60, '1 minute'], [61, '2 minutes'], [600, '10 minutes'], [3600, '1 hour'], [7300, '3 hours'],
  ])('waits %i seconds as %s', (seconds, words) => {
    expect(waitLabel(seconds)).toBe(words);
  });

  it('waits "a few minutes" when it is not told how long', () => {
    for (const bad of [0, -3, NaN, null, undefined]) expect(waitLabel(bad as never)).toBe('a few minutes');
  });
});

describe('sizes and intervals', () => {
  it.each<[number, string]>([
    [0, '0 B'], [1, '1 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'], [10 * 1024, '10 KB'], [1_048_575, '1 MB'], [4_823_552, '4.6 MB'],
    [12 * 1024 ** 2, '12 MB'], [21 * 1024 ** 3, '21 GB'], [1024 ** 4, '1 TB'], [5000 * 1024 ** 4, '5000 TB'],
  ])('writes %i bytes as %s', (bytes, words) => {
    expect(formatSize(bytes)).toBe(words);
  });

  it('writes "unknown" for what is not a size', () => {
    for (const bad of [-1, NaN, Infinity, null, undefined, '5' as never]) expect(formatSize(bad as never)).toBe('unknown');
  });

  it.each<[number | null, string]>([
    [5, 'Every 5 minutes'], [45, 'Every 45 minutes'], [60, 'Every hour'], [120, 'Every 2 hours'], [90, 'Every 90 minutes'], [1440, 'Every day'], [2880, 'Every 2 days'],
    [10080, 'Every 7 days'], [0, 'unknown'], [null, 'unknown'],
  ])('writes an interval of %s minutes as %s', (minutes, words) => {
    expect(intervalLabel(minutes)).toBe(words);
  });

  it('shortens a key id to 8 characters', () => {
    expect(shortKey('a1b2c3d4')).toBe('a1b2c3d4');
    expect(shortKey('a1b2c3d4e5f6')).toBe('a1b2c3d4');
    expect(shortKey('')).toBe('unknown');
    expect(shortKey(null)).toBe('unknown');
  });
});

describe('the error table', () => {
  const BRIEF = [
    'not_enough_space', 'safety_backup_failed', 'confirmation_mismatch', 'rate_limited', 'restore_in_progress', 'board_not_in_backup', 'read_only', 'backups_off',
    'manifest_not_found', 'unknown_key', 'tamper', 'invalid_path', 'unexpected_file', 'duplicate_path', 'no_directory', 'forbidden',
  ];
  // every code the backup routes can answer (docs/backups.md, Routes)
  const SERVER = [
    'bad_request', 'confirmation_mismatch', 'read_only', 'forbidden', 'manifest_not_found', 'board_not_in_backup', 'backups_off', 'restore_in_progress', 'rate_limited',
    'unknown_key', 'tamper', 'content_mismatch', 'invalid_manifest', 'invalid_path', 'unexpected_file', 'duplicate_path', 'size_mismatch', 'backup_incomplete', 'no_directory',
    'invalid_backup', 'schema_too_new', 'integrity_check_failed', 'no_active_owner', 's3', 'network', 'timeout', 'safety_backup_failed', 'not_enough_space', 'space_unknown',
    'restore_failed', 'bad_format', 'too_large', 'restoring', 'unauthenticated',
  ];

  it('has a sentence for every code of the brief and every code the server answers', () => {
    for (const code of [...BRIEF, ...SERVER]) expect(ERROR_CODES, `${code}`).toContain(code);
  });

  it.each([...new Set([...BRIEF, ...SERVER])])('%s is a plain sentence that never shows the code', (code) => {
    const sentence = errorSentence(code, { needed: 3 * 1024 ** 3, free: 1024 ** 3, retryAfter: 90 });
    expect(sentence.length).toBeGreaterThan(20);
    expect(sentence.endsWith('.')).toBe(true);
    expect(sentence).not.toContain(code);
    expect(sentence).not.toMatch(/[a-z]+_[a-z_]+/);
    expect(errorReason(code).length).toBeGreaterThan(5);
    expect(errorReason(code)).not.toMatch(/[a-z]+_[a-z_]+/);
  });

  it('uses the facts: room needed and free, and when to try again', () => {
    expect(errorSentence('not_enough_space', { needed: 3 * 1024 ** 3, free: 1024 ** 3 })).toBe(
      'There is not enough free disk space on the server (3 GB needed, 1 GB free). Free some space and try again.',
    );
    expect(errorSentence('not_enough_space')).toBe('There is not enough free disk space on the server. Free some space and try again.');
    expect(errorSentence('not_enough_space', { needed: 'lots', free: null })).toBe('There is not enough free disk space on the server. Free some space and try again.');
    expect(errorSentence('rate_limited', { retryAfter: 600 })).toBe('Too many tries in a short time. Try again in 10 minutes.');
    expect(errorSentence('rate_limited', { retryAfter: 45 })).toBe('Too many tries in a short time. Try again in 45 seconds.');
    expect(errorSentence('rate_limited')).toBe('Too many tries in a short time. Try again in a few minutes.');
    expect(errorSentence('confirmation_mismatch')).toContain(CONFIRM_WORD);
  });

  it('has a fallback for any other code, and for no code, that is not the code', () => {
    for (const other of ['something_new', 'unknown', '', null, undefined, 'toString', '__proto__', 'constructor']) {
      const sentence = errorSentence(other);
      expect(sentence).toBe('Something went wrong with the backups. Try again, and look at the server log if it keeps happening.');
      expect(errorReason(other)).toBe('it could not be read');
    }
  });

  it('has its own sentence for a lost connection', () => {
    expect(errorSentence('network')).toBe('Could not reach the server. Check your connection and try again.');
  });
});

describe('the list', () => {
  const row = (patch: Partial<BackupSummary> = {}): BackupSummary => ({ name: NAME, createdAt: NOW - 30 * MIN, protected: false, protectedUntil: null, readable: true, files: 14, bytes: 4_823_552, keyId: 'a1b2c3d4', ...patch });

  it('notes a protected backup with the date the protection ends', () => {
    expect(noteOf(row({ protected: true, protectedUntil: Date.UTC(2026, 0, 21, 10) }))).toBe('Protected until 2026-01-21');
    expect(noteOf(row({ protected: true, protectedUntil: null }))).toBe('Protected');
    expect(noteOf(row())).toBe('');
  });

  it('notes an unreadable backup with the reason, and does not let it be selected', () => {
    const lost = row({ readable: false, error: 'unknown_key', files: undefined });
    expect(noteOf(lost)).toBe('Unreadable: the encryption key is not available');
    expect(noteOf(row({ readable: false, error: 'tamper' }))).toBe('Unreadable: it failed its integrity check');
    expect(noteOf(row({ readable: false, error: 'a_code_from_the_future' }))).toBe('Unreadable: it could not be read');
    expect(noteOf(row({ readable: false }))).toBe('Unreadable: it could not be read');
    expect(selectable(lost)).toBe(false);
    expect(selectable(row())).toBe(true);
  });

  it('puts the unreadable note before a protection', () => {
    expect(noteOf(row({ readable: false, error: 'tamper', protected: true, protectedUntil: NOW }))).toMatch(/^Unreadable/);
  });
});

describe('the status block', () => {
  const status = (patch: Partial<BackupEngineStatus> = {}): BackupEngineStatus => ({
    lastSuccessAt: NOW - 30 * MIN, lastFailureAt: null, lastFailureError: null, consecutiveFailures: 0, nextRunAt: NOW + 30 * MIN, running: false,
    target: 's3', intervalMinutes: 60, keyId: 'a1b2c3d4', bytesStored: 18_874_368, objects: 52, manifests: 7, ...patch,
  });
  const byLabel = (rows: ReturnType<typeof statusRows>) => Object.fromEntries(rows.map((r) => [r.label, r]));

  it('says when the last backup was and that it worked', () => {
    const rows = byLabel(statusRows(status(), NOW));
    expect(rows['Last backup'].value).toBe('2026-01-15 09:30 UTC · 30 minutes ago');
    expect(rows.Result).toMatchObject({ badge: 'Succeeded', value: 'Everything was copied' });
    expect(rows['Failures in a row'].value).toBe('0');
    expect(rows['Next backup'].value).toBe('2026-01-15 10:30 UTC · in 30 minutes');
    expect(rows['How often'].value).toBe('Every hour');
    expect(rows.Target.value).toBe('S3 bucket');
    expect(rows.Key.value).toBe('a1b2c3d4');
    expect(rows.Stored.value).toBe('18 MB · 7 backups · 52 files');
  });

  it('says when the last backup failed, why, and when one last worked', () => {
    const rows = byLabel(statusRows(status({ lastFailureAt: NOW - 5 * MIN, lastFailureError: 'S3 PUT failed (status 403, AccessDenied)', consecutiveFailures: 3 }), NOW));
    expect(rows['Last backup'].value).toBe('2026-01-15 09:55 UTC · 5 minutes ago');
    expect(rows.Result).toMatchObject({ badge: 'Failed', note: 'S3 PUT failed (status 403, AccessDenied)' });
    expect(rows.Result.value).toBe('The last one that worked was 2026-01-15 09:30 UTC · 30 minutes ago');
    expect(rows['Failures in a row'].value).toBe('3');
  });

  it('calls a success after a failure a success', () => {
    const rows = byLabel(statusRows(status({ lastFailureAt: NOW - 2 * HOUR, lastFailureError: 'old' }), NOW));
    expect(rows.Result.badge).toBe('Succeeded');
    expect(rows.Result.note).toBeUndefined();
  });

  it('says so when nothing has worked yet', () => {
    const failing = byLabel(statusRows(status({ lastSuccessAt: null, lastFailureAt: NOW - HOUR, lastFailureError: null, consecutiveFailures: 1 }), NOW));
    expect(failing.Result).toMatchObject({ badge: 'Failed', value: 'No backup has worked yet' });
    const fresh = statusRows(status({ lastSuccessAt: null, bytesStored: 0, objects: 0, manifests: 0 }), NOW);
    expect(fresh.map((r) => r.label)).not.toContain('Result');
    expect(byLabel(fresh)['Last backup'].value).toBe('No backup yet');
    expect(byLabel(fresh).Stored.value).toBe('0 B · 0 backups · 0 files');
  });

  it('says when a run is going on and when none is scheduled', () => {
    expect(byLabel(statusRows(status({ running: true, nextRunAt: null }), NOW))['Next backup'].value).toBe('Running now');
    expect(byLabel(statusRows(status({ nextRunAt: null }), NOW))['Next backup'].value).toBe('Not scheduled');
  });

  it('shows the directory target without referring to a bucket', () => {
    const rows = byLabel(statusRows(status({ target: 'dir' }), NOW));
    expect(rows.Target.value).toBe('Directory');
  });

  it('copes with a status that holds nothing yet', () => {
    const empty: BackupEngineStatus = {
      lastSuccessAt: null, lastFailureAt: null, lastFailureError: null, consecutiveFailures: null, nextRunAt: null, running: null, intervalMinutes: null, keyId: null,
      target: null, bytesStored: null, objects: null, manifests: null,
    };
    const rows = byLabel(statusRows(empty, NOW));
    expect(rows['Failures in a row'].value).toBe('0');
    expect(rows['How often'].value).toBe('unknown');
    expect(rows.Key.value).toBe('unknown');
    expect(rows.Stored.value).toBe('unknown · 0 backups · 0 files');
  });
});

describe('the sentence about the last restore', () => {
  it('is null when there has been none', () => {
    expect(lastRestoreSentence(null)).toBeNull();
    expect(lastRestoreSentence(undefined)).toBeNull();
  });

  it('says a whole restore is done, from which backup and when', () => {
    expect(lastRestoreSentence({ kind: 'workspace', result: 'done', at: NOW, manifest: '20260112T100000Z.json.enc' })).toBe(
      'The whole workspace was restored from the backup of 2026-01-12 10:00 UTC on 2026-01-15 10:00 UTC.',
    );
  });

  it('says a board copy is done', () => {
    expect(lastRestoreSentence({ kind: 'board', result: 'done', at: NOW, manifest: NAME })).toBe('A board was restored as a copy from the backup of 2026-01-15 09:30 UTC on 2026-01-15 10:00 UTC.');
  });

  it('says a restore failed with the reason in words', () => {
    expect(lastRestoreSentence({ kind: 'workspace', result: 'failed', at: NOW, manifest: NAME, error: 'not_enough_space' })).toBe(
      'Restoring the whole workspace from the backup of 2026-01-15 09:30 UTC failed on 2026-01-15 10:00 UTC: not enough free disk space.',
    );
    expect(lastRestoreSentence({ kind: 'board', result: 'failed', at: NOW, manifest: NAME, error: 'board_not_in_backup' })).toBe(
      'Restoring a board as a copy from the backup of 2026-01-15 09:30 UTC failed on 2026-01-15 10:00 UTC: the board is not in the backup.',
    );
    expect(lastRestoreSentence({ kind: 'workspace', result: 'failed', at: NOW, manifest: NAME, error: 'interrupted' })).toContain('failed on');
    expect(lastRestoreSentence({ kind: 'workspace', result: 'failed', at: NOW, manifest: NAME })).toContain('it could not be read');
  });

  it('copes with a record that has no time or no backup name', () => {
    expect(lastRestoreSentence({ kind: 'workspace', result: 'done', at: null, manifest: null })).toBe('The whole workspace was restored from a backup.');
  });
});

describe('the screens', () => {
  const list: Screen = { name: 'list' };
  const detail: Screen = { name: 'detail', manifest: NAME };

  it('goes list, detail, board copy or confirmation, and back one step at a time', () => {
    const opened = nextScreen(list, { type: 'open', manifest: NAME });
    expect(opened).toEqual(detail);
    expect(nextScreen(opened, { type: 'copy' })).toEqual({ name: 'board', manifest: NAME });
    expect(nextScreen(opened, { type: 'whole' })).toEqual({ name: 'confirm', manifest: NAME });
    expect(nextScreen({ name: 'board', manifest: NAME }, { type: 'back' })).toEqual(detail);
    expect(nextScreen({ name: 'confirm', manifest: NAME }, { type: 'back' })).toEqual(detail);
    expect(nextScreen(detail, { type: 'back' })).toEqual(list);
  });

  it('ignores an event that does not fit the screen', () => {
    expect(nextScreen(list, { type: 'back' })).toBe(list);
    expect(nextScreen(list, { type: 'copy' })).toBe(list);
    expect(nextScreen(list, { type: 'whole' })).toBe(list);
    expect(nextScreen(detail, { type: 'open', manifest: 'x' })).toBe(detail);
    const board: Screen = { name: 'board', manifest: NAME };
    expect(nextScreen(board, { type: 'whole' })).toBe(board);
    expect(nextScreen(board, { type: 'copy' })).toBe(board);
    const confirm: Screen = { name: 'confirm', manifest: NAME };
    expect(nextScreen(confirm, { type: 'copy' })).toBe(confirm);
  });

  it('goes to the restoring screen from anywhere, and never leaves it', () => {
    for (const screen of [list, detail, { name: 'board', manifest: NAME }, { name: 'confirm', manifest: NAME }] as Screen[]) {
      expect(nextScreen(screen, { type: 'restoring' })).toEqual({ name: 'restoring' });
    }
    const restoring: Screen = { name: 'restoring' };
    for (const event of [{ type: 'back' }, { type: 'copy' }, { type: 'whole' }, { type: 'open', manifest: NAME }, { type: 'restoring' }] as const) {
      expect(nextScreen(restoring, event)).toBe(restoring);
    }
  });
});

describe('the confirmation of a whole restore', () => {
  const preview = (enough = true) => ({ confirmWord: 'RESTORE', space: { needed: 3 * 1024 ** 3, free: enough ? 20 * 1024 ** 3 : 1024 ** 3, enough } });

  it.each<[string, boolean]>([
    ['RESTORE', true], ['restore', false], ['Restore', false], ['RESTORE ', false], [' RESTORE', false], ['RESTOR', false], ['RESTOREE', false], ['', false],
    ['R E S T O R E', false], ['RESTORE\n', false], ['ＲＥＳＴＯＲＥ', false], ['RESTORE​', false],
  ])('%j matches: %s', (typed, ok) => {
    expect(confirmMatches(typed)).toBe(ok);
  });

  it('is the word the server sends when it sends one', () => {
    expect(confirmMatches('GO', 'GO')).toBe(true);
    expect(confirmMatches('RESTORE', 'GO')).toBe(false);
  });

  it('opens the button only for the exact word and enough room, and says why not', () => {
    expect(restoreGate('RESTORE', preview())).toEqual({ allowed: true, reason: '' });
    expect(restoreGate('', preview())).toEqual({ allowed: false, reason: 'Type RESTORE in capital letters to enable the button.' });
    expect(restoreGate('restore', preview()).allowed).toBe(false);
    expect(restoreGate('RESTORE ', preview()).allowed).toBe(false);
  });

  it('keeps the button shut when there is not enough room, even with the right word, and says how much', () => {
    const gate = restoreGate('RESTORE', preview(false));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('There is not enough free disk space to restore this backup (3 GB needed, 1 GB free). Free some space first.');
    expect(restoreGate('', preview(false)).reason).toBe(gate.reason);
  });

  it('falls back to RESTORE when the preview has no word', () => {
    expect(restoreGate('RESTORE', { confirmWord: '', space: preview().space }).allowed).toBe(true);
  });
});

describe('what a failed start of a restore means', () => {
  it.each<[number, string, boolean, 'watch' | 'error']>([
    [0, 'network', false, 'watch'],
    [0, 'unknown', false, 'watch'],
    [503, 'restoring', false, 'watch'],
    [502, 'unknown', false, 'watch'],
    [504, 'unknown', false, 'watch'],
    [503, 'unknown', false, 'watch'],
    [500, 'restore_failed', true, 'watch'],
    [502, 'safety_backup_failed', false, 'error'],
    [507, 'not_enough_space', false, 'error'],
    [400, 'confirmation_mismatch', false, 'error'],
    [409, 'restore_in_progress', false, 'error'],
    [429, 'rate_limited', false, 'error'],
    [500, 'restore_failed', false, 'error'],
    [403, 'forbidden', false, 'error'],
    [503, 'ai_unavailable', false, 'error'],
  ])('%i %s (restarting %s) is %s', (status, code, restarting, outcome) => {
    expect(submitOutcome(status, code, restarting)).toBe(outcome);
  });
});

describe('the shared api client', () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers },
      })) as unknown as typeof fetch;

  it('tells the app when the server says it is restoring, and still fails the call as before', async () => {
    const onRestoring = vi.fn<() => void>();
    const err = await createApi(answer(503, { error: 'restoring', message: 'Try again in a minute.' }), { onRestoring }).me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'restoring', message: 'Try again in a minute.' });
    expect(onRestoring).toHaveBeenCalledTimes(1);
  });

  it('sees it on a binary read too', async () => {
    const onRestoring = vi.fn<() => void>();
    await expect(createApi(answer(503, { error: 'restoring' }), { onRestoring }).versionState('b1', 'v1')).rejects.toMatchObject({ code: 'restoring' });
    expect(onRestoring).toHaveBeenCalledTimes(1);
  });

  it.each<[string, number, unknown]>([
    ['ai_unavailable', 503, { error: 'ai_unavailable', message: 'AI is not available' }],
    ['a gateway page with an HTML body', 503, '<html>Service Unavailable</html>'],
    ['another JSON error', 503, { error: 'overloaded' }],
    ['a 502 that says restoring', 502, { error: 'restoring' }],
    ['a plain 500', 500, { error: 'internal' }],
    ['a 401', 401, { error: 'unauthenticated' }],
  ])('does not take %s for a restore', async (_what, status, body) => {
    const onRestoring = vi.fn<() => void>();
    await expect(createApi(answer(status, body), { onRestoring }).me()).rejects.toBeInstanceOf(ApiError);
    expect(onRestoring).not.toHaveBeenCalled();
  });

  it('does not take a success for a restore', async () => {
    const onRestoring = vi.fn<() => void>();
    await createApi(answer(200, { authEnabled: true }), { onRestoring }).config();
    expect(onRestoring).not.toHaveBeenCalled();
  });

  it('does not let a failing listener change the error', async () => {
    const onRestoring = vi.fn<() => void>(() => {
      throw new Error('listener broke');
    });
    await expect(createApi(answer(503, { error: 'restoring', message: 'x' }), { onRestoring }).me()).rejects.toMatchObject({ code: 'restoring', message: 'x' });
  });

  it('tells the listeners of the app by default', async () => {
    const { onRestoring } = await import('../src/api');
    const heard = vi.fn<() => void>();
    const off = onRestoring(heard);
    await createApi(answer(503, { error: 'restoring' })).me().catch(() => undefined);
    off();
    await createApi(answer(503, { error: 'restoring' })).me().catch(() => undefined);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('keeps the plain facts of an error answer, and the wait from Retry-After', async () => {
    const full = await createApi(answer(507, { error: 'not_enough_space', message: 'No room', needed: 3_000_000_000, free: 100, nested: { a: 1 }, long: 'x'.repeat(500) })).restoreBackup(NAME, 'RESTORE').catch((e: unknown) => e);
    expect(full).toMatchObject({ status: 507, code: 'not_enough_space', facts: { needed: 3_000_000_000, free: 100 } });
    expect((full as ApiError).facts).not.toHaveProperty('nested');
    expect((full as ApiError).facts).not.toHaveProperty('long');
    expect((full as ApiError).facts).not.toHaveProperty('error');
    const limited = await createApi(answer(429, { error: 'rate_limited', message: 'Slow down' }, { 'retry-after': '600' })).adminBackupBoards(NAME).catch((e: unknown) => e);
    expect(limited).toMatchObject({ status: 429, code: 'rate_limited', facts: { retryAfter: 600 } });
    expect(errorSentence((limited as ApiError).code, (limited as ApiError).facts)).toBe('Too many tries in a short time. Try again in 10 minutes.');
    const bare = await createApi(answer(403, { error: 'forbidden' })).adminBackups().catch((e: unknown) => e);
    expect((bare as ApiError).facts).toEqual({});
    expect(new ApiError(0, 'network', 'network').facts).toEqual({});
  });

  it('calls the backup routes with the right method, address, body and header', async () => {
    const calls: { url: string; method?: string; body?: unknown; csrf?: string }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: ((init?.headers ?? {}) as Record<string, string>)['x-tabula'] });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const api = createApi(fetchFn);
    await api.adminBackups();
    await api.adminBackup(NAME);
    await api.adminBackupBoards(NAME);
    await api.restoreBackupBoard(NAME, 'b1');
    await api.restoreBackup(NAME, 'RESTORE');
    expect(calls).toEqual([
      { url: '/api/admin/backups', method: 'GET', csrf: undefined },
      { url: `/api/admin/backups/${NAME}`, method: 'GET', csrf: undefined },
      { url: `/api/admin/backups/${NAME}/boards`, method: 'GET', csrf: undefined },
      { url: '/api/admin/backups/restore-board', method: 'POST', body: { manifest: NAME, boardId: 'b1' }, csrf: '1' },
      { url: '/api/admin/backups/restore', method: 'POST', body: { manifest: NAME, confirm: 'RESTORE' }, csrf: '1' },
    ]);
    await api.adminBackup('a/b c');
    expect(calls.at(-1)!.url).toBe('/api/admin/backups/a%2Fb%20c');
  });
});

describe('polling the server', () => {
  it('starts at 2 seconds, grows by half each time and stops growing at 15', () => {
    expect([POLL_START_MS, POLL_FACTOR, POLL_CAP_MS, POLL_GIVE_UP_MS]).toEqual([2000, 1.5, 15_000, 180_000]);
    expect(pollDelays(10)).toEqual([2000, 3000, 4500, 6750, 10_125, 15_000, 15_000, 15_000, 15_000, 15_000]);
    expect(nextPollDelay(null)).toBe(2000);
    expect(nextPollDelay(2000)).toBe(3000);
    expect(nextPollDelay(10_125)).toBe(15_000);
    expect(nextPollDelay(15_000)).toBe(15_000);
    expect(pollDelays(0)).toEqual([]);
  });

  it('never asks faster than every 2 seconds', () => {
    expect(Math.min(...pollDelays(200))).toBe(2000);
  });

  it.each<[number | null, unknown, string]>([
    [200, { ok: true, rooms: 0, connections: 0 }, 'ready'],
    [200, { ok: true, restoring: true }, 'restoring'],
    [200, { ok: true, restoring: false }, 'ready'],
    [200, { ok: false }, 'down'],
    [200, {}, 'down'],
    [200, null, 'down'],
    [200, 'ok', 'down'],
    [200, ['ok'], 'down'],
    [204, { ok: true }, 'ready'],
    [502, { ok: true }, 'down'],
    [503, { ok: true, restoring: true }, 'down'],
    [404, null, 'down'],
    [301, { ok: true }, 'down'],
    [null, null, 'down'],
  ])('reads %s %j as %s', (status, body, verdict) => {
    expect(classifyHealth(status, body)).toBe(verdict);
  });

  it('reloads on its own once, not twice in a row', () => {
    expect(RELOAD_GUARD_MS).toBe(20_000);
    expect(mayReload(null, NOW)).toBe(true);
    expect(mayReload(NOW - 5000, NOW)).toBe(false);
    expect(mayReload(NOW - 19_999, NOW)).toBe(false);
    expect(mayReload(NOW - 20_000, NOW)).toBe(true);
    expect(mayReload(NOW + 5000, NOW)).toBe(true);
    expect(mayReload(NaN, NOW)).toBe(true);
  });
});

describe('the watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  type Answer = { status: number | null; data: unknown } | 'throw' | 'hang';
  const ready = { status: 200, data: { ok: true } };
  const restoring = { status: 200, data: { ok: true, restoring: true } };
  const down = { status: 502, data: null };

  function rig(answers: Answer[]) {
    const asked: number[] = [];
    const waiting: [string, number][] = [];
    const onReady = vi.fn<() => void>();
    const onSlow = vi.fn<() => void>();
    let i = 0;
    const deps: WatchDeps = {
      probe: () => {
        asked.push(Date.now() - NOW);
        const next = answers[Math.min(i++, answers.length - 1)];
        if (next === 'throw') return Promise.reject(new Error('refused'));
        if (next === 'hang') return new Promise(() => undefined);
        return Promise.resolve(next);
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      onReady,
      onWaiting: (verdict, attempt) => waiting.push([verdict, attempt]),
      onSlow,
    };
    return { watcher: watchServer(deps), asked, waiting, onReady, onSlow };
  }

  it('asks first after 2 seconds, with growing waits, and reloads on the first healthy answer', async () => {
    const r = rig([restoring, down, 'throw', ready]);
    r.watcher.start();
    await vi.advanceTimersByTimeAsync(1999);
    expect(r.asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.asked).toEqual([2000]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.asked).toEqual([2000, 5000, 9500, 16_250]);
    expect(r.onReady).toHaveBeenCalledTimes(1);
    expect(r.onSlow).not.toHaveBeenCalled();
    expect(r.waiting).toEqual([['restoring', 1], ['down', 2], ['down', 3]]);
    expect(r.watcher.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.asked).toHaveLength(4);
  });

  it('keeps asking while the server says it is restoring or does not answer', async () => {
    const r = rig([restoring]);
    r.watcher.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.onReady).not.toHaveBeenCalled();
    expect(r.asked.length).toBeGreaterThan(5);
    expect(r.watcher.running()).toBe(true);
    r.watcher.stop();
  });

  it('asks at the schedule, never closer than the wait before, and one question at a time', async () => {
    const r = rig([down]);
    r.watcher.start();
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS);
    const gaps = r.asked.slice(1).map((at, i) => at - r.asked[i]);
    expect([r.asked[0], ...gaps]).toEqual(pollDelays(r.asked.length));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3000);
    expect(r.asked.length).toBeLessThan(20);
  });

  it('gives up after three minutes and says so once', async () => {
    const r = rig([down]);
    r.watcher.start();
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS - 1);
    expect(r.onSlow).not.toHaveBeenCalled();
    expect(r.watcher.running()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.onSlow).toHaveBeenCalledTimes(1);
    expect(r.watcher.running()).toBe(false);
    const asked = r.asked.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.asked).toHaveLength(asked);
    expect(r.onSlow).toHaveBeenCalledTimes(1);
    expect(r.onReady).not.toHaveBeenCalled();
  });

  it('does not reload when the answer comes after it gave up', async () => {
    const r = rig(['hang']);
    r.watcher.start();
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS + 1000);
    expect(r.onSlow).toHaveBeenCalledTimes(1);
    expect(r.onReady).not.toHaveBeenCalled();
  });

  it('starts again from the first wait when asked to retry', async () => {
    const r = rig([down, down, down, down, down, down, down, down, down, down, down, down, down, down, down, down, down, down, down, down, down, ready]);
    r.watcher.start();
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS);
    expect(r.onSlow).toHaveBeenCalledTimes(1);
    const before = r.asked.length;
    const at = Date.now() - NOW;
    r.watcher.start();
    await vi.advanceTimersByTimeAsync(1999);
    expect(r.asked).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.asked.at(-1)! - at).toBe(2000);
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS);
    expect(r.onReady).toHaveBeenCalledTimes(1);
    expect(r.onSlow).toHaveBeenCalledTimes(1);
  });

  it('a second start does not double the questions', async () => {
    const r = rig([down]);
    r.watcher.start();
    r.watcher.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.asked).toEqual([2000]);
    r.watcher.stop();
  });

  it('stops for good when told to, even with a question on its way', async () => {
    const r = rig([ready]);
    r.watcher.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.onReady).toHaveBeenCalledTimes(1);
    const late = rig([ready]);
    late.watcher.start();
    await vi.advanceTimersByTimeAsync(1999);
    late.watcher.stop();
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS);
    expect(late.asked).toEqual([]);
    expect(late.onReady).not.toHaveBeenCalled();
    expect(late.onSlow).not.toHaveBeenCalled();
  });
});

describe('who sees the tab', () => {
  it('lists Backups for owners only, in the place before the audit log', () => {
    const owner = visibleAdminTabs(ADMIN_TABS, undefined, 'owner');
    expect(owner).toContain('backups');
    expect(owner.indexOf('backups')).toBe(owner.indexOf('audit') - 1);
    for (const role of ['admin', 'member', 'guest', undefined] as const) {
      expect(visibleAdminTabs(ADMIN_TABS, true, role), `${role}`).not.toContain('backups');
    }
  });

  it('lists it for an owner whether or not backups are on, and whether or not AI tool access is', () => {
    expect(visibleAdminTabs(ADMIN_TABS, false, 'owner')).toContain('backups');
    expect(visibleAdminTabs(ADMIN_TABS, true, 'owner')).toContain('backups');
  });
});
