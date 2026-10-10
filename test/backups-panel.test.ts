import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOverview, BackupBoards, BackupList, BackupPreview, Me } from '../src/api';
import { onRestoring } from '../src/api';
import type { DeniedReason } from '../src/sync';
import { mountAccessBanner } from '../src/ui/access';
import { renderAdmin } from '../src/ui/admin';
import { BACKUP_DOCS } from '../src/ui/backups';
import { hideRestoring, restoringShown, showRestoring } from '../src/ui/restoring';
import { POLL_GIVE_UP_MS } from '../src/ui/backups-logic';
import { FakeElement, choose, control, flush, hasControl, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';
import { type } from './fake-dom';

// docs/backups.md, "In the app": the Backups tab of the admin dashboard, rendered into a fake DOM (test/fake-dom.ts) over a
// mocked fetch, the way a person uses it.

const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;
const name = (at: number) => `${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json.enc`;

const NEWEST = name(NOW - 30 * MIN);
const SECOND = name(NOW - 90 * MIN);
const LOST = name(NOW - 150 * MIN);
const DAMAGED = name(NOW - 3 * DAY);

const owner = (workspace?: Me['workspace']): Me => ({ user: { id: 'u1', email: 'owner@example.test', name: 'Owner', role: 'owner' }, teams: [], ...(workspace ? { workspace } : {}) });
const hosted = (readOnly = false): Me['workspace'] => ({ readOnly, banner: null, seatLimit: 10, seatsUsed: 3 });
const adminMe = (): Me => ({ user: { id: 'u2', email: 'admin@example.test', name: 'Admin', role: 'admin' }, teams: [] });

const listing = (patch: Partial<BackupList> = {}): BackupList => ({
  backups: [
    { name: NEWEST, createdAt: NOW - 30 * MIN, protected: true, protectedUntil: NOW + 6 * DAY, readable: true, files: 14, bytes: 4_823_552, keyId: 'a1b2c3d4' },
    { name: SECOND, createdAt: NOW - 90 * MIN, protected: false, protectedUntil: null, readable: true, files: 14, bytes: 4_811_264, keyId: 'a1b2c3d4' },
    { name: LOST, createdAt: NOW - 150 * MIN, protected: false, protectedUntil: null, readable: false, error: 'unknown_key' },
    { name: DAMAGED, createdAt: NOW - 3 * DAY, protected: false, protectedUntil: null, readable: false, error: 'tamper' },
  ],
  truncated: false,
  status: {
    target: 's3', lastSuccessAt: NOW - 30 * MIN, lastFailureAt: null, lastFailureError: null, consecutiveFailures: 0, nextRunAt: NOW + 30 * MIN, running: false,
    intervalMinutes: 60, keyId: 'a1b2c3d4', bytesStored: 18_874_368, objects: 52, manifests: 4,
  },
  restore: { inProgress: null, maintenance: false, last: null, protectedBackups: [], oldData: [] },
  ...patch,
});

const preview = (patch: Partial<BackupPreview> = {}): BackupPreview => ({
  name: NEWEST, createdAt: NOW - 30 * MIN, appVersion: '0.1.0', keyId: 'a1b2c3d4', files: 14, bytes: 4_823_552, boards: 6, protected: true, confirmWord: 'RESTORE',
  keepOldFor: '7 days', reason: 'There is room on the disk, so the old data is kept for 7 days.', space: { needed: 2 * 4_823_552 + 64 * 1024 ** 2, free: 21 * GIB, enough: true }, ...patch,
});

const boards = (patch: Partial<BackupBoards> = {}): BackupBoards => ({
  boards: [
    { id: 'roadmap', title: 'Roadmap 2026', teamId: 't1', teamName: 'Design', deleted: false },
    { id: 'retro', title: 'Sprint retro', teamId: 't1', teamName: 'Design', deleted: false },
    { id: 'notes', title: 'Meeting notes', teamId: null, teamName: null, deleted: false },
    { id: 'gone', title: 'Old plan', teamId: 't2', teamName: 'Growth', deleted: true },
  ],
  truncated: false,
  ...patch,
});

const overview: AdminOverview = {
  members: { total: 1, active: 1, disabled: 0, byRole: { owner: 1, admin: 0, member: 0, guest: 0 } }, teams: { total: 0, archived: 0 }, boards: { total: 0, deleted: 0 },
  sessions: { active: 1 }, signIns7d: 1, live: { rooms: 0, connections: 0 }, instance: { authEnabled: true, baseUrl: 'http://localhost', mail: 'log', version: '0.1.0' },
};

// ------------------------------------------------------------------ the mocked server

interface Reply { status?: number; body?: unknown; headers?: Record<string, string> }
type Req = { method: string; path: string; body: any };
type Route = Reply | 'network' | ((req: Req) => Reply | 'network');

const json = (body: unknown, status = 200, headers?: Record<string, string>): Reply => ({ status, body, headers });
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Reply =>
  json({ error, message: `server words for ${error}`, ...extra }, status, headers);

let calls: Req[] = [];

function serve(routes: Record<string, Route> = {}) {
  calls = [];
  const table: Record<string, Route> = {
    'GET /api/admin/backups': json(listing()),
    [`GET /api/admin/backups/${NEWEST}`]: json(preview()),
    [`GET /api/admin/backups/${NEWEST}/boards`]: json(boards()),
    [`GET /api/admin/backups/${SECOND}`]: json(preview({ name: SECOND, protected: false })),
    'GET /api/admin/overview': json(overview),
    'GET /api/health': json({ ok: true, rooms: 0, connections: 0, restoring: true }),
    ...routes,
  };
  const fn = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const req: Req = { method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    const route = table[`${method} ${path}`];
    if (route === undefined) return new Response(JSON.stringify({ error: 'not_found', message: 'No such endpoint' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const reply = typeof route === 'function' ? route(req) : route;
    if (reply === 'network') throw new TypeError('Failed to fetch');
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json', ...reply.headers } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const asked = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

// ------------------------------------------------------------------ the page

let browser: FakeBrowser;
let root: FakeElement;
const asHtml = (el: FakeElement) => el as unknown as HTMLElement;
let stopListening: () => void;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  browser = installFakeBrowser();
  root = browser.mount();
  // what main.ts does at start: any 503 restoring from the shared client puts the restoring screen up
  stopListening = onRestoring(() => showRestoring());
});

afterEach(() => {
  stopListening();
  hideRestoring();
  browser.uninstall();
  vi.useRealTimers();
});

async function open(me: Me = owner(), routes: Record<string, Route> = {}) {
  serve(routes);
  renderAdmin(asHtml(root), 'backups', me);
  await flush();
  return panel();
}

const panel = () => need(root, '.admin-panel');
const screenTitle = () => textOf(panel().querySelector('[data-screen-focus]'));
const rows = () => panel().querySelectorAll('.backups-row');
const alerts = () => panel().querySelectorAll('[role="alert"]').map((el) => textOf(el.querySelector('span') ?? el));
const statuses = () => panel().querySelectorAll('[role="status"]').map(textOf);

async function pressDetails(manifest = NEWEST) {
  control(panel(), new RegExp(`^Details of the backup of ${new Date(Number(manifest === NEWEST ? NOW - 30 * MIN : NOW - 90 * MIN)).toISOString().slice(0, 10)}`)).click();
  await flush();
}

async function openDetail() {
  await open();
  await pressDetails();
}

async function openBoardCopy(me: Me = owner(), routes: Record<string, Route> = {}) {
  await open(me, routes);
  await pressDetails();
  control(panel(), 'Restore a board as a copy').click();
  await flush();
}

async function openConfirm(routes: Record<string, Route> = {}) {
  await open(owner(), routes);
  await pressDetails();
  control(panel(), 'Restore the whole workspace').click();
  await flush();
}

const confirmField = () => need(panel(), '#backups-confirm');
const restoreButton = () => control(panel(), 'Restore this backup');

// ------------------------------------------------------------------ the tab and who sees it

describe('the tab', () => {
  it('is listed for an owner before the audit log, and shows the Backups tab', async () => {
    await open();
    const tabs = root.querySelectorAll('.admin-tab').map(textOf);
    expect(tabs).toEqual(['01Overview', '02Members', '03Teams', '04Boards', '05Sessions', '06AI', '07Backups', '08Audit log']);
    expect(textOf(need(root, '.admin-tab.on'))).toBe('07Backups');
    expect(need(root, '.admin-tab.on').getAttribute('aria-current')).toBe('page');
    expect(need(root, '.admin-heading').textContent).toBe('Backups');
    expect(need(root, '.admin-kicker').textContent).toBe('07 / 08');
  });

  it('is not listed for an admin, who is sent to the overview from its address', async () => {
    serve();
    renderAdmin(asHtml(root), 'backups', adminMe());
    await flush();
    expect(root.querySelectorAll('.admin-tab').map(textOf)).not.toContain('07Backups');
    expect(root.querySelectorAll('.admin-tab').map(textOf)).toContain('07Audit log');
    expect(need(root, '.admin-heading').textContent).toBe('Overview');
    expect(asked('GET', '/api/admin/backups')).toEqual([]);
    expect(calls.some((c) => c.path.startsWith('/api/admin/backups'))).toBe(false);
  });

  it('is listed for an owner even when backups are off, and then says so', async () => {
    await open(owner(), { 'GET /api/admin/backups': refuse(409, 'backups_off') });
    expect(root.querySelectorAll('.admin-tab').map(textOf)).toContain('07Backups');
    expect(textOf(panel())).toContain('Not set up');
  });
});

// ------------------------------------------------------------------ the list

describe('the list', () => {
  it('shows the status, then the backups newest first with their size, key and notes', async () => {
    await open();
    const facts = Object.fromEntries(panel().querySelectorAll('.admin-fact').map((f) => [textOf(f.querySelector('dt')), textOf(f.querySelector('dd'))]));
    expect(facts).toEqual({
      'Last backup': '2026-01-15 09:30 UTC · 30 minutes ago',
      Result: 'Succeeded Everything was copied',
      'Failures in a row': '0',
      'Next backup': '2026-01-15 10:30 UTC · in 30 minutes',
      'How often': 'Every hour',
      Key: 'a1b2c3d4',
      Target: 'S3 bucket',
      Stored: '18 MB · 4 backups · 52 files',
    });
    expect(panel().querySelectorAll('h3').map(textOf)).toEqual(['Status', '4 backups']);
    expect(rows().map((r) => textOf(r.querySelector('.backups-when')))).toEqual([
      '2026-01-15 09:30 UTC30 minutes ago', '2026-01-15 08:30 UTC1 hour ago', '2026-01-15 07:30 UTC2 hours ago', '2026-01-12 10:00 UTC3 days ago',
    ]);
    expect(rows()[0].querySelectorAll('.admin-cell').map(textOf)).toEqual(['2026-01-15 09:30 UTC30 minutes ago', 'Files 14', 'Size 4.6 MB', 'Key a1b2c3d4', 'Protected until 2026-01-21']);
    expect(textOf(rows()[1].querySelector('.backups-note'))).toBe('');
  });

  it('greys out an unreadable backup with its reason and gives it no way to be opened', async () => {
    await open();
    const [, , lost, damaged] = rows();
    expect(textOf(lost.querySelector('.backups-note'))).toBe('Unreadable: the encryption key is not available');
    expect(textOf(damaged.querySelector('.backups-note'))).toBe('Unreadable: it failed its integrity check');
    for (const row of [lost, damaged]) {
      expect(row.classList.contains('unreadable')).toBe(true);
      expect(row.getAttribute('aria-disabled')).toBe('true');
      expect(row.querySelectorAll('button, a')).toEqual([]);
    }
    expect(rows()[0].classList.contains('unreadable')).toBe(false);
    expect(rows()[0].querySelectorAll('button')).toHaveLength(1);
    expect(rows()[1].querySelectorAll('button')).toHaveLength(1);
    expect(textOf(panel())).not.toMatch(/unknown_key|tamper/);
  });

  it('is a table for a screen reader: a header row, rows and cells, and a name for the actions', async () => {
    await open();
    const table = need(panel(), '.backups-table');
    expect(table.getAttribute('role')).toBe('table');
    expect(table.getAttribute('aria-label')).toBe('Backups');
    const header = need(table, '.admin-head');
    expect(header.getAttribute('role')).toBe('row');
    expect(header.children.map((c) => c.getAttribute('role'))).toEqual(Array(6).fill('columnheader'));
    expect(header.children.map(textOf)).toEqual(['When', 'Files', 'Size', 'Key', 'Notes', '']);
    expect(header.children[5].getAttribute('aria-label')).toBe('Actions');
    for (const row of rows()) expect(row.getAttribute('role')).toBe('row');
    // the wrapper that groups files, size and key for the phone layout is not part of the table's tree
    expect(rows()[0].querySelectorAll('.backups-meta').map((el) => el.getAttribute('role'))).toEqual(['presentation']);
    expect(control(panel(), /Details of the backup of 2026-01-15 09:30 UTC/).getAttribute('aria-label')).toBe('Details of the backup of 2026-01-15 09:30 UTC');
  });

  it('says one sentence about the last restore, and that a restore is running', async () => {
    await open(owner(), {
      'GET /api/admin/backups': json(listing({
        restore: { inProgress: 'workspace', maintenance: false, last: { kind: 'workspace', result: 'failed', at: NOW - DAY, manifest: DAMAGED, error: 'not_enough_space' }, protectedBackups: [], oldData: [] },
      })),
    });
    expect(textOf(need(panel(), '.backups-last'))).toBe('Restoring the whole workspace from the backup of 2026-01-12 10:00 UTC failed on 2026-01-14 10:00 UTC: not enough free disk space.');
    expect(statuses().some((s) => s.startsWith('A restore is running right now'))).toBe(true);
  });

  it('shows a failing backup in the status, with the reason the engine gave', async () => {
    await open(owner(), {
      'GET /api/admin/backups': json(listing({ status: { ...listing().status, lastFailureAt: NOW - 5 * MIN, lastFailureError: 'S3 PUT failed (status 403, AccessDenied)', consecutiveFailures: 2 } })),
    });
    const result = panel().querySelectorAll('.admin-fact').find((f) => textOf(f.querySelector('dt')) === 'Result')!;
    expect(textOf(result.querySelector('dd'))).toContain('Failed');
    expect(textOf(result.querySelector('dd'))).toContain('S3 PUT failed (status 403, AccessDenied)');
    expect(result.querySelector('.admin-badge')!.classList.contains('bad')).toBe(true);
  });

  it('says when the list is cut at 200, and when there is nothing yet', async () => {
    await open(owner(), { 'GET /api/admin/backups': json(listing({ truncated: true })) });
    expect(statuses()).toContain('Showing the newest 200 backups. Older ones are not listed.');
    root.replaceChildren();
    await open(owner(), { 'GET /api/admin/backups': json(listing({ backups: [] })) });
    expect(textOf(need(panel(), '.backups-table'))).toBe('No backups yet. The first one is made a few minutes after the server starts.');
    expect(need(panel(), '.backups-table').hasAttribute('role')).toBe(false);
    expect(panel().querySelectorAll('h3').map(textOf)).toEqual(['Status', '0 backups']);
  });

  it('says a load that failed in plain words and loads again on Retry', async () => {
    let tries = 0;
    await open(owner(), { 'GET /api/admin/backups': () => (++tries === 1 ? refuse(502, 's3') : json(listing())) });
    expect(alerts()).toEqual(['The backup storage did not answer as expected. Check that it is reachable, then try again.']);
    control(panel(), 'Retry').click();
    await flush();
    expect(alerts()).toEqual([]);
    expect(rows()).toHaveLength(4);
  });

  it('says a lost connection as one', async () => {
    await open(owner(), { 'GET /api/admin/backups': 'network' });
    expect(alerts()).toEqual(['Could not reach the server. Check your connection and try again.']);
  });

  it('sends a person whose session ended to sign-in, and a person who lost the role home', async () => {
    await open(owner(), { 'GET /api/admin/backups': refuse(401, 'unauthenticated') });
    expect(browser.location.hash).toBe('#/signin');
    root.replaceChildren();
    await open(owner(), { 'GET /api/admin/backups': refuse(403, 'forbidden') });
    expect(browser.location.replace).toHaveBeenCalledWith('#/');
  });
});

// ------------------------------------------------------------------ not set up

describe('backups that are off', () => {
  const off = { 'GET /api/admin/backups': refuse(409, 'backups_off') };

  it('says so calmly on a hosted workspace and offers billing, never a price page or an address of ours', async () => {
    await open(owner(hosted()), { ...off, 'POST /api/billing/portal': json({ url: 'https://billing.example.test/session/abc' }) });
    expect(panel().querySelectorAll('h3').map(textOf)).toEqual(['Not set up']);
    expect(textOf(need(panel(), '.backups-lead'))).toContain('This workspace has no backups yet.');
    expect(alerts()).toEqual([]);
    expect(panel().querySelectorAll('a')).toEqual([]);
    expect(panel().querySelectorAll('[href]')).toEqual([]);
    expect(textOf(panel())).not.toMatch(/TABULA_BACKUP|price|pricing|\$|€|£/i);
    const add = control(panel(), 'Add backups');
    expect(add.tagName).toBe('BUTTON');
    expect(add.classList.contains('primary')).toBe(true);
    expect(hasControl(panel(), 'How to turn on backups')).toBe(false);
    expect(browser.location.assign).not.toHaveBeenCalled();
    add.click();
    await flush();
    expect(asked('POST', '/api/billing/portal')).toHaveLength(1);
    expect(browser.location.assign).toHaveBeenCalledWith('https://billing.example.test/session/abc');
  });

  it('on a workspace provided free says so instead of offering billing (TAB-226)', async () => {
    await open(owner({ ...hosted()!, billing: false }), off);
    expect(hasControl(panel(), 'Add backups')).toBe(false);
    expect(textOf(panel())).toContain("This workspace is provided free (education or internal). There's nothing to bill.");
    expect(asked('POST', '/api/billing/portal')).toHaveLength(0);
  });

  it('does not follow a billing address that is not https', async () => {
    await open(owner(hosted()), { ...off, 'POST /api/billing/portal': json({ url: 'http://billing.example.test/x' }) });
    control(panel(), 'Add backups').click();
    await flush();
    expect(browser.location.assign).not.toHaveBeenCalled();
    expect(need(root, '.admin-status').textContent).toBe('Something went wrong. Try again.');
    expect(control(panel(), 'Add backups').disabled).toBe(false);
  });

  it('says so on a self-hosted server and links to the guide, not to billing', async () => {
    await open(owner(), off);
    expect(panel().querySelectorAll('h3').map(textOf)).toEqual(['Not set up']);
    expect(textOf(need(panel(), '.backups-lead'))).toContain('TABULA_BACKUP_*');
    expect(hasControl(panel(), 'Add backups')).toBe(false);
    const link = control(panel(), 'How to turn on backups');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(BACKUP_DOCS);
    expect(BACKUP_DOCS).toBe('/docs/admin#backups');
    expect(calls.some((c) => c.path.includes('billing'))).toBe(false);
    expect(panel().querySelectorAll('.backups-table')).toEqual([]);
  });
});

// ------------------------------------------------------------------ one backup

describe('one backup', () => {
  it('opens in place with what the server says about it, and the two things to do', async () => {
    await openDetail();
    expect(asked('GET', `/api/admin/backups/${NEWEST}`)).toHaveLength(1);
    expect(screenTitle()).toBe('2026-01-15 09:30 UTC');
    const facts = Object.fromEntries(panel().querySelectorAll('.admin-fact').map((f) => [textOf(f.querySelector('dt')), textOf(f.querySelector('dd'))]));
    expect(facts).toEqual({
      Created: '2026-01-15 09:30 UTC · 30 minutes ago',
      'App version': '0.1.0',
      Files: '14',
      Boards: '6',
      Size: '4.6 MB',
      Key: 'a1b2c3d4',
      Protected: 'Kept from pruning until 2026-01-21 10:00 UTC',
      'Disk space': '21 GB free, 73 MB needed for a whole restore Enough room.',
      'Old data': 'Kept 7 days after a whole restore There is room on the disk, so the old data is kept for 7 days.',
    });
    const copy = control(panel(), 'Restore a board as a copy');
    const whole = control(panel(), 'Restore the whole workspace');
    expect(copy.classList.contains('primary')).toBe(true);
    expect(whole.classList.contains('primary')).toBe(false);
    expect(copy.disabled || whole.disabled).toBe(false);
    expect(panel().querySelectorAll('[role="dialog"], .modal')).toEqual([]);
  });

  it('puts focus on its title so a screen reader starts there, and goes back to the list with focus on the row', async () => {
    await openDetail();
    const heading = need(panel(), '[data-screen-focus]');
    expect(browser.document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(heading.tagName).toBe('H3');
    control(panel(), 'All backups').click();
    await flush();
    expect(rows()).toHaveLength(4);
    expect(browser.document.activeElement).toBe(control(panel(), /Details of the backup of 2026-01-15 09:30 UTC/));
  });

  it('says not enough room and that the old data is kept only until the next backup, in the server words', async () => {
    await open(owner(), {
      [`GET /api/admin/backups/${NEWEST}`]: json(preview({ keepOldFor: 'until the next successful backup (at least 24 h)', reason: 'The disk would be 85% full with the old data kept.', space: { needed: 3 * GIB, free: GIB, enough: false } })),
    });
    await pressDetails();
    const text = textOf(panel());
    expect(text).toContain('1 GB free, 3 GB needed for a whole restore');
    expect(text).toContain('Not enough room.');
    expect(text).toContain('Kept until the next successful backup (at least 24 h) after a whole restore');
    expect(text).toContain('The disk would be 85% full with the old data kept.');
  });

  it('offers neither action while a restore is running', async () => {
    await open(owner(), { 'GET /api/admin/backups': json(listing({ restore: { inProgress: 'board', maintenance: false, last: null, protectedBackups: [], oldData: [] } })) });
    await pressDetails();
    expect(control(panel(), 'Restore a board as a copy').disabled).toBe(true);
    expect(control(panel(), 'Restore the whole workspace').disabled).toBe(true);
    expect(statuses().some((s) => s.includes('A restore is running right now'))).toBe(true);
  });

  it('says in plain words why a backup cannot be opened, and has no action for it', async () => {
    await open(owner(), { [`GET /api/admin/backups/${NEWEST}`]: refuse(422, 'no_directory') });
    await pressDetails();
    expect(alerts()).toEqual(['This backup has no workspace database (it was made without accounts), so it cannot be restored here.']);
    expect(hasControl(panel(), 'Restore the whole workspace')).toBe(false);
    expect(hasControl(panel(), 'All backups')).toBe(true);
  });

  it('says a backup that is gone from the storage in plain words', async () => {
    await open(owner(), { [`GET /api/admin/backups/${NEWEST}`]: refuse(404, 'manifest_not_found') });
    await pressDetails();
    expect(alerts()).toEqual(['That backup is no longer in the storage. Reload the list and pick another one.']);
  });
});

// ------------------------------------------------------------------ one board, as a copy

describe('a board as a copy', () => {
  const pickBoard = (title: string) => {
    const radio = panel().querySelectorAll('.backups-pick-row').find((r) => textOf(r).startsWith(title))!.querySelector('input')!;
    choose(radio);
    return radio;
  };
  const make = () => control(panel(), 'Make a copy');

  it('lists the boards of the backup, loaded for this backup only', async () => {
    await openBoardCopy();
    expect(asked('GET', `/api/admin/backups/${NEWEST}/boards`)).toHaveLength(1);
    expect(screenTitle()).toBe('Restore a board as a copy');
    expect(panel().querySelectorAll('.backups-pick-row').map(textOf)).toEqual(['Roadmap 2026Design', 'Sprint retroDesign', 'Meeting notesPersonal', 'Old plan DeletedGrowth']);
    expect(textOf(need(panel(), '.admin-count'))).toBe('4 boards');
    expect(need(panel(), '.backups-pick').getAttribute('role')).toBe('radiogroup');
    expect(browser.document.activeElement).toBe(need(panel(), '[data-screen-focus]'));
  });

  it('labels the search and every radio, and the button is shut until a board is picked', async () => {
    await openBoardCopy();
    expect(need(panel(), 'input[type=search]').getAttribute('aria-label')).toBe('Search the boards of this backup');
    const radios = panel().querySelectorAll('input[type=radio]');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Roadmap 2026, Design', 'Sprint retro, Design', 'Meeting notes, Personal', 'Old plan, Growth, deleted']);
    expect(make().disabled).toBe(true);
    expect(textOf(need(panel(), '#backups-copy-why'))).toBe('Pick a board to enable the button.');
    expect(textOf(need(panel(), '#backups-chosen'))).toBe('Pick a board to copy.');
    expect(make().getAttribute('aria-describedby')).toBe('backups-copy-why');
    pickBoard('Sprint retro');
    expect(make().disabled).toBe(false);
    expect(textOf(need(panel(), '#backups-chosen'))).toBe('Selected: Sprint retro');
    expect(textOf(need(panel(), '#backups-copy-why'))).toBe('');
    expect(panel().querySelectorAll('.backups-pick-row').map((r) => r.classList.contains('on'))).toEqual([false, true, false, false]);
  });

  it('filters by title or team, says how many match, and says when nothing does', async () => {
    await openBoardCopy();
    const search = need(panel(), 'input[type=search]');
    type(search, 'road');
    expect(panel().querySelectorAll('.backups-pick-row').map(textOf)).toEqual(['Roadmap 2026Design']);
    expect(textOf(need(panel(), '.admin-count'))).toBe('1 of 4');
    type(search, 'growth');
    expect(panel().querySelectorAll('.backups-pick-row').map(textOf)).toEqual(['Old plan DeletedGrowth']);
    type(search, 'personal');
    expect(panel().querySelectorAll('.backups-pick-row').map(textOf)).toEqual(['Meeting notesPersonal']);
    type(search, 'zzz');
    expect(panel().querySelectorAll('.backups-pick-row')).toEqual([]);
    expect(textOf(need(panel(), '.backups-pick'))).toBe('Nothing matches “zzz”.');
    type(search, '');
    expect(panel().querySelectorAll('.backups-pick-row')).toHaveLength(4);
  });

  it('keeps the chosen board while the list is filtered', async () => {
    await openBoardCopy();
    pickBoard('Roadmap');
    type(need(panel(), 'input[type=search]'), 'notes');
    expect(textOf(need(panel(), '#backups-chosen'))).toBe('Selected: Roadmap 2026');
    expect(make().disabled).toBe(false);
  });

  it('makes the copy: one POST with the backup and the board, then a link to the new board', async () => {
    await openBoardCopy(owner(), { 'POST /api/admin/backups/restore-board': json({ ok: true, boardId: 'newboard1', title: 'Restored: Sprint retro 2026-01-15', teamId: 't1' }) });
    pickBoard('Sprint retro');
    make().click();
    // busy is marked, not disabled, so keyboard focus stays on the button
    expect(make().disabled).toBe(false);
    expect(make().getAttribute('aria-busy')).toBe('true');
    expect(make().getAttribute('aria-disabled')).toBe('true');
    make().click();
    await flush();
    const posts = asked('POST', '/api/admin/backups/restore-board');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ manifest: NEWEST, boardId: 'retro' });
    const result = need(panel(), '.backups-result');
    expect(result.getAttribute('role')).toBe('status');
    expect(result.getAttribute('aria-live')).toBe('polite');
    expect(textOf(result)).toBe('The copy is ready: Restored: Sprint retro 2026-01-15.');
    const link = need(result, 'a');
    expect(link.getAttribute('href')).toBe('#/b/newboard1');
    expect(link.textContent).toBe('Restored: Sprint retro 2026-01-15');
    expect(make().disabled).toBe(false);
    expect(make().hasAttribute('aria-busy')).toBe(false);
    expect(make().hasAttribute('aria-disabled')).toBe(false);
    expect(alerts()).toEqual([]);
  });

  it('shows the server message when the copy went to the personal space', async () => {
    const message = 'The original team no longer exists or you cannot see it, so the copy is in your personal space.';
    await openBoardCopy(owner(), { 'POST /api/admin/backups/restore-board': json({ ok: true, boardId: 'b9', title: 'Restored: Roadmap 2026-01-15', teamId: null, fallback: 'personal', message }) });
    pickBoard('Roadmap');
    make().click();
    await flush();
    expect(textOf(need(panel(), '.backups-result'))).toBe(`The copy is ready: Restored: Roadmap 2026-01-15. ${message}`);
  });

  it('shows no such message when the copy is in the original team', async () => {
    await openBoardCopy(owner(), { 'POST /api/admin/backups/restore-board': json({ ok: true, boardId: 'b9', title: 'Restored: Roadmap 2026-01-15', teamId: 't1', message: 'ignored without a fallback' }) });
    pickBoard('Roadmap');
    make().click();
    await flush();
    expect(textOf(need(panel(), '.backups-result'))).toBe('The copy is ready: Restored: Roadmap 2026-01-15.');
  });

  it('makes a second copy after the first, each its own request', async () => {
    let n = 0;
    await openBoardCopy(owner(), { 'POST /api/admin/backups/restore-board': () => json({ ok: true, boardId: `copy${++n}`, title: `Restored ${n}`, teamId: null }) });
    pickBoard('Roadmap');
    make().click();
    await flush();
    make().click();
    await flush();
    expect(asked('POST', '/api/admin/backups/restore-board')).toHaveLength(2);
    expect(need(panel(), '.backups-result a').getAttribute('href')).toBe('#/b/copy2');
  });

  it('is shut, with the reason, while the hosted workspace is read-only', async () => {
    await openBoardCopy(owner(hosted(true)));
    pickBoard('Roadmap');
    expect(make().disabled).toBe(true);
    expect(textOf(need(panel(), '#backups-copy-why'))).toBe('This workspace is read-only, so a copy cannot be added right now. Check billing to make it writable again.');
    make().click();
    await flush();
    expect(asked('POST', '/api/admin/backups/restore-board')).toEqual([]);
  });

  it('shuts the button with the same reason when the server answers 402', async () => {
    await openBoardCopy(owner(hosted()), { 'POST /api/admin/backups/restore-board': refuse(402, 'read_only') });
    pickBoard('Roadmap');
    make().click();
    await flush();
    expect(alerts()).toEqual(['This workspace is read-only, so a copy cannot be added right now. Check billing to make it writable again.']);
    expect(make().disabled).toBe(true);
    expect(textOf(need(panel(), '#backups-copy-why'))).toContain('read-only');
  });

  it.each<[string, Reply, string]>([
    ['board_not_in_backup', refuse(404, 'board_not_in_backup'), 'That board is not in this backup, or it has no saved content there.'],
    ['rate_limited', refuse(429, 'rate_limited', {}, { 'retry-after': '600' }), 'Too many tries in a short time. Try again in 10 minutes.'],
    ['restore_in_progress', refuse(409, 'restore_in_progress'), 'A restore is already running. Wait until it is done, then try again.'],
    ['tamper', refuse(422, 'tamper'), 'This backup failed its integrity check. It may be damaged or changed, so it cannot be used.'],
    ['not_enough_space', refuse(507, 'not_enough_space', { needed: 3 * GIB, free: GIB }), 'There is not enough free disk space on the server (3 GB needed, 1 GB free). Free some space and try again.'],
    ['an unknown code', refuse(500, 'something_new'), 'Something went wrong with the backups. Try again, and look at the server log if it keeps happening.'],
    ['a gateway page', { status: 502, body: undefined }, 'Something went wrong with the backups. Try again, and look at the server log if it keeps happening.'],
  ])('says %s in plain words, and lets the person try again', async (_what, reply, sentence) => {
    await openBoardCopy(owner(), { 'POST /api/admin/backups/restore-board': reply });
    pickBoard('Roadmap');
    make().click();
    await flush();
    expect(alerts()).toEqual([sentence]);
    expect(textOf(panel())).not.toMatch(/board_not_in_backup|rate_limited|restore_in_progress|not_enough_space|something_new/);
    expect(make().disabled).toBe(false);
    expect(textOf(need(panel(), '.backups-result'))).toBe('');
  });

  it('clears an old error and an old result when the next copy starts', async () => {
    let n = 0;
    await openBoardCopy(owner(), { 'POST /api/admin/backups/restore-board': () => (++n === 1 ? refuse(404, 'board_not_in_backup') : json({ ok: true, boardId: 'ok1', title: 'Restored', teamId: null })) });
    pickBoard('Roadmap');
    make().click();
    await flush();
    expect(alerts()).toHaveLength(1);
    make().click();
    await flush();
    expect(alerts()).toEqual([]);
    expect(textOf(need(panel(), '.backups-result'))).toContain('The copy is ready');
  });

  it('shows a title as text, never as markup', async () => {
    await openBoardCopy(owner(), {
      [`GET /api/admin/backups/${NEWEST}/boards`]: json(boards({ boards: [{ id: 'x', title: '<img src=x onerror=alert(1)>', teamId: 't', teamName: '<b>Team</b>', deleted: false }] })),
    });
    expect(textOf(need(panel(), '.backups-pick-row'))).toBe('<img src=x onerror=alert(1)><b>Team</b>');
    expect(panel().querySelectorAll('img, b')).toEqual([]);
  });

  it('says when the backup has no board to restore, and when the list is cut at 500', async () => {
    await openBoardCopy(owner(), { [`GET /api/admin/backups/${NEWEST}/boards`]: json(boards({ boards: [] })) });
    expect(textOf(need(panel(), '.backups-pick'))).toBe('No board of this backup can be restored. A board needs saved content in the backup.');
    expect(make().disabled).toBe(true);
    root.replaceChildren();
    await openBoardCopy(owner(), { [`GET /api/admin/backups/${NEWEST}/boards`]: json(boards({ truncated: true })) });
    expect(textOf(panel())).toContain('Only the 500 boards edited most recently are listed.');
  });

  it('says why the boards could not be read, with a Retry that asks again', async () => {
    let tries = 0;
    await openBoardCopy(owner(), { [`GET /api/admin/backups/${NEWEST}/boards`]: () => (++tries === 1 ? refuse(429, 'rate_limited', {}, { 'retry-after': '30' }) : json(boards())) });
    expect(alerts()).toEqual(['Too many tries in a short time. Try again in 30 seconds.']);
    expect(panel().querySelectorAll('input[type=radio]')).toEqual([]);
    control(panel(), 'Retry').click();
    await flush();
    expect(panel().querySelectorAll('input[type=radio]')).toHaveLength(4);
  });

  it('goes back to the backup with the back button', async () => {
    await openBoardCopy();
    control(panel(), 'Back to the backup').click();
    await flush();
    expect(screenTitle()).toBe('2026-01-15 09:30 UTC');
    expect(hasControl(panel(), 'Restore the whole workspace')).toBe(true);
  });
});

// ------------------------------------------------------------------ the whole workspace

describe('restoring the whole workspace', () => {
  const type_ = (value: string) => type(confirmField(), value);

  it('lists exactly what will happen, with the server words for the old data', async () => {
    await openConfirm();
    expect(asked('GET', `/api/admin/backups/${NEWEST}`)).toHaveLength(2);
    expect(screenTitle()).toBe('Restore the whole workspace');
    expect(textOf(need(panel(), '.backups-lead'))).toBe('You are about to replace everything in this workspace with the backup of 2026-01-15 09:30 UTC. People, teams, boards, rooms, history and settings all come from it.');
    const steps = panel().querySelectorAll('.backups-steps li').map(textOf);
    expect(steps).toEqual([
      'Everybody is signed out and has to sign in again. Access tokens and invite links are revoked.',
      'The workspace is unavailable for about a minute while the server restarts.',
      'A safety backup of the current data is made first. If it fails, nothing changes.',
      'The current data is moved aside, not deleted. It is kept 7 days.There is room on the disk, so the old data is kept for 7 days.',
      'Edits made after this backup was taken are not in it. They exist only in that old-data folder.',
    ]);
    expect(need(panel(), '.backups-steps').tagName).toBe('OL');
  });

  it('says the old data is kept only until the next backup when the server says so', async () => {
    await openConfirm({
      [`GET /api/admin/backups/${NEWEST}`]: json(preview({ keepOldFor: 'until the next successful backup (at least 24 h)', reason: 'The disk would be 85% full with the old data kept.' })),
    });
    const fourth = panel().querySelectorAll('.backups-steps li').map(textOf)[3];
    expect(fourth).toBe('The current data is moved aside, not deleted. It is kept until the next successful backup (at least 24 h).The disk would be 85% full with the old data kept.');
  });

  it('keeps the button shut until the word is typed exactly, and says why', async () => {
    await openConfirm();
    expect(restoreButton().disabled).toBe(true);
    expect(restoreButton().classList.contains('primary')).toBe(false);
    expect(restoreButton().getAttribute('aria-describedby')).toBe('backups-restore-why');
    expect(confirmField().getAttribute('aria-describedby')).toBe('backups-restore-why');
    expect(need(panel(), 'label').getAttribute('for')).toBe('backups-confirm');
    expect(textOf(need(panel(), 'label'))).toBe('Type RESTORE to confirm');
    expect(textOf(need(panel(), '#backups-restore-why'))).toBe('Type RESTORE in capital letters to enable the button.');
    for (const wrong of ['restore', 'Restore', 'RESTOR', 'RESTORE ', ' RESTORE', 'R E S T O R E', 'RESTORE!', 'yes', '']) {
      type_(wrong);
      expect(restoreButton().disabled, `${JSON.stringify(wrong)}`).toBe(true);
    }
    type_('RESTORE');
    expect(restoreButton().disabled).toBe(false);
    expect(textOf(need(panel(), '#backups-restore-why'))).toBe('');
    type_('RESTORE ');
    expect(restoreButton().disabled).toBe(true);
    expect(textOf(need(panel(), '#backups-restore-why'))).toBe('Type RESTORE in capital letters to enable the button.');
    restoreButton().click();
    await flush();
    expect(asked('POST', '/api/admin/backups/restore')).toEqual([]);
  });

  it('turns the field off for a browser that fixes capitals or spelling', async () => {
    await openConfirm();
    const field = confirmField();
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('autocapitalize')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(field.getAttribute('type')).toBe('text');
  });

  it('keeps the button shut when there is not enough room, even with the right word, and says how much is missing', async () => {
    await openConfirm({ [`GET /api/admin/backups/${NEWEST}`]: json(preview({ space: { needed: 3 * GIB, free: GIB, enough: false } })) });
    const reason = 'There is not enough free disk space to restore this backup (3 GB needed, 1 GB free). Free some space first.';
    expect(textOf(need(panel(), '#backups-restore-why'))).toBe(reason);
    type_('RESTORE');
    expect(restoreButton().disabled).toBe(true);
    expect(textOf(need(panel(), '#backups-restore-why'))).toBe(reason);
    restoreButton().click();
    await flush();
    expect(asked('POST', '/api/admin/backups/restore')).toEqual([]);
    expect(restoringShown()).toBe(false);
  });

  it('asks for the restore with the backup and the word, once, and then the restoring screen takes over', async () => {
    await openConfirm({ 'POST /api/admin/backups/restore': json({ ok: true, restarting: true, keepOldFor: '7 days' }, 202) });
    type_('RESTORE');
    restoreButton().click();
    expect(restoreButton().getAttribute('aria-disabled')).toBe('true');
    expect(restoreButton().getAttribute('aria-busy')).toBe('true');
    expect(confirmField().readOnly).toBe(true);
    restoreButton().click();
    await flush();
    const posts = asked('POST', '/api/admin/backups/restore');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ manifest: NEWEST, confirm: 'RESTORE' });
    expect(restoringShown()).toBe(true);
    const screen = need(browser.document.body, '.restoring');
    expect(textOf(need(screen, 'h1'))).toBe('Restoring…');
    expect(textOf(need(panel(), '.backups-screen'))).toBe('Restoring…');
    expect(root.inert).toBe(true);
  });

  it.each<[string, Reply, string]>([
    ['the safety backup failing', refuse(502, 'safety_backup_failed', { detail: 'S3 PUT failed (status 403, AccessDenied)' }), 'The backup of the current data that comes before a restore could not be made, so nothing was changed. Check that the backup storage is reachable, then try again.'],
    ['the disk being too small', refuse(507, 'not_enough_space', { needed: 3 * GIB, free: GIB }), 'There is not enough free disk space on the server (3 GB needed, 1 GB free). Free some space and try again.'],
    ['a restore a moment ago', refuse(429, 'rate_limited', {}, { 'retry-after': '540' }), 'Too many tries in a short time. Try again in 9 minutes.'],
    ['a restore already running', refuse(409, 'restore_in_progress'), 'A restore is already running. Wait until it is done, then try again.'],
    ['a word that did not match', refuse(400, 'confirmation_mismatch'), 'The confirmation did not match. Type RESTORE exactly, in capital letters.'],
    ['a damaged backup', refuse(422, 'tamper'), 'This backup failed its integrity check. It may be damaged or changed, so it cannot be used.'],
    ['a failure before anything changed', refuse(500, 'restore_failed'), 'The restore failed. If it keeps failing, look at the server log.'],
  ])('says %s in plain words and nothing else changes on screen', async (_what, reply, sentence) => {
    await openConfirm({ 'POST /api/admin/backups/restore': reply });
    type_('RESTORE');
    restoreButton().click();
    await flush();
    expect(alerts()).toEqual([sentence]);
    expect(restoringShown()).toBe(false);
    expect(restoreButton().disabled).toBe(false);
    expect(restoreButton().hasAttribute('aria-disabled')).toBe(false);
    expect(confirmField().readOnly).toBe(false);
    expect(textOf(panel())).not.toMatch(/safety_backup_failed|rate_limited|confirmation_mismatch|restore_in_progress/);
  });

  it.each<[string, Route]>([
    ['the server restarting after a failed swap', refuse(500, 'restore_failed', { restarting: true })],
    ['an answer lost on the way', 'network'],
    ['a gateway page while the server restarts', { status: 502, body: undefined }],
    ['the server already being in maintenance', refuse(503, 'restoring')],
  ])('shows the restoring screen for %s, because the restore may be running', async (_what, route) => {
    await openConfirm({ 'POST /api/admin/backups/restore': route });
    type_('RESTORE');
    restoreButton().click();
    await flush();
    expect(restoringShown()).toBe(true);
    expect(alerts()).toEqual([]);
  });

  it('sends a person whose session ended to sign-in', async () => {
    await openConfirm({ 'POST /api/admin/backups/restore': refuse(401, 'unauthenticated') });
    type_('RESTORE');
    restoreButton().click();
    await flush();
    expect(browser.location.hash).toBe('#/signin');
    expect(restoringShown()).toBe(false);
  });

  it('says why the confirmation could not load, and asks again on Retry', async () => {
    let tries = 0;
    await open(owner(), { [`GET /api/admin/backups/${NEWEST}`]: () => (++tries === 2 ? refuse(422, 'unknown_key') : json(preview())) });
    await pressDetails();
    control(panel(), 'Restore the whole workspace').click();
    await flush();
    expect(alerts()).toEqual(['This backup was sealed with an encryption key this server does not have, so it cannot be read. If the key was changed, the old one has to stay available as the previous key.']);
    expect(hasControl(panel(), 'Restore this backup')).toBe(false);
    control(panel(), 'Retry').click();
    await flush();
    expect(hasControl(panel(), 'Restore this backup')).toBe(true);
  });
});

// ------------------------------------------------------------------ accessibility

describe('accessibility', () => {
  const everyReferenceExists = () => {
    for (const el of root.querySelectorAll('[aria-describedby], [aria-labelledby], label[for]')) {
      const id = el.getAttribute('aria-describedby') ?? el.getAttribute('aria-labelledby') ?? el.getAttribute('for');
      expect(browser.document.getElementById(id!), `${el.tagName} points at #${id}`).not.toBeNull();
    }
  };

  it('has a name for every control and every field on every screen', async () => {
    const named = () => {
      for (const el of panel().querySelectorAll('button, a, input')) {
        const label = el.getAttribute('aria-label') ?? textOf(el) ?? '';
        const labelled = el.id && panel().querySelector(`label[for=${el.id}]`);
        expect(label.length > 0 || !!labelled, `${el.tagName} ${el.className} has a name`).toBe(true);
      }
    };
    await open();
    named();
    await pressDetails();
    named();
    control(panel(), 'Restore a board as a copy').click();
    await flush();
    named();
    control(panel(), 'Back to the backup').click();
    await flush();
    control(panel(), 'Restore the whole workspace').click();
    await flush();
    named();
    everyReferenceExists();
  });

  it('announces loading and results in live regions and errors as alerts', async () => {
    await openBoardCopy(owner(), { 'POST /api/admin/backups/restore-board': refuse(404, 'board_not_in_backup') });
    const result = need(panel(), '.backups-result');
    expect(result.getAttribute('aria-live')).toBe('polite');
    expect(result.getAttribute('role')).toBe('status');
    choose(need(panel(), 'input[type=radio]'));
    control(panel(), 'Make a copy').click();
    await flush();
    const problem = need(panel(), '[role="alert"]');
    expect(problem.parentNode!.classList.contains('backups-problem')).toBe(true);
  });

  it('shows the screens as headings of the right level under the tab heading', async () => {
    await open();
    expect(need(root, '.admin-heading').tagName).toBe('H2');
    expect(panel().querySelectorAll('h3')).not.toHaveLength(0);
    expect(need(panel(), '.backups').querySelectorAll('h1, h2, h4')).toHaveLength(0);
  });

  it('uses no colour or style of its own on the elements: classes only', async () => {
    await openConfirm();
    const styled = panel().querySelectorAll('[style]').map((el) => el.getAttribute('style'));
    expect(styled.filter((style) => !(style ?? '').startsWith('--cols: '))).toEqual([]);
  });
});

// ------------------------------------------------------------------ the global 503

describe('a restore seen from anywhere in the app', () => {
  it('puts the restoring screen up when any call is answered 503 restoring', async () => {
    await open(owner(), { 'GET /api/admin/backups': refuse(503, 'restoring') });
    expect(restoringShown()).toBe(true);
    expect(need(browser.document.body, '.restoring')).toBeTruthy();
  });

  it.each<[string, Reply]>([
    ['ai_unavailable', refuse(503, 'ai_unavailable')],
    ['a gateway page', { status: 503, body: undefined }],
    ['another JSON error', refuse(503, 'overloaded')],
  ])('does not for a 503 that is %s', async (_what, reply) => {
    await open(owner(), { 'GET /api/admin/backups': reply });
    expect(restoringShown()).toBe(false);
    expect(alerts()).toHaveLength(1);
  });

  it('shows it once however many calls are answered so', async () => {
    showRestoring({ probe: () => new Promise(() => undefined) });
    showRestoring({ probe: () => new Promise(() => undefined) });
    expect(browser.document.querySelectorAll('.restoring')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ the restoring screen

describe('the restoring screen', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  const healthAt: number[] = [];
  const health = (answers: Route[]) => {
    healthAt.length = 0;
    let i = 0;
    return serve({
      'GET /api/health': () => {
        healthAt.push(Date.now() - NOW);
        const next = answers[Math.min(i++, answers.length - 1)];
        return typeof next === 'function' ? next({ method: 'GET', path: '/api/health', body: undefined }) : (next as Reply);
      },
    });
  };
  const restoringAnswer = json({ ok: true, rooms: 0, connections: 0, restoring: true });
  const healthyAnswer = json({ ok: true, rooms: 0, connections: 0 });

  it('is a dialog with a title, a live status, and focus on the title', async () => {
    health([restoringAnswer]);
    showRestoring();
    const screen = need(browser.document.body, '.restoring');
    expect(screen.getAttribute('role')).toBe('dialog');
    expect(screen.getAttribute('aria-modal')).toBe('true');
    const title = need(screen, 'h1');
    expect(screen.getAttribute('aria-labelledby')).toBe(title.id);
    expect(textOf(title)).toBe('Restoring…');
    expect(browser.document.activeElement).toBe(title);
    const status = need(screen, '[role="status"]');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(textOf(status)).toBe('The server is restarting. This page asks every few seconds and reloads when it is back.');
    expect(need(screen, '.restoring-actions').hidden).toBe(true);
    expect(textOf(screen)).not.toMatch(/RESTORE\b/);
  });

  it('asks /api/health with growing waits and reloads on the first answer that is healthy and does not say restoring', async () => {
    health([restoringAnswer, 'network', refuse(502, 'bad_gateway'), restoringAnswer, healthyAnswer]);
    showRestoring();
    await vi.advanceTimersByTimeAsync(1999);
    expect(healthAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(healthAt).toEqual([2000]);
    expect(browser.location.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000 - 2000);
    expect(healthAt).toEqual([2000, 5000]);
    await vi.advanceTimersByTimeAsync(9500 - 5000);
    await vi.advanceTimersByTimeAsync(16_250 - 9500);
    expect(healthAt).toEqual([2000, 5000, 9500, 16_250]);
    expect(browser.location.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(26_375 - 16_250);
    expect(healthAt).toEqual([2000, 5000, 9500, 16_250, 26_375]);
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
    expect(textOf(need(browser.document.body, '.restoring [role="status"]'))).toBe('The server is back. Reloading…');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(healthAt).toHaveLength(5);
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
    expect(asked('GET', '/api/health').every((c) => c.method === 'GET')).toBe(true);
  });

  it('reads /api/health with the plain client, so an answer 503 restoring cannot start it again', async () => {
    health([refuse(503, 'restoring')]);
    showRestoring();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(browser.document.querySelectorAll('.restoring')).toHaveLength(1);
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it('does not reload while the server still says restoring, or says nothing a person could trust', async () => {
    health([restoringAnswer, { status: 200, body: undefined }, json({ ok: false }), json({}), json('ok')]);
    showRestoring();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(healthAt.length).toBeGreaterThanOrEqual(5);
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it('never asks faster than every two seconds, however long it goes on', async () => {
    health([restoringAnswer]);
    showRestoring();
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS);
    const gaps = healthAt.slice(1).map((at, i) => at - healthAt[i]);
    expect(Math.min(healthAt[0], ...gaps)).toBeGreaterThanOrEqual(2000);
    expect(Math.max(...gaps)).toBe(15_000);
    expect(healthAt.length).toBeLessThan(20);
  });

  it('gives up after three minutes with a clear message and a way to check again, and stops asking', async () => {
    health([restoringAnswer]);
    showRestoring();
    const screen = need(browser.document.body, '.restoring');
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS - 1);
    expect(need(screen, '.restoring-actions').hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(textOf(need(screen, '[role="status"]'))).toBe('This is taking longer than expected. The restore may still be running. Check again in a minute, or reload the page.');
    expect(need(screen, '.restoring-actions').hidden).toBe(false);
    expect(hasControl(screen, 'Check again')).toBe(true);
    expect(hasControl(screen, 'Reload the page')).toBe(true);
    const asks = healthAt.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(healthAt).toHaveLength(asks);
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it('asks again from the start when the person presses Check again, and reloads when the server is back', async () => {
    health([restoringAnswer]);
    showRestoring();
    const screen = need(browser.document.body, '.restoring');
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS);
    expect(healthAt.length).toBeGreaterThan(5);
    health([healthyAnswer]);
    const pressedAt = Date.now() - NOW;
    control(screen, 'Check again').click();
    expect(need(screen, '.restoring-actions').hidden).toBe(true);
    expect(textOf(need(screen, '[role="status"]'))).toContain('The server is restarting.');
    await vi.advanceTimersByTimeAsync(1999);
    expect(healthAt).toEqual([]);
    expect(browser.location.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(healthAt).toEqual([pressedAt + 2000]);
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads the page with the reload button', async () => {
    health([restoringAnswer]);
    showRestoring();
    await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS);
    control(need(browser.document.body, '.restoring'), 'Reload the page').click();
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload twice in a row by itself, so a page that keeps meeting a restore does not loop', async () => {
    browser.session.set('driftboard:restore-reload', String(NOW - 5000));
    health([healthyAnswer]);
    showRestoring();
    await vi.advanceTimersByTimeAsync(2000);
    expect(browser.location.reload).not.toHaveBeenCalled();
    const screen = need(browser.document.body, '.restoring');
    expect(textOf(need(screen, '[role="status"]'))).toBe('The server is back, but this page has just reloaded once already. Reload it yourself when you are ready.');
    expect(need(screen, '.restoring-actions').hidden).toBe(false);
  });

  it('reloads again when the last reload was a while ago, and remembers this one', async () => {
    browser.session.set('driftboard:restore-reload', String(NOW - 60_000));
    health([healthyAnswer]);
    showRestoring();
    await vi.advanceTimersByTimeAsync(2000);
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
    expect(browser.session.get('driftboard:restore-reload')).toBe(String(NOW + 2000));
  });

  it('keeps the page behind it out of reach while it shows', async () => {
    health([restoringAnswer]);
    showRestoring();
    expect(root.inert).toBe(true);
    hideRestoring();
    expect(root.inert).toBe(false);
    expect(browser.document.querySelectorAll('.restoring')).toEqual([]);
  });
});

// ------------------------------------------------------------------ a board closed with 4503

describe('a board whose socket the server closed with 4503', () => {
  function board() {
    const listeners: ((reason: DeniedReason) => void)[] = [];
    const conn = { onDenied: (fn: (reason: DeniedReason) => void) => (listeners.push(fn), () => undefined) };
    const handlers = { onSignIn: vi.fn<() => void>(), onRemoveLocal: vi.fn<() => void>(), onHome: vi.fn<() => void>() };
    const stop = mountAccessBanner(conn as never, asHtml(root), handlers);
    return { deny: (reason: DeniedReason) => listeners.forEach((fn) => fn(reason)), handlers, stop };
  }

  it('shows Restoring… and waits for the server instead of saying the access was removed', () => {
    serve();
    const b = board();
    b.deny('restoring');
    expect(restoringShown()).toBe(true);
    expect(textOf(need(browser.document.body, '.restoring h1'))).toBe('Restoring…');
    expect(browser.document.querySelectorAll('.access-banner')).toHaveLength(0);
    expect(textOf(browser.document.body)).not.toMatch(/access to this board was removed/i);
  });

  it.each<[DeniedReason, RegExp]>([
    ['access_removed', /access to this board was removed/],
    ['unauthenticated', /session has ended/],
    ['no_access', /don't have access/],
    ['not_found', /doesn't exist on the server/],
  ])('leaves %s as it was: a banner, and no restoring screen', (reason, words) => {
    serve();
    const b = board();
    b.deny(reason);
    expect(restoringShown()).toBe(false);
    expect(textOf(need(root, '.access-banner'))).toMatch(words);
  });
});

// ------------------------------------------------------------------ the Overview's billing block (TAB-226)

describe('the Overview of a hosted workspace', () => {
  async function openOverview(me: Me, payload: AdminOverview = overview) {
    serve({ 'GET /api/admin/overview': json(payload) });
    renderAdmin(asHtml(root), 'overview', me);
    await flush();
    return panel();
  }

  it('offers Manage billing to the owner, as before', async () => {
    await openOverview(owner(hosted()));
    expect(hasControl(panel(), 'Manage billing')).toBe(true);
    expect(textOf(panel())).toContain('Change the plan and update the payment method in the billing portal.');
    expect(textOf(panel())).not.toContain('add seats');
  });

  it('shows the localized trial end beside Manage billing while trialing', async () => {
    const trialEndsAt = '2026-11-07T15:00:00Z';
    const date = new Date(trialEndsAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    await openOverview(owner(hosted()), { ...overview, trialEndsAt, state: 'trialing' });
    expect(textOf(panel())).toContain(`Free trial until ${date}`);
  });

  it('offers no Manage billing on a workspace provided free, and says why', async () => {
    await openOverview(owner({ ...hosted()!, billing: false }));
    expect(hasControl(panel(), 'Manage billing')).toBe(false);
    expect(textOf(panel())).toContain("This workspace is provided free (education or internal). There's nothing to bill.");
  });
});
