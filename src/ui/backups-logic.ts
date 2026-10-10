import type { BackupEngineStatus, BackupPreview, BackupSummary, RestoreRecord } from '../api';

/** Pure rules and text for the Backups tab and the restoring screen: no DOM, so they can be unit tested (docs/backups.md, "In the app"). */

/** What the owner types to confirm a whole restore (the server sends the same word in a preview). */
export const CONFIRM_WORD = 'RESTORE';
/** The server lists at most this many backups. */
export const LIST_CAP = 200;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// ---------------------------------------------------------------- times, sizes and counts

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `2026-10-08 19:30 UTC`. Backups are named in UTC, so the list reads the same for everyone. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** `2026-10-08` */
export function formatUtcDate(ms: number): string {
  return formatUtc(ms).slice(0, 10);
}

const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "3 hours ago", "in 42 minutes", "just now". Whole units, rounded down. */
export function relativeTime(ms: number, now: number): string {
  const seconds = Math.floor(Math.abs(ms - now) / 1000);
  const past = ms <= now;
  if (seconds < 45) return past ? 'just now' : 'in less than a minute';
  const minutes = Math.max(1, Math.floor(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  let span: string;
  if (minutes < 60) span = unit(minutes, 'minute');
  else if (hours < 48) span = unit(hours, 'hour');
  else if (days < 60) span = unit(days, 'day');
  else span = unit(Math.floor(days / 30), 'month');
  return past ? `${span} ago` : `in ${span}`;
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** "512 B", "1.5 KB", "12 MB". 1024 per step; one decimal below 10. */
export function formatSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let i = Math.min(SIZE_UNITS.length - 1, Math.floor(Math.log2(bytes) / 10));
  const shown = (at: number) => {
    const value = bytes / 1024 ** at;
    return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  };
  if (shown(i) >= 1024 && i < SIZE_UNITS.length - 1) i++;
  return `${shown(i)} ${SIZE_UNITS[i]}`;
}

/** "Every 15 minutes", "Every hour", "Every 6 hours", "Every day". */
export function intervalLabel(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1) return 'unknown';
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** The key id as the list shows it: the first 8 characters. */
export function shortKey(id: string | null | undefined): string {
  return typeof id === 'string' && id ? id.slice(0, 8) : 'unknown';
}

/** How long to wait, in words: "30 seconds", "10 minutes", "2 hours". */
export function waitLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 'a few minutes';
  if (seconds < 60) return unit(Math.ceil(seconds), 'second');
  if (seconds < 3600) return unit(Math.ceil(seconds / 60), 'minute');
  return unit(Math.ceil(seconds / 3600), 'hour');
}

const MANIFEST_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.enc$/;

/** The time in the name of a backup (`20261008T193000Z.json.enc`), or null when the name is not one. */
export function manifestTime(name: string | null | undefined): number | null {
  const m = typeof name === 'string' ? MANIFEST_NAME_RE.exec(name) : null;
  if (!m) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(at) ? at : null;
}

// ---------------------------------------------------------------- errors, in one place

export interface ErrorFacts {
  needed?: unknown;
  free?: unknown;
  retryAfter?: unknown;
}

interface Entry {
  /** A fragment that reads after "Unreadable:" and "failed:". */
  reason: string;
  sentence: (facts: ErrorFacts) => string;
}

const text = (reason: string, sentence: string): Entry => ({ reason, sentence: () => sentence });

const DAMAGED = text('it failed its integrity check', 'This backup failed its integrity check. It may be damaged or changed, so it cannot be used.');
const STORAGE = text('the storage did not answer', 'The backup storage did not answer as expected. Check that it is reachable, then try again.');
const UNUSABLE = text('it cannot be used', 'This backup cannot be used.');

const ENTRIES: Record<string, Entry> = {
  not_enough_space: {
    reason: 'not enough free disk space',
    sentence: ({ needed, free }) => {
      const room = typeof needed === 'number' && typeof free === 'number' ? ` (${formatSize(needed)} needed, ${formatSize(free)} free)` : '';
      return `There is not enough free disk space on the server${room}. Free some space and try again.`;
    },
  },
  safety_backup_failed: text('the safety backup failed', 'The backup of the current data that comes before a restore could not be made, so nothing was changed. Check that the backup storage is reachable, then try again.'),
  confirmation_mismatch: text('the confirmation did not match', `The confirmation did not match. Type ${CONFIRM_WORD} exactly, in capital letters.`),
  rate_limited: {
    reason: 'too many tries in a short time',
    sentence: ({ retryAfter }) => `Too many tries in a short time. Try again in ${waitLabel(typeof retryAfter === 'number' ? retryAfter : null)}.`,
  },
  restore_in_progress: text('another restore was running', 'A restore is already running. Wait until it is done, then try again.'),
  board_not_in_backup: text('the board is not in the backup', 'That board is not in this backup, or it has no saved content there.'),
  read_only: text('the workspace is read-only', 'This workspace is read-only, so a copy cannot be added right now. Check billing to make it writable again.'),
  backups_off: text('backups are not set up', 'Backups are not set up on this server.'),
  manifest_not_found: text('the backup is no longer in the storage', 'That backup is no longer in the storage. Reload the list and pick another one.'),
  unknown_key: text(
    'the encryption key is not available',
    'This backup was sealed with an encryption key this server does not have, so it cannot be read. If the key was changed, the old one has to stay available as the previous key.',
  ),
  tamper: DAMAGED,
  invalid_path: text('it lists a path Tabula does not accept', 'This backup lists a file with a path Tabula does not accept, so it cannot be used.'),
  unexpected_file: text('it holds a file Tabula did not write', 'This backup holds a file that Tabula did not write, so it cannot be used.'),
  duplicate_path: text('it lists a file twice', 'This backup lists the same file twice, so it cannot be used.'),
  no_directory: text('it has no workspace database', 'This backup has no workspace database (it was made without accounts), so it cannot be restored here.'),
  forbidden: text('only the workspace owner can do that', 'Only the workspace owner can do that.'),
  // Not in the brief, but the server can answer them: each gets a sentence of its own instead of the fallback.
  content_mismatch: DAMAGED,
  size_mismatch: DAMAGED,
  bad_format: DAMAGED,
  invalid_manifest: DAMAGED,
  invalid_backup: UNUSABLE,
  integrity_check_failed: text('its database failed a check', 'The database in this backup failed a check, so nothing was changed.'),
  backup_incomplete: text('a file of it is missing from the storage', 'A file of this backup is missing from the storage, so it cannot be restored.'),
  schema_too_new: text('it was made by a newer Tabula', 'This backup was made by a newer version of Tabula. Update Tabula first, then restore it.'),
  no_active_owner: text('every owner in it is disabled', 'Every owner in this backup is disabled, so nobody could manage the workspace after a restore.'),
  space_unknown: text('the free disk space is not known', 'The free disk space could not be determined, so nothing was changed.'),
  s3: STORAGE,
  timeout: STORAGE,
  too_large: STORAGE,
  restore_failed: text('the restore failed', 'The restore failed. If it keeps failing, look at the server log.'),
  network: text('the server did not answer', 'Could not reach the server. Check your connection and try again.'),
  restoring: text('the workspace is being restored', 'The workspace is being restored from a backup. Try again in a minute.'),
  bad_request: text('the request was not valid', 'That request was not valid. Reload the page and try again.'),
  unauthenticated: text('you are signed out', 'Your session has ended. Sign in again.'),
};

const FALLBACK: Entry = text('it could not be read', 'Something went wrong with the backups. Try again, and look at the server log if it keeps happening.');

const entryOf = (code: string | null | undefined): Entry => (typeof code === 'string' && Object.hasOwn(ENTRIES, code) ? ENTRIES[code] : FALLBACK);

/** A plain sentence for an error code the backup routes answer; never the code itself. */
export function errorSentence(code: string | null | undefined, facts: ErrorFacts = {}): string {
  return entryOf(code).sentence(facts);
}

/** A short fragment for the same code, to read after "Unreadable:" or "failed:". */
export function errorReason(code: string | null | undefined): string {
  return entryOf(code).reason;
}

/** Every code that has a sentence of its own. */
export const ERROR_CODES: readonly string[] = Object.keys(ENTRIES);

// ---------------------------------------------------------------- the list

/** The Notes column: when the backup is protected from pruning, or why it cannot be used. Empty when there is nothing to say. */
export function noteOf(backup: BackupSummary): string {
  if (!backup.readable) return `Unreadable: ${errorReason(backup.error)}`;
  if (!backup.protected) return '';
  return typeof backup.protectedUntil === 'number' ? `Protected until ${formatUtcDate(backup.protectedUntil)}` : 'Protected';
}

/** Whether a row can be opened. */
export const selectable = (backup: BackupSummary): boolean => backup.readable;

// ---------------------------------------------------------------- the status block

export interface StatusRow {
  label: string;
  value: string;
  /** A badge in front of the value. */
  badge?: 'Succeeded' | 'Failed';
  /** A quieter line under the value. */
  note?: string;
}

const when = (ms: number, now: number) => `${formatUtc(ms)} · ${relativeTime(ms, now)}`;

/** The rows of the status block: the last backup and how it went, failures in a row, the next run, interval, key and size. */
export function statusRows(status: BackupEngineStatus, now: number): StatusRow[] {
  const { lastSuccessAt, lastFailureAt } = status;
  const failedLast = lastFailureAt !== null && (lastSuccessAt === null || lastFailureAt > lastSuccessAt);
  const rows: StatusRow[] = [];
  if (failedLast) {
    rows.push({ label: 'Last backup', value: when(lastFailureAt, now) });
    rows.push({
      label: 'Result',
      value: lastSuccessAt === null ? 'No backup has worked yet' : `The last one that worked was ${when(lastSuccessAt, now)}`,
      badge: 'Failed',
      note: status.lastFailureError ?? undefined,
    });
  } else if (lastSuccessAt !== null) {
    rows.push({ label: 'Last backup', value: when(lastSuccessAt, now) });
    rows.push({ label: 'Result', value: 'Everything was copied', badge: 'Succeeded' });
  } else {
    rows.push({ label: 'Last backup', value: 'No backup yet' });
  }
  rows.push({ label: 'Failures in a row', value: String(status.consecutiveFailures ?? 0) });
  rows.push({
    label: 'Next backup',
    value: status.running ? 'Running now' : status.nextRunAt !== null ? when(status.nextRunAt, now) : 'Not scheduled',
  });
  rows.push({ label: 'How often', value: intervalLabel(status.intervalMinutes) });
  rows.push({ label: 'Target', value: status.target === 'dir' ? 'Directory' : 'S3 bucket' });
  rows.push({ label: 'Key', value: shortKey(status.keyId) });
  const copies = status.manifests ?? 0;
  rows.push({ label: 'Stored', value: `${formatSize(status.bytesStored)} · ${unit(copies, 'backup')} · ${unit(status.objects ?? 0, 'file')}` });
  return rows;
}

/** One sentence about the last restore, or null when there has been none. */
export function lastRestoreSentence(last: RestoreRecord | null | undefined): string | null {
  if (!last) return null;
  const at = last.at === null ? '' : ` on ${formatUtc(last.at)}`;
  const taken = manifestTime(last.manifest);
  const from = taken === null ? 'a backup' : `the backup of ${formatUtc(taken)}`;
  const what = last.kind === 'board' ? 'a board as a copy' : 'the whole workspace';
  if (last.result === 'done') {
    return last.kind === 'board' ? `A board was restored as a copy from ${from}${at}.` : `The whole workspace was restored from ${from}${at}.`;
  }
  return `Restoring ${what} from ${from} failed${at}: ${errorReason(last.error)}.`;
}

// ---------------------------------------------------------------- the screens

export type Screen =
  | { name: 'list' }
  | { name: 'detail'; manifest: string }
  | { name: 'board'; manifest: string }
  | { name: 'confirm'; manifest: string }
  | { name: 'restoring' };

export type ScreenEvent =
  | { type: 'open'; manifest: string }
  | { type: 'copy' }
  | { type: 'whole' }
  | { type: 'back' }
  | { type: 'restoring' };

/**
 * Which screen comes next. A backup opens its detail; the detail leads to the board copy or to the confirmation of a whole
 * restore; back goes one step up; the restoring screen is a dead end that only a reload leaves. An event that does not fit
 * the screen changes nothing.
 */
export function nextScreen(screen: Screen, event: ScreenEvent): Screen {
  if (screen.name === 'restoring') return screen;
  if (event.type === 'restoring') return { name: 'restoring' };
  switch (screen.name) {
    case 'list':
      return event.type === 'open' ? { name: 'detail', manifest: event.manifest } : screen;
    case 'detail':
      if (event.type === 'copy') return { name: 'board', manifest: screen.manifest };
      if (event.type === 'whole') return { name: 'confirm', manifest: screen.manifest };
      return event.type === 'back' ? { name: 'list' } : screen;
    case 'board':
    case 'confirm':
      return event.type === 'back' ? { name: 'detail', manifest: screen.manifest } : screen;
  }
}

// ---------------------------------------------------------------- the whole restore

/** Whether the typed text is the confirmation word: exactly, in capitals, without spaces. */
export function confirmMatches(typed: string, word: string = CONFIRM_WORD): boolean {
  return typed === word;
}

export interface RestoreGate {
  allowed: boolean;
  /** Why the button is disabled; empty when it is not. */
  reason: string;
}

/** Whether "Restore this backup" may be pressed, and if not, why. Missing room comes first: typing cannot fix it. */
export function restoreGate(typed: string, preview: Pick<BackupPreview, 'confirmWord' | 'space'>): RestoreGate {
  if (!preview.space.enough) {
    return {
      allowed: false,
      reason: `There is not enough free disk space to restore this backup (${formatSize(preview.space.needed)} needed, ${formatSize(preview.space.free)} free). Free some space first.`,
    };
  }
  if (!confirmMatches(typed, preview.confirmWord || CONFIRM_WORD)) {
    return { allowed: false, reason: `Type ${preview.confirmWord || CONFIRM_WORD} in capital letters to enable the button.` };
  }
  return { allowed: true, reason: '' };
}

/**
 * What to do with the failure of the request that starts a whole restore. When the answer is lost or comes from something
 * in front of the server, nobody knows whether the restore has started, so the app watches the server instead of claiming it
 * has not: a server that is up and not restoring sends the person back to a reload, which costs nothing.
 */
export function submitOutcome(status: number, code: string, restarting: boolean): 'watch' | 'error' {
  if (restarting || code === 'restoring' || code === 'network') return 'watch';
  if (status === 0) return 'watch';
  return (status === 502 || status === 503 || status === 504) && code === 'unknown' ? 'watch' : 'error';
}

// ---------------------------------------------------------------- the restoring screen

export const POLL_START_MS = 2000;
export const POLL_FACTOR = 1.5;
export const POLL_CAP_MS = 15_000;
/** After this long without a healthy answer the screen stops asking and says so. */
export const POLL_GIVE_UP_MS = 3 * 60_000;
/** A reload this soon after another is not repeated by itself. */
export const RELOAD_GUARD_MS = 20_000;

/** The wait before the next question to the server: 2 s, then 1.5 times the last one, never more than 15 s. */
export function nextPollDelay(previous: number | null): number {
  return previous === null ? POLL_START_MS : Math.min(POLL_CAP_MS, Math.round(previous * POLL_FACTOR));
}

/** The first `count` waits: 2000, 3000, 4500, 6750, 10125, 15000, 15000, ... */
export function pollDelays(count: number): number[] {
  const out: number[] = [];
  let delay: number | null = null;
  for (let i = 0; i < count; i++) {
    delay = nextPollDelay(delay);
    out.push(delay);
  }
  return out;
}

export type HealthVerdict = 'ready' | 'restoring' | 'down';

/** `/api/health` is healthy only as `{ok: true}` without `restoring`. Anything else, an error or no answer at all, is still down. */
export function classifyHealth(status: number | null, data: unknown): HealthVerdict {
  if (status === null || status < 200 || status >= 300) return 'down';
  if (!isRecord(data) || data.ok !== true) return 'down';
  return data.restoring ? 'restoring' : 'ready';
}

/** Whether the page may reload by itself: not when it did so a moment ago. */
export function mayReload(lastReloadAt: number | null, now: number): boolean {
  return lastReloadAt === null || !Number.isFinite(lastReloadAt) || now - lastReloadAt >= RELOAD_GUARD_MS || now < lastReloadAt;
}

export interface WatchDeps {
  probe: () => Promise<{ status: number | null; data: unknown }>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  /** The server answers healthy and says nothing about restoring. */
  onReady: () => void;
  /** After each question that was not answered healthy. */
  onWaiting?: (verdict: 'restoring' | 'down', attempt: number) => void;
  /** Three minutes without a healthy answer. */
  onSlow: () => void;
}

export interface Watcher {
  /** Starts again from the first wait (also the manual retry). */
  start: () => void;
  stop: () => void;
  running: () => boolean;
}

/**
 * Asks the server whether it is back, with growing waits (never a tight loop): one question at a time, the next one only
 * after the answer and the wait. Gives up after three minutes. A probe that throws counts as no answer.
 */
export function watchServer(deps: WatchDeps): Watcher {
  let live = false;
  let timer: unknown = null;
  let giveUp: unknown = null;
  let delay: number | null = null;
  let attempt = 0;
  let round = 0;

  const clear = () => {
    if (timer !== null) deps.clearTimeout(timer);
    if (giveUp !== null) deps.clearTimeout(giveUp);
    timer = null;
    giveUp = null;
  };

  const schedule = (mine: number) => {
    delay = nextPollDelay(delay);
    timer = deps.setTimeout(() => void ask(mine), delay);
  };

  const ask = async (mine: number) => {
    timer = null;
    if (!live || mine !== round) return;
    attempt++;
    let verdict: HealthVerdict;
    try {
      const answer = await deps.probe();
      verdict = classifyHealth(answer.status, answer.data);
    } catch {
      verdict = 'down';
    }
    if (!live || mine !== round) return;
    if (verdict === 'ready') {
      live = false;
      clear();
      deps.onReady();
      return;
    }
    deps.onWaiting?.(verdict, attempt);
    schedule(mine);
  };

  return {
    start() {
      clear();
      live = true;
      round++;
      const mine = round;
      delay = null;
      attempt = 0;
      giveUp = deps.setTimeout(() => {
        if (!live || mine !== round) return;
        live = false;
        clear();
        deps.onSlow();
      }, POLL_GIVE_UP_MS);
      schedule(mine);
    },
    stop() {
      live = false;
      round++;
      clear();
    },
    running: () => live,
  };
}
