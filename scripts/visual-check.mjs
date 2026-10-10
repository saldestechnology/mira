// Headless visual QA: screenshots of named app states across widths and themes, with no shared browser.
// It starts its own throwaway relay (fresh data folder, free port), seeds one fixed board through the app's ?debug
// handle, drives headless Chromium and writes tabula-review/<id>/<state>-<theme>-<width>.png plus an index.html.
// Usage and options: docs/visual-check.md.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WIDTHS = [360, 390, 500, 860, 1024, 1280, 1440];
// VISUAL_HEIGHT=390 npm run visual ... forces one window height for every width (a short landscape phone: --widths 844)
const heightFor = (width) => Number(process.env.VISUAL_HEIGHT) || (width <= 500 ? 844 : 800);
const BOARD_ID = 'visual-seed';
const OWNER_EMAIL = 'owner@example.test';
const USER = { id: 'visual-user', name: 'Visual QA', color: '#2F6FED' };
// The browser clock stands still here, so "5 min ago" and the like read the same in every run.
const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OTHER_BOARDS = [
  { id: 'visual-notes', title: 'Meeting notes', ago: 3 * 24 * HOUR },
  { id: 'visual-roadmap', title: 'Roadmap 2026', ago: 3 * HOUR },
];
const SEED_TITLE = 'Sprint retro';

const USAGE = `Usage: npm run visual -- --id TAB-123 [options]

  --id <id>          Review folder name, e.g. TAB-123 (required)
  --mode <mode>      open (default) or accounts
  --states <list>    Comma separated, default all for the mode: home, board, tracker-foundation, tracker-frame-overview, tracker-frame-work, tracker-frame-fullscreen, tracker-fullscreen, tracker-all-issues, tracker-filter-open, tracker-picker-open, tracker-new-issue, tracker-phone, tracker-phone-new-issue, tracker-keyboard, tracker-inbox, tracker-inbox-empty, tracker-inbox-loading, tracker-inbox-error, tracker-inbox-long-list, tracker-inbox-narrow, tracker-notification-prefs, uml-arrows-themes, connector-heads, esc-trays, board-selected, group-selected, group-selected-zoom, group-entered-zoom, group-multi, group-selected-tray, group-entered-tray, group-menu-tray, group-multi-menu-tray, group-menu, rail-end, rail-overlap, touch-targets, group-hover, group-entered, group-locked, emoji-text, emoji-picker, emoji-keyboard, emoji-keyboard-high, emoji-tap, emoji-insert, emoji-esc, press-board, press-poll, press-timer, press-comments, press-admin, top-bars-320, quickbar-multi, quickbar-multi-end, flow-write, flow-poll, flow-steps, templates-esc, steps-toast, flow-steps-overlap, rail-scroll-cue, flow-steps-overlap-edit, flow-steps-overlap-many, vote-setup, vote-running, vote-running-touch, vote-running-touch-steps, comments, templates, settings, in open
                     mode presence-avatars-many, kanban, kanban-card, kanban-drag, kanban-drag-empty, kanban-keyboard, kanban-adding, kanban-wip,
                     kanban-lowdetail, kanban-dialog, kanban-labels, kanban-labels-colour, kanban-full-card, kanban-convert, kanban-lane-menu,
                     kanban-menu, kanban-filter, kanban-filter-on, kanban-wip-block, kanban-wip-refused, kanban-addlane, kanban-sheet, resize-guides-size,
                     kanban-sheet-filter, kanban-card-meta, kanban-sheet-meta, kanban-sheet-adding, kanban-sheet-full, kanban-sheet-viewer, kanban-lane-drag, kanban-lane-no-anchors, ai-review, ai-preview-empty, text-handles, flip-menu, flip-visual, paste-text, text-scale-touch, ai-live-remote-ring, ai-live-remote-preview, ai-key-test, ai-key-test-error, kanban-moveto, kanban-moveto-full, kanban-templates, comment-thread, and in accounts mode admin, admin-tokens, ai-key-me, ai-key-me-openai, ai-key-me-openai-bad, ai-key-me-openai-saved, ai-key-me-anthropic-saved (Your AI key) and ai-admin, ai-admin-openai, ai-admin-openai-bad, ai-admin-openai-saved, ai-admin-anthropic-saved (the admin AI tab), ai-key-me-keyboard and ai-admin-keyboard (keyboard only), backups-list, backups-detail, backups-board-copy,
                     backups-confirm, backups-restoring, backups-off, join-short-code, share-code-phone, chat, chat-composer, chat-unread, chat-page, chat-page-team,
                     chat-home, chat-admin, chat-react, chat-mention, chat-notifications, chat-members, chat-object, chat-session, chat-poll, chat-poll-overlap (the chat states
                     turn on TABULA_CHAT)
  --widths <list>    Default ${DEFAULT_WIDTHS.join(',')}
  --themes <list>    Default all themes in src/themes.ts
  --dark | --light   Only themes with that colour scheme
  --touch            Emulate a touch device (useful for an iPad-sized viewport)
  --out <dir>        Parent folder, default tabula-review (shots go to <dir>/<id>/)
  --no-build         Reuse an existing dist/ instead of running npm run build:app
  --frameable        Start the throwaway relay with TABULA_DEV_ALLOW_FRAMING=1
`;

class UsageError extends Error {
  constructor(message, showUsage = true) {
    super(message);
    this.showUsage = showUsage;
  }
}

const list = (value) => value.split(',').map((v) => v.trim()).filter(Boolean);

function readThemes() {
  const source = fs.readFileSync(path.join(root, 'src', 'themes.ts'), 'utf8');
  const themes = [...source.matchAll(/id: '([\w-]+)',\s*name: '([^']*)',\s*scheme: '(light|dark)'/g)].map(([, id, name, scheme]) => ({ id, name, scheme }));
  if (!themes.length) throw new Error('could not read the themes from src/themes.ts');
  return themes;
}

function readHeads() {
  const source = fs.readFileSync(path.join(root, 'src', 'shapes.ts'), 'utf8');
  const start = source.indexOf('export const HEADS:');
  const heads = [...source.slice(start).matchAll(/\{ head: '([\w-]+)', label: '([^']*)' \}/g)].map(([, head, label]) => ({ head, label }));
  if (!heads.length) throw new Error('could not read connector heads from src/shapes.ts');
  return heads;
}

// ---------------------------------------------------------------- states

async function openEmojiPickerForNote(env, { clearPoll = false, frameNote = false, objectId = 'seed-note-1' } = {}) {
  await openSeedBoard(env);
  if (clearPoll) await env.page.keyboard.press('Escape');
  if (frameNote) {
    await env.page.evaluate((id) => {
      const app = window.__board;
      app.scope = null;
      app.setSelection([id]);
      app.zoomToSelection();
    }, objectId);
    await env.page.waitForTimeout(180);
    await env.page.evaluate(() => window.__board.zoomTo(0.8));
  }
  await env.page.evaluate((id) => window.__board.editor.start(id), objectId);
  await env.page.locator('.edit-bar.show').waitFor();
  await env.page.waitForFunction(() => {
    const textarea = document.querySelector('.text-editor');
    return textarea && document.activeElement === textarea && textarea.selectionStart === 0 && textarea.selectionEnd === textarea.value.length;
  });
  await env.page.locator('.text-editor').press('End');
  await env.page.getByRole('button', { name: 'Add emoji' }).click();
  await env.page.locator('.emoji-pop').waitFor();
}

/** The soft keyboard shrinks the visual viewport (not the window): the bar and the picker must stay in what is left, clear of the top bars. */
async function emojiKeyboard(env, noteTop) {
  const page = env.page;
  await openSeedBoard(env);
  await page.evaluate(() => {
    window.__kb = 0;
    const real = window.visualViewport;
    const vv = new Proxy(real, { get(t, k) { if (k === 'height') return window.innerHeight - window.__kb; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
    Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true });
    window.__board.editor.start('seed-note-1');
  });
  await page.locator('.edit-bar.show').waitFor();
  if (noteTop !== null) {
    // pan so the note sits near the top of the screen, as on a phone where the board is zoomed on its first notes
    await page.evaluate((top) => {
      const app = window.__board;
      const now = document.querySelector('.text-editor').getBoundingClientRect().top;
      app.r.setCamera({ y: app.r.cam.y + (now - top) / app.zoom });
    }, noteTop);
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => { window.__kb = 300; window.visualViewport.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Add emoji' }).click();
  await page.locator('.emoji-pop').waitFor();
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const visible = innerHeight - window.__kb;
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    const bar = box('.edit-bar.show'), pop = box('.emoji-pop'), search = document.querySelector('.emoji-pop [aria-label="Search emoji"]').getBoundingClientRect();
    const failures = [];
    if (bar.bottom > visible) failures.push(`the Add emoji bar ends at ${Math.round(bar.bottom)}, under the keyboard (${visible} visible)`);
    if (pop.bottom > visible) failures.push(`the picker ends at ${Math.round(pop.bottom)}, under the keyboard (${visible} visible)`);
    if (search.bottom > visible || search.height < 40) failures.push('the search field is under the keyboard or squeezed');
    if (pop.height < 200) failures.push(`the picker is only ${Math.round(pop.height)} px tall`);
    for (const sel of ['.top-left', '.top-right']) {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (r && bar.left < r.right && bar.right > r.left && bar.top < r.bottom && bar.bottom > r.top) failures.push(`the Add emoji bar is under ${sel}`);
    }
    return { failures, visible, bar: { top: bar.top, bottom: bar.bottom }, pop: { top: pop.top, bottom: pop.bottom }, viewport: `${innerWidth}x${innerHeight}` };
  });
  console.log(`emoji-keyboard ${JSON.stringify(result)}`);
  if (result.failures.length) throw new Error(`emoji-keyboard: ${JSON.stringify(result.failures)}`);
}

// Pending Fontshare stylesheets and the fonts that follow them are the only thing that changes the picture after load.
const settle = (page) =>
  page.evaluate(async () => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pending = [...document.querySelectorAll('link[rel="stylesheet"]')].filter((link) => !link.sheet);
    await Promise.all(pending.map((link) => new Promise((resolve) => {
      link.addEventListener('load', resolve);
      link.addEventListener('error', resolve);
    })));
    await frames();
    await document.fonts.ready;
    await frames();
  });

// A moved mouse or a focused control would leave a tooltip or hover state in the shot.
const park = async (page) => {
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.activeElement?.blur());
};

/** Runs inside the page (serialised by Playwright): creates the fixed board once. Returns false when it is already there. */
function seedBoard({ boardTitle, at }) {
  const app = window.__board;
  const store = app.store;
  if (store.get('seed-title')) return false;
  const body = store.getMeta().bodyFont;
  const heading = store.getMeta().headingFont;
  const objs = [];
  const add = (id, type, x, y, w, h, extra) => objs.push({ id, type, x, y, w, h, rotation: 0, z: '', createdBy: 'visual-seed', updatedAt: at, font: body, ...extra });
  const frame = (id, name, x, fill) => add(id, 'frame', x, 0, 440, 520, { name, fill, font: heading });
  const note = (id, text, x, y, fill, parent) => add(id, 'sticky', x, y, 160, 160, { text, fill, parent, fontSize: 18 });
  const shape = (id, kind, text, x, y, w, h, fill) => add(id, 'shape', x, y, w, h, { kind, text, fill });
  const bound = (id, side) => ({ kind: 'bound', id, anchor: side });
  const link = (id, from, to, extra) => objs.push({ id, type: 'connector', z: '', from, to, route: 'elbow', startHead: 'none', endHead: 'arrow', createdBy: 'visual-seed', updatedAt: at, ...extra });

  add('seed-title', 'text', 0, -130, 640, 52, { text: boardTitle, fontSize: 40, fontWeight: 700, font: heading });
  add('seed-subtitle', 'text', 0, -72, 640, 24, { text: 'Week 12: what to keep, what to change', fontSize: 17, textColor: '#5B6672' });
  frame('seed-frame-good', 'Went well', 0, '#E6F7EF');
  frame('seed-frame-bad', 'To improve', 480, '#FFE9E0');
  note('seed-note-1', 'Reviews were fast', 32, 64, '#FFE16B', 'seed-frame-good');
  note('seed-note-2', 'Clear sprint goal', 248, 64, '#BCE88C', 'seed-frame-good');
  note('seed-note-3', 'Pairing on the hard bits', 32, 264, '#8FE3CA', 'seed-frame-good');
  note('seed-note-4', 'Too many meetings', 512, 64, '#FFA3C4', 'seed-frame-bad');
  note('seed-note-5', 'Flaky tests', 728, 64, '#FFB979', 'seed-frame-bad');
  note('seed-note-6', 'Unclear ownership', 512, 264, '#CDB8FF', 'seed-frame-bad');
  shape('seed-rect', 'rect', 'Backlog', 0, 660, 160, 80, '#DCEBFF');
  shape('seed-diamond', 'diamond', 'Ready?', 280, 612, 144, 144, '#FFF2C2');
  shape('seed-ellipse', 'ellipse', 'Done', 280, 800, 144, 144, '#DDF5E8');
  shape('seed-rounded', 'rounded', 'Review', 560, 652, 176, 64, '#ECE4FF');
  add('seed-label', 'text', 560, 740, 240, 24, { text: 'Flow of work', fontSize: 16, textColor: '#5B6672' });
  link('seed-conn-1', bound('seed-rect', 'right'), bound('seed-diamond', 'left'));
  link('seed-conn-2', bound('seed-rect', 'right'), bound('seed-ellipse', 'left'));
  link('seed-conn-3', bound('seed-diamond', 'bottom'), bound('seed-ellipse', 'top'), { route: 'straight', label: 'yes' });
  link('seed-conn-4', bound('seed-diamond', 'right'), bound('seed-rounded', 'left'));
  link('seed-conn-5', bound('seed-note-2', 'right'), bound('seed-note-4', 'left'), { route: 'curved', dash: 'dashed' });

  const zs = store.topZs(objs.length);
  objs.forEach((o, i) => (o.z = zs[i]));
  store.transact(() => {
    store.setMeta({ name: boardTitle });
    objs.forEach((o) => store.create(o));
  });
  return true;
}

async function seedComments(page, fresh) {
  if (!fresh) {
    const arrived = await page.waitForFunction(() => window.__board.comments.list().length > 0, null, { timeout: 3000 }).catch(() => null);
    if (arrived) return;
  }
  const author = await page.evaluate(async () => {
    const res = await fetch('/api/me').catch(() => null);
    const me = res?.ok ? await res.json() : null;
    const user = window.__board.user;
    return me ? { id: me.user.id, name: me.user.name, color: user.color } : { id: user.id, name: user.name, color: user.color };
  });
  await page.clock.setFixedTime(NOW - 30 * MINUTE);
  const threadId = await page.evaluate((who) => {
    const anchor = { x: 192, y: 64, obj: 'seed-note-1', fx: 1, fy: 0 };
    return window.__board.comments.addThread(who, anchor, 'Can we keep this one for the next sprint too?');
  }, author);
  await page.clock.setFixedTime(NOW - 25 * MINUTE);
  await page.evaluate(({ who, id }) => window.__board.comments.reply(id, who, 'Yes, it is cheap to keep.'), { who: author, id: threadId });
  await page.clock.setFixedTime(NOW);
}

const EMPTY_ID = 'visual-empty';
/** The second person of the last empty-focus shot. */
let focusSender = null;

/** A board nobody writes to: the empty-board hint shows. */
async function openEmptyBoard({ page, base }, query = '?debug') {
  await page.goto(`${base}/${query}#/b/${EMPTY_ID}`);
  await page.waitForFunction(() => window.__board, null, { timeout: 15_000 });
  await page.locator('.empty-hint').waitFor();
}

async function openSeedBoard({ page, base }, query = '?debug') {
  await page.goto(`${base}/${query}#/b/${BOARD_ID}`);
  await page.waitForFunction(() => window.__board, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const provider = window.__board.conn.provider;
    return !provider || provider.synced;
  }, null, { timeout: 15_000 });
  const fresh = await page.evaluate(seedBoard, { boardTitle: SEED_TITLE, at: NOW - HOUR });
  await seedComments(page, fresh);
  await page.evaluate(() => {
    const app = window.__board;
    // the relay keeps what an earlier shot hid (layers-hidden)
    const hidden = [...app.store.cache.values()].filter((o) => o.hidden).map((o) => o.id);
    if (hidden.length) app.setHidden(hidden, false);
    // ...and so does a session, a vote or a poll an earlier shot left running, with its dots: each state starts from an idle bar, or
    // vote-setup finds its button ending a vote instead of opening the panel, and a chat tray sits behind a bar it never started
    const f = app.store.getFlow();
    if (f.active >= 0 || f.steps.length || f.results) {
      app.flow.end();
      app.flow.clearResults();
      app.store.setFlow({ active: -1, timer: null, reveal: false, results: null, steps: [] });
    }
    app.setSelection([]);
    app.zoomToFit();
  });
}

/**
 * Hands the page a message of the relay's AI runs (6 is MSG_AI_RUNS), through the handler the page registered for it, so the
 * live layer draws another person's runs without a model or a second browser. Needs `?debug`.
 */
async function handAiRuns(page, runs) {
  await page.evaluate((list) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'snapshot', runs: list }));
    const arr = new Uint8Array(bytes.length + 5);
    let n = bytes.length, i = 0;
    while (n > 127) { arr[i++] = (n & 127) | 128; n >>>= 7; }
    arr[i++] = n;
    arr.set(bytes, i);
    window.__board.conn.provider.messageHandlers[6](null, { arr, pos: 0, len: i + bytes.length });
  }, runs);
}

// someone else's run, in amber: the person colour with the least contrast on a light canvas (docs/ai-toolbar.md, "Colour")
const ANA = { id: 'visual-ana', name: 'Ana', color: '#C98A00' };

// TAB-198: the layers panel on the seed board with one frame closed and the other open
async function openLayers(env, hide = []) {
  const { page } = env;
  await page.addInitScript(({ key, closed }) => {
    try {
      localStorage.setItem(key, JSON.stringify(closed));
    } catch {
      /* storage is not available in this frame */
    }
  }, { key: `driftboard:layers-collapsed:${BOARD_ID}`, closed: ['seed-frame-bad'] });
  await openSeedBoard(env);
  if (hide.length) await page.evaluate((ids) => window.__board.setHidden(ids, true), hide);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.locator('[role="tree"] [role="treeitem"]').first().waitFor();
}

// ---------------------------------------------------------------- backups (accounts mode)

// The throwaway relay has no bucket, so the Backups tab is shown from fixed answers to the backup routes. The relay itself
// answers `backups_off`, which is what backups-off shows.
const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;
const BACKUP_KEY = 'a1b2c3d4';
const stamp = (at) => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const manifestName = (at) => `${stamp(at)}.json.enc`;
const BACKUPS = [
  { at: NOW - 30 * MINUTE, files: 14, bytes: 4_823_552, protectedUntil: NOW + 6 * 24 * HOUR },
  { at: NOW - 90 * MINUTE, files: 14, bytes: 4_811_264 },
  { at: NOW - 150 * MINUTE, files: 13, bytes: 4_790_000, unreadable: 'unknown_key' },
  { at: NOW - 27 * HOUR, files: 12, bytes: 4_201_113 },
  { at: NOW - 3 * 24 * HOUR, files: 12, bytes: 3_998_000, protectedUntil: NOW + 3 * 24 * HOUR },
  { at: NOW - 9 * 24 * HOUR, files: 9, bytes: 2_104_330 },
  { at: NOW - 21 * 24 * HOUR, files: 7, bytes: 1_240_000, unreadable: 'tamper' },
].map((b) => ({
  name: manifestName(b.at),
  createdAt: Math.floor(b.at / 1000) * 1000,
  protected: b.protectedUntil !== undefined,
  protectedUntil: b.protectedUntil ?? null,
  ...(b.unreadable ? { readable: false, error: b.unreadable } : { readable: true, files: b.files, bytes: b.bytes, keyId: BACKUP_KEY }),
}));
const BACKUP_LIST = {
  backups: BACKUPS,
  truncated: false,
  status: {
    lastSuccessAt: NOW - 30 * MINUTE, lastFailureAt: null, lastFailureError: null, consecutiveFailures: 0, nextRunAt: NOW + 30 * MINUTE,
    running: false, intervalMinutes: 60, keyId: BACKUP_KEY, bytesStored: 18_874_368, objects: 52, manifests: BACKUPS.length,
  },
  restore: {
    inProgress: null,
    maintenance: false,
    last: { kind: 'workspace', result: 'done', at: NOW - 3 * 24 * HOUR + 5 * MINUTE, manifest: BACKUPS[4].name, keepOldFor: '7 days' },
    protectedBackups: [],
    oldData: [],
  },
};
const BACKUP_BOARDS = {
  boards: [
    ['roadmap', 'Roadmap 2026', 'team-design', 'Design', false],
    ['retro', 'Sprint retro', 'team-design', 'Design', false],
    ['notes', 'Meeting notes', null, null, false],
    ['launch', 'Launch plan for the spring campaign across every region and every channel we use', 'team-growth', 'Growth', false],
    ['onboarding', 'Customer onboarding journey', 'team-growth', 'Growth', true],
    ['ideas', 'Ideas', null, null, false],
  ].map(([id, title, teamId, teamName, deleted]) => ({ id, title, teamId, teamName, deleted })),
  truncated: false,
};
const backupPreview = (name) => ({
  name, createdAt: BACKUPS.find((b) => b.name === name)?.createdAt ?? NOW, appVersion: '0.1.0', keyId: BACKUP_KEY, files: 14, bytes: 4_823_552, boards: 6,
  protected: true, confirmWord: 'RESTORE', keepOldFor: '7 days', reason: 'There is room on the disk, so the old data is kept for 7 days.',
  space: { needed: 2 * 4_823_552 + 64 * MIB, free: 21 * GIB, enough: true },
});

/** Answers the backup routes (and, for the restoring screen, the restore and /api/health) from the fixed data above. */
async function mockBackups(page, { restoring = false } = {}) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/admin/backups**', (route) => {
    const { pathname } = new URL(route.request().url());
    const rest = pathname.replace(/^\/api\/admin\/backups\/?/, '');
    if (route.request().method() === 'POST') {
      return rest === 'restore' ? json(route, { ok: true, restarting: true, keepOldFor: '7 days' }, 202) : json(route, { error: 'bad_request', message: 'not used' }, 400);
    }
    if (rest === '') return json(route, BACKUP_LIST);
    if (rest.endsWith('/boards')) return json(route, BACKUP_BOARDS);
    return json(route, backupPreview(rest));
  });
  if (restoring) await page.route('**/api/health', (route) => json(route, { ok: true, rooms: 0, connections: 0, restoring: true }));
}

const waitForAdminPanel = (page) =>
  page.waitForFunction(() => {
    const panel = document.querySelector('.admin-panel');
    return panel && !panel.textContent.includes('Loading');
  });

async function openBackup({ page, base }) {
  await mockBackups(page, { restoring: true });
  await page.goto(`${base}/#/admin/backups`);
  await page.locator('.backups-row').first().waitFor();
  await page.getByRole('button', { name: /^Details of the backup/ }).first().click();
  await page.getByRole('button', { name: 'Restore the whole workspace' }).waitFor();
}

// ---------------------------------------------------------------- chat (accounts mode, TABULA_CHAT=on)

/**
 * Opens the seeded board's Chat tab. The owner's read marker goes back to where the seed put it first, because the
 * previous shot read the whole channel, and the "New messages" line belongs in every shot.
 */
async function openSeedChat(env) {
  const { page, chat } = env;
  await resetChatMarker(env);
  await openSeedBoard(env);
  await page.locator('.chat-toggle').click();
  await page.waitForFunction((n) => document.querySelectorAll('.side-tray.show .chat-msg').length >= n, chat.count);
  await page.locator('.chat-new').waitFor();
}

async function resetChatMarker({ chat, dataDir }) {
  if (!chat) throw new Error('the chat states need --mode accounts');
  await withChatDb(dataDir, (db) => {
    db.prepare('UPDATE chat_reads SET last_id = ? WHERE user_id = ? AND kind = ? AND ref = ?').run(chat.readUpTo, chat.ownerId, 'board', BOARD_ID);
    // the team and workspace channels start unread in every shot
    db.prepare("UPDATE chat_reads SET last_id = 0 WHERE user_id = ? AND kind IN ('team', 'workspace')").run(chat.ownerId);
  });
}

async function withChatDb(dataDir, fn) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'chat.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

async function apiJson(base, verb, route, body, cookie) {
  const headers = { accept: 'application/json', 'x-tabula': '1', ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  const init = { method: verb, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}/api/${route}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${verb} /api/${route} answered ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Signs a person in over the API (through a team invite when there is one) and gives them a name. Returns the cookie. */
async function signInAs({ base, dataDir }, email, name, invite) {
  await postJson(base, 'auth/request', invite ? { email, invite } : { email });
  const verified = await postJson(base, 'auth/verify', { token: await readLoginToken(dataDir) });
  const cookie = verified.headers.getSetCookie()[0].split(';')[0].trim();
  await postJson(base, 'me', { name }, cookie, 'PATCH');
  return cookie;
}

/**
 * Two more people join a team the seeded board is shared with, and the three talk in its chat through the REST API,
 * each with their own session: an edited message, a deleted one, a reply, mentions, a long link and a day break. The
 * server stamps the real time, so the times are then moved next to the browser's fixed clock in chat.sqlite.
 */
async function seedChat(relay, ownerCookie) {
  const { base } = relay;
  const me = await apiJson(base, 'GET', 'me', undefined, ownerCookie);
  const team = await apiJson(base, 'POST', 'teams', { name: 'Retro team' }, ownerCookie);
  const join = async (email, name) => {
    const invite = await apiJson(base, 'POST', `teams/${team.id}/invites`, { role: 'member' }, ownerCookie);
    await sleep(50);
    return signInAs(relay, email, name, invite.token);
  };
  const ana = await join('ana@example.test', 'Ana Lima');
  const ben = await join('ben@example.test', 'Ben Okafor');
  await apiJson(base, 'POST', `boards/${BOARD_ID}/shares`, { principalType: 'team', principalId: team.id, role: 'editor' }, ownerCookie);
  const ids = {};
  for (const [cookie, who] of [[ana, 'ana'], [ben, 'ben']]) ids[who] = (await apiJson(base, 'GET', 'me', undefined, cookie)).user.id;
  ids.owner = me.user.id;

  const route = `chat/board/${BOARD_ID}/messages`;
  let n = 0;
  // a pause before each, so the posting burst limit (five in two seconds) never answers 429
  const say = async (cookie, text, extra = {}) => {
    await sleep(450);
    return (await apiJson(base, 'POST', route, { clientId: `visual-seed-${++n}`, text, ...extra }, cookie)).message.id;
  };
  const times = [];
  const at = (id, time, extra = {}) => times.push({ id, time, ...extra });
  const DAY = 24 * HOUR;

  at(await say(ana, 'Retro notes are on the board. Can everyone add their stickies before tomorrow?'), NOW - DAY + 6 * HOUR + 2 * MINUTE);
  at(await say(ana, 'The flow we talked about: https://www.figma.com/file/AbCdEfGhIjKlMnOpQrStUv/Checkout-flow-v3?node-id=1234-5678&mode=design&t=averyveryverylongtokenvalue0123456789'), NOW - DAY + 6 * HOUR + 3 * MINUTE);
  const willDo = await say(ben, 'Will do, after lunch.');
  at(willDo, NOW - DAY + 6 * HOUR + 20 * MINUTE);
  at(await say(ownerCookie, 'Thanks Ana, mine are in.'), NOW - DAY + 6 * HOUR + 21 * MINUTE);
  const question = await say(ben, 'Are we starting at ten?');
  at(question, NOW - 48 * MINUTE);
  const answer = await say(ownerCookie, `Yes, ten sharp. @{${ids.ben}} can you share your screen?`, { replyTo: question });
  at(answer, NOW - 46 * MINUTE);
  const flaky = await say(ana, `Flaky tests are mine, I'll take that action. @{${ids.owner}}`);
  at(flaky, NOW - 20 * MINUTE, { edited: NOW - 18 * MINUTE });
  const late = await say(ana, 'Running five minutes late, sorry!');
  at(late, NOW - 2 * MINUTE);
  // two messages that point at objects: one on the board, one that was deleted from it
  const look = await say(ana, 'Look at the first sticky, it needs a better headline.', { objectId: 'seed-note-1' });
  at(look, NOW - 100_000); // after `late`: the tray lists by id, so the times must rise with it
  const gone = await say(ben, 'And the old backlog box I moved away.', { objectId: 'deleted-long-ago' });
  at(gone, NOW - MINUTE);

  await apiJson(base, 'PATCH', `chat/messages/${flaky}`, { text: `Flaky tests are mine, I'll take the action point. @{${ids.owner}}` }, ana);
  await apiJson(base, 'DELETE', `chat/messages/${willDo}`, undefined, ben);
  // reactions under three messages, from the three of them
  const react = (cookie, id, emoji) => apiJson(base, 'PUT', `chat/messages/${id}/reactions/${encodeURIComponent(emoji)}`, undefined, cookie);
  await react(ben, question, '👍');
  await react(ana, question, '👍');
  await react(ownerCookie, flaky, '✅');
  await react(ben, flaky, '✅');
  await react(ownerCookie, late, '👀');
  await apiJson(base, 'PUT', `chat/board/${BOARD_ID}/read`, { lastId: answer }, ownerCookie);

  // the team channel and the workspace channel (the Chat page): the owner is caught up first, so what is said next is unread
  await apiJson(base, 'GET', 'chat/channels', undefined, ownerCookie);
  // a pause before each, so the per-person posting limit (a burst of five) never answers 429
  const sayIn = async (route, cookie, text) => {
    await sleep(700);
    return (await apiJson(base, 'POST', route, { clientId: `visual-seed-${++n}`, text }, cookie)).message.id;
  };
  const teamRoute = `chat/team/${team.id}/messages`;
  const workspaceRoute = 'chat/workspace/main/messages';
  at(await sayIn(teamRoute, ana, 'The design review moved to Thursday at 14:00.'), NOW - 3 * HOUR);
  at(await sayIn(teamRoute, ben, 'I can present the checkout flow.'), NOW - 2 * HOUR - 40 * MINUTE);
  at(await sayIn(teamRoute, ana, `@{${ids.owner}} can you confirm the room?`), NOW - 25 * MINUTE);
  at(await sayIn(workspaceRoute, ben, 'The office is closed on Friday for the offsite.'), NOW - DAY - 2 * HOUR);
  at(await sayIn(workspaceRoute, ana, 'Reminder: expense reports are due this week.'), NOW - 5 * HOUR);

  await withChatDb(relay.dataDir, (db) => {
    const move = db.prepare('UPDATE chat_messages SET created_at = ?, edited_at = CASE WHEN edited_at IS NULL THEN NULL ELSE ? END, deleted_at = CASE WHEN deleted_at IS NULL THEN NULL ELSE ? END WHERE id = ?');
    for (const t of times) move.run(t.time, t.edited ?? t.time, t.time + MINUTE, t.id);
  });
  return { ownerId: ids.owner, readUpTo: answer, count: times.length - 5, teamId: team.id, anaCookie: ana, questionId: question };
}


// ---------------------------------------------------------------- kanban (docs/kanban.md, slice 2)

const KANBAN_ID = 'visual-kanban';

/** Runs inside the page: a kanban like the design mock's, once. Card heights are stored the way the app stores them. */
function seedKanban({ at }) {
  const app = window.__board;
  const store = app.store;
  if (store.get('k-box')) return false;
  const body = store.getMeta().bodyFont;
  const heading = store.getMeta().headingFont;
  const z = store.topZ();
  const base = { rotation: 0, z, createdBy: 'visual-seed', updatedAt: at };
  const lanes = [
    { id: 'k-todo', name: 'To do', stage: 'todo' },
    { id: 'k-doing', name: 'Doing', stage: 'doing', fill: 'blue', wip: 3 },
    { id: 'k-review', name: 'Review', wip: 2, wipMode: 'block' },
    { id: 'k-done', name: 'Shipped', stage: 'done', fill: 'green' },
  ];
  const cards = {
    'k-todo': [
      { id: 'k-c1', text: 'Write the migration guide for teams moving sprint boards from spreadsheets, with the CSV column mapping and the formula guards', labels: ['docs'], ownerName: 'Lea Brandt' },
      { id: 'k-c2', text: 'Fix the login loop on Safari 17', fill: '#FFA3C4', labels: ['bug', 'ui', 'urgent', 'chore'], due: '2026-01-16', ownerName: 'Visual QA', ownerId: 'visual-user' },
      { id: 'k-c3', text: 'Spike: caching' },
      { id: 'k-c4', text: 'Pick the beta cohort', due: '2026-01-19', ownerName: 'Ana Novak' },
    ],
    'k-doing': [
      { id: 'k-d1', text: 'Card dialog: owner picker', labels: ['feature'], due: '2026-01-12', ownerName: 'Visual QA', ownerId: 'visual-user' },
      { id: 'k-d2', text: 'Lane menu and WIP warning', labels: ['feature'], due: '2026-01-15', ownerName: 'Marta Ruiz' },
      { id: 'k-d3', text: 'CSV export with formula guards', labels: ['bug'], ownerName: 'Visual QA', ownerId: 'visual-user' },
    ],
    'k-review': [],
    'k-done': [
      { id: 'k-e1', text: 'Copy shared/ into the Docker image', due: '2026-01-13', ownerName: 'Visual QA', ownerId: 'visual-user', labels: ['chore'] },
      { id: 'k-e2', text: 'Spec review', labels: ['docs'] },
    ],
  };
  const labels = [['bug', 'Bug', 'pink'], ['feature', 'Feature', 'blue'], ['ui', 'Frontend', 'teal'], ['urgent', 'Urgent', 'orange'], ['docs', 'Docs', 'violet'], ['chore', 'Chore', 'grey']];
  const keys = ['a0', 'a1', 'a2', 'a3', 'a4'];
  const objs = [{ ...base, id: 'k-box', type: 'container', layout: 'kanban', name: 'Q4 delivery', x: 0, y: 0, w: 1200, h: 600, font: heading }];
  lanes.forEach((l, i) => objs.push({ ...base, ...l, type: 'lane', parent: 'k-box', rank: `${keys[i]}@k-box`, x: 0, y: 0, w: 280, h: 200, font: body }));
  for (const [lane, list] of Object.entries(cards)) {
    list.forEach((c, i) => {
      const card = { ...base, ...c, type: 'card', parent: lane, rank: `${keys[i]}@${lane}`, x: 0, y: 0, w: 264, h: 0, font: body };
      card.h = window.__kanban.cardContentHeight(card, 264);
      objs.push(card);
    });
  }
  // ordinary objects beside it, as in the mock
  objs.push({ ...base, id: 'k-frame', type: 'frame', name: 'Ideas', x: -220, y: 0, w: 176, h: 276, fill: '#FFFFFF', font: heading });
  objs.push({ ...base, id: 'k-note-1', type: 'sticky', text: 'Card ageing in Doing?', x: -204, y: 16, w: 104, h: 104, fill: '#FFE16B', parent: 'k-frame', font: body, fontSize: 14 });
  objs.push({ ...base, id: 'k-note-2', type: 'sticky', text: 'Swimlanes by owner', x: -164, y: 152, w: 104, h: 104, fill: '#8FE3CA', parent: 'k-frame', font: body, fontSize: 14 });
  store.transact(() => {
    labels.forEach(([id, name, color], order) => store.labels.set(id, { id, name, color, order }));
    objs.forEach((o) => store.create(o));
  });
  return true;
}

async function openKanbanBoard({ page, base }, { fit = true, board = KANBAN_ID } = {}) {
  await page.goto(`${base}/?debug#/b/${board}`);
  await page.waitForFunction(() => window.__board && window.__kanban, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const provider = window.__board.conn.provider;
    return !provider || provider.synced;
  }, null, { timeout: 15_000 });
  // heights are measured with the board's fonts, so they have to be there first
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  const fresh = await page.evaluate(seedKanban, { at: NOW - HOUR });
  if (fresh) {
    await page.evaluate(() => {
      const app = window.__board;
      app.comments.addThread({ id: 'visual-user', name: 'Visual QA', color: '#2F6FED' }, { x: 0, y: 0, obj: 'k-d3', fx: 0.95, fy: 0.1 }, 'Should the guard cover tabs too?');
    });
  }
  await page.evaluate((doFit) => {
    const app = window.__board;
    app.setSelection([]);
    // a phone shows the kanban alone, as the design's 390 shots do; a desktop shows the objects beside it too
    if (doFit) app.r.fit(window.innerWidth < 600 ? app.r.contentBounds(['k-box']) : app.r.contentBounds(), window.innerWidth < 600 ? 8 : 40, 1);
  }, fit);
  await settle(page);
}

/**
 * On a phone (under 600 px) fits the view to one lane (or the lanes named), at about 100% zoom, so the chips, dimming, Full outline and name
 * field of a state can be judged there; the whole-board fit leaves a kanban at 16 to 23%. On wider screens it does nothing.
 */
async function zoomOnLane(page, laneIds) {
  const did = await page.evaluate((ids) => {
    const app = window.__board;
    const os = [ids].flat().map((id) => app.store.getPlaced(id)).filter(Boolean);
    if (window.innerWidth >= 600 || !os.length) return false;
    const x = Math.min(...os.map((o) => o.x)), y = Math.min(...os.map((o) => o.y));
    app.r.fit({ x, y, w: Math.max(...os.map((o) => o.x + o.w)) - x, h: Math.max(...os.map((o) => o.y + o.h)) - y }, 8, 1);
    return true;
  }, laneIds);
  if (did) await settle(page);
}

/** Fills Review (a block lane with a limit of 2) to its limit, once. */
const fillReview = (page) =>
  page.evaluate(() => {
    const app = window.__board;
    for (const [id, text, rank] of [['k-r1', 'Ranks carry their parent', 'a0'], ['k-r2', 'Store.geometry call sites', 'a1']]) {
      if (app.store.get(id)) continue;
      const card = { id, type: 'card', parent: 'k-review', rank: `${rank}@k-review`, text, x: 0, y: 0, w: 264, h: 0, rotation: 0, z: 'a0', createdBy: 'visual-seed', updatedAt: Date.now(), font: app.store.getMeta().bodyFont };
      card.h = window.__kanban.cardContentHeight(card, 264);
      app.store.transact(() => app.store.create(card));
    }
    app.setSelection([]);
  });

/** Opens the kanban as a list (slice 5) on a lane. */
async function openSheet(page, lane) {
  await page.evaluate((l) => window.__board.openKanbanList('k-box', l), lane);
  await page.locator('.ks-sheet').waitFor();
  await settle(page);
}

/** Opens Move to… for a card of the list sheet. */
async function openMoveTo(page, title) {
  await page.getByRole('button', { name: `Actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await page.getByRole('dialog', { name: 'Move to…' }).waitFor();
  await settle(page);
}

/** The screen point of a world point on the kanban board. */
const screenOf = (page, id, fx, fy) =>
  page.evaluate(({ id, fx, fy }) => {
    const app = window.__board;
    const o = app.store.getPlaced(id);
    const s = app.r.toScreen({ x: o.x + o.w * fx, y: o.y + o.h * fy });
    const box = app.r.svg.getBoundingClientRect();
    return { x: box.left + s.x, y: box.top + s.y };
  }, { id, fx, fy });


// ---------------------------------------------------------------- AI surfaces (QA sweep)

/** An AI proposal of someone else, handed to the board the way the relay does (6 is MSG_AI_RUNS). */
async function sendAiRun(page) {
    await page.evaluate(() => {
      const app = window.__board;
      const run = {
        id: 'visual-run', feature: 'generate', status: 'ready', private: false, startedAt: 1, readyAt: 2, cut: false,
        by: { id: 'visual-ana', name: 'Ana', color: '#7A5AF8' }, target: { ids: [] },
        proposal: { kind: 'create', objects: [{ text: 'Pilot the new onboarding with five teams' }, { text: 'Write the migration guide' }, { text: 'Decide on the pricing page copy' }, { text: 'A deliberately long sticky text that has to wrap onto several lines inside the review panel row' }] },
      };
      const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'snapshot', runs: [run] }));
      const arr = new Uint8Array(bytes.length + 5);
      let n = bytes.length, i = 0;
      while (n > 127) { arr[i++] = (n & 127) | 128; n >>>= 7; }
      arr[i++] = n;
      arr.set(bytes, i);
      app.conn.provider.messageHandlers[6](null, { arr, pos: 0, len: i + bytes.length });
    });
}

/** The account menu's "Your AI key" dialog with a stored key and Test key answered by a fixed reply (accounts mode). */
async function openAiKeyDialogWith({ page, base }, testReply) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/me', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const me = await res.json();
    return json(route, { ...me, ai: { personalKeys: true } });
  });
  await page.route('**/api/ai/config', (route) => json(route, {
    enabled: true, features: ['generate'], keySource: 'user', model: 'claude-sonnet-5-5', personalKeys: true, hasSecret: true,
    myKey: { provider: 'anthropic', hint: '4f2a', createdAt: NOW - 9 * 24 * HOUR, lastUsedAt: NOW - 2 * HOUR },
  }));
  await page.route('**/api/ai/keys/me/test', (route) => (testReply.ok ? json(route, { ok: true, provider: 'anthropic', checkedAt: NOW }) : json(route, testReply.body, testReply.status)));
  await page.goto(`${base}/#/b/${BOARD_ID}`);
  await page.getByRole('button', { name: 'Menu' }).click();
  // the menu rows are plain buttons, not menu items: a role lookup that never matches would wait out Playwright's 30 s
  await page.getByText('Your AI key', { exact: true }).click();
  await page.getByRole('button', { name: 'Test key' }).click();
}


const NVIDIA = { baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'moonshotai/kimi-k3' };

/**
 * The AI key screens with fixed answers (accounts mode): `mine` is the person's saved key and `workspace` the workspace's, each
 * null or `{ provider, hint, baseUrl?, model? }`. The reply of a save or a test is not mocked: these states only look.
 */
async function mockAiKeyScreens({ page }, { mine = null, workspace = null } = {}) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const view = (k) => (k ? { provider: k.provider, baseUrl: k.baseUrl ?? null, model: k.model ?? null, hint: k.hint, createdAt: NOW - 9 * 24 * HOUR, lastUsedAt: NOW - 2 * HOUR } : null);
  await page.route('**/api/me', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const me = await (await route.fetch()).json();
    return json(route, { ...me, ai: { personalKeys: true } });
  });
  await page.route('**/api/ai/config', (route) => json(route, {
    enabled: true, features: ['generate', 'summarise', 'cluster'], keySource: mine ? 'user' : workspace ? 'workspace' : null,
    provider: (mine ?? workspace)?.provider ?? null, model: (mine ?? workspace)?.model ?? 'claude-opus-5-5', personalKeys: true, hasSecret: true, myKey: view(mine),
  }));
  await page.route('**/api/admin/ai', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return json(route, {
      enabled: true, features: ['generate', 'summarise', 'cluster'], model: 'claude-opus-5-5', personalKeys: true, membersOnly: false,
      limits: { perPersonHour: 20, perWorkspaceHour: 200 }, hasSecret: true, key: workspace ? { ...view(workspace), readable: true } : null,
    });
  });
}

/** "Your AI key" of the account menu, opened on a board. */
async function openMyAiKey(env, keys) {
  await mockAiKeyScreens(env, keys);
  await env.page.goto(`${env.base}/#/b/${BOARD_ID}`);
  await env.page.getByRole('button', { name: 'Menu' }).click();
  await env.page.getByText('Your AI key', { exact: true }).click();
  await env.page.getByRole('combobox', { name: 'Provider' }).waitFor();
}

/** The AI tab of the admin dashboard. */
async function openAdminAi(env, keys) {
  await mockAiKeyScreens(env, keys);
  await env.page.goto(`${env.base}/#/admin/ai`);
  await env.page.getByRole('combobox', { name: 'Provider' }).waitFor();
}

/** Picks OpenAI-compatible and fills the three fields (the key is a made-up value). */
async function fillOpenAiKey({ page }, { baseUrl = NVIDIA.baseUrl, model = NVIDIA.model } = {}) {
  await page.getByRole('combobox', { name: 'Provider' }).selectOption('openai-compatible');
  await page.getByPlaceholder('https://integrate.api.nvidia.com/v1').fill(baseUrl);
  await page.getByPlaceholder('moonshotai/kimi-k3').fill(model);
  await page.getByPlaceholder(/^(Paste the key|Paste the API key)/).first().fill('sk-test-not-a-real-key-1234');
  // the sentence under the fields (and the button) is what the shot is about
  await page.getByRole('button', { name: /^(Save key|Replace key)$/ }).scrollIntoViewIfNeeded();
}

/** What has the keyboard focus, in words a test can compare: the label, the placeholder or the text of the control. */
const focusedName = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el ? el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.textContent || '').trim().slice(0, 40) || el.tagName : null;
});

/** Presses Tab until `name` has the focus (at most `max` times), and throws when it never does. */
async function tabTo(page, name, max = 60) {
  for (let i = 0; i < max; i++) {
    if ((await focusedName(page)) === name) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached "${name}" (the focus is on "${await focusedName(page)}")`);
}

/**
 * The key form without a pointer (TAB-222): Tab to the Provider select, choose OpenAI-compatible by typing its first letter, and Tab through
 * the new fields in reading order to the Save button, typing into each. Throws when the order or a field is wrong.
 */
async function walkKeyFormByKeyboard({ page }, { saveName }) {
  await tabTo(page, 'Provider');
  // typing the first letter chooses the option on a closed select (the arrow keys open its list on macOS) and fires change: the two
  // fields appear without a click
  await page.keyboard.type('O');
  if ((await page.getByRole('combobox', { name: 'Provider' }).inputValue()) !== 'openai-compatible') throw new Error('typing O did not choose OpenAI-compatible');
  const order = [];
  for (const [text, field] of [['https://integrate.api.nvidia.com/v1', 'Base URL'], ['moonshotai/kimi-k3', 'Model'], ['sk-test-not-a-real-key-1234', 'API key']]) {
    await page.keyboard.press('Tab');
    order.push(field);
    await page.keyboard.type(text);
  }
  await page.keyboard.press('Tab');
  const reached = await focusedName(page);
  if (reached !== saveName) throw new Error(`Tab after the key field reached "${reached}", not "${saveName}" (order: ${order.join(', ')})`);
  if (await page.getByRole('button', { name: saveName }).isDisabled()) throw new Error(`"${saveName}" is still disabled after a valid form was typed`);
  // and back the other way: Shift+Tab from Save returns to the key field, then the Model field
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  const back = await focusedName(page);
  if (back !== 'moonshotai/kimi-k3' && back !== 'Model') throw new Error(`Shift+Tab twice from Save reached "${back}", not the Model field`);
  // a keyboard user must see where they are: the focused field shows an outline, a shadow, or a border its unfocused neighbour lacks
  const look = await page.evaluate(() => {
    const el = document.activeElement;
    const other = [...document.querySelectorAll('input.input')].find((i) => i !== el && i.getAttribute('placeholder') !== null);
    const c = getComputedStyle(el);
    const o = other ? getComputedStyle(other) : null;
    return { visible: el.matches(':focus-visible'), outline: `${c.outlineStyle} ${c.outlineWidth}`, shadow: c.boxShadow, border: c.borderColor, otherBorder: o?.borderColor ?? null };
  });
  const ringed = look.visible && ((look.outline !== 'none 0px' && !look.outline.startsWith('none')) || look.shadow !== 'none' || look.border !== look.otherBorder);
  if (!ringed) throw new Error(`the focused field shows no focus indicator: ${JSON.stringify(look)}`);
}

/** Stable nested groups for the group overlay shots; reuses them when visual states share a relay. */
async function ensureVisualGroups(page) {
  return page.evaluate(() => {
    const app = window.__board;
    const parentGroupOf = (ids) => [...app.store.cache.values()].find((o) =>
      o.type === 'group' && ids.every((id) => app.store.get(id)?.parent === o.id));

    let inner = parentGroupOf(['seed-note-1', 'seed-note-2']);
    if (!inner) {
      app.setSelection(['seed-note-1', 'seed-note-2']);
      if (!app.groupSelection()) throw new Error('could not create the visual inner group');
      inner = app.store.get(app.selection[0]);
    }

    let outer = parentGroupOf([inner.id, 'seed-note-3']);
    if (!outer) {
      app.setSelection([inner.id, 'seed-note-3']);
      if (!app.groupSelection()) throw new Error('could not create the visual outer group');
      outer = app.store.get(app.selection[0]);
    }

    app.store.transact(() => {
      app.store.update(inner.id, { name: 'Notes', locked: undefined });
      app.store.update(outer.id, { name: 'Header', locked: undefined });
    });
    return { innerId: inner.id, outerId: outer.id };
  });
}

/**
 * A real touch long press (CDP touch events, so pointerType is touch) on the screen point `x` px from the left where `memberId` is
 * moved to; waits for the menu and lifts the finger. `select` re-selects that object first (a group). The menu stays open for the shot.
 */
async function longPressMember(page, memberId, select, x = 70) {
  const at = await page.evaluate(({ memberId, select, x }) => {
    const app = window.__board;
    if (select) app.setSelection([select]);
    const b = app.r.bounds(app.store.get(memberId));
    const s = app.r.toScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const z = app.r.cam.zoom;
    app.r.setCamera({ x: app.r.cam.x + (s.x - x) / z, y: app.r.cam.y + (s.y - 360) / z });
    return { x, y: 360 };
  }, { memberId, select, x });
  await page.waitForTimeout(200);
  const cdp = await page.context().newCDPSession(page);
  const pt = [{ x: at.x, y: at.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await page.locator('.ctx-menu').waitFor({ timeout: 3000 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
}

async function waitForGroupStyles(page) {
  await page.waitForFunction(() => Boolean(getComputedStyle(document.documentElement).getPropertyValue('--group-line').trim()));
}

const TOUCH_TARGET_EXCEPTIONS = [
  'native checkbox/radio: measure the associated label as the 44px hit area',
  'canvas text editor (.text-editor): it follows board zoom; its focused font size is checked separately',
  'board canvas: continuous pan/draw surface, not a discrete control',
];

async function assertTouchTargets(page, stage) {
  const report = await page.evaluate(() => {
    const textSelector = "input:not([type='checkbox']):not([type='radio']):not([type='range']):not([type='button']):not([type='submit']):not([type='reset']):not([type='image']):not([type='color']):not([type='hidden']), textarea, select, [contenteditable]:not([contenteditable='false'])";
    const targetSelector = "button, a[href], input:not([type='hidden']), textarea, select, [contenteditable]:not([contenteditable='false']), [role='button'], [role='menuitem'], [role='menuitemradio'], [role='option'], [role='radio'], [role='checkbox'], [role='tab'], [role='switch'], [role='combobox'], [role='spinbutton'], [role='link'], [tabindex]:not([tabindex='-1']), summary";
    const visible = (el) => {
      if (!(el instanceof HTMLElement) || el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const label = (el) => el.getAttribute('aria-label') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 36) || el.className?.toString() || el.tagName.toLowerCase();
    const smallFonts = [...document.querySelectorAll(textSelector)]
      .filter((el) => visible(el))
      .map((el) => ({ name: label(el), size: Number.parseFloat(getComputedStyle(el).fontSize) }))
      .filter((el) => !Number.isFinite(el.size) || el.size < 16);
    const misses = [];
    let measured = 0;
    for (const el of document.querySelectorAll(targetSelector)) {
      if (!visible(el) || el.matches(':disabled, [aria-disabled="true"]')) continue;
      if (el.matches('.text-editor')) continue;
      let target = el;
      if (el.matches("input[type='checkbox'], input[type='radio']")) target = el.closest('label');
      if (!target) {
        misses.push(`${label(el)} has no associated label hit area`);
        continue;
      }
      const rect = target.getBoundingClientRect();
      measured++;
      if (rect.width < 43.5 || rect.height < 43.5) misses.push(`${label(el)} ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}px`);
    }
    return { coarse: matchMedia('(pointer: coarse)').matches, measured, misses, smallFonts };
  });
  if (!report.coarse) throw new Error(`touch-target check at ${stage} did not get a coarse pointer`);
  if (report.smallFonts.length) throw new Error(`touch font-size below 16px at ${stage}: ${JSON.stringify(report.smallFonts)}`);
  if (report.misses.length) throw new Error(`touch targets below 44px at ${stage}: ${report.misses.join('; ')}`);
  console.log(`touch-targets ${stage}: ${report.measured} targets at least 44×44px; text fields at least 16px`);
}

/** The compact phone vote bar is ONE row, nothing sticks out of it, and the instructions stay folded away. */
async function voteBarOneRow(env, label) {
  await env.page.locator('.flowbar.vote-compact').waitFor();
  await env.page.getByRole('button', { name: 'Remove dots' }).click();
  await env.page.waitForFunction(() => document.querySelector('.remove-dots-toggle')?.getAttribute('aria-pressed') === 'true');
  await env.page.locator('.toast.show').waitFor({ state: 'hidden' }).catch(() => {});
  const rows = await env.page.evaluate(() => {
    const bar = document.querySelector('.flowbar.vote-compact');
    const b = bar.getBoundingClientRect();
    const boxes = [...bar.children].filter((el) => getComputedStyle(el).display !== 'none' && !el.hidden).map((el) => ({ name: el.className, ...el.getBoundingClientRect().toJSON() }));
    return { n: boxes.length, tops: new Set(boxes.map((x) => Math.round(x.top / 4))).size, out: boxes.filter((x) => x.right > b.right + 0.5 || x.left < b.left - 0.5).map((x) => x.name), boxes: boxes.map((x) => `${x.name}:${Math.round(x.left)}-${Math.round(x.right)}`), barW: b.width };
  });
  console.log(label, JSON.stringify(rows));
  if (rows.tops !== 1) throw new Error(`${label}: the compact vote bar wraps to ${rows.tops} rows (${rows.boxes.join(' ')})`);
  if (rows.out.length) throw new Error(`${label}: controls stick out of the vote bar: ${rows.out.join(', ')}`);
}

async function checkStepsOverlap(env, name) {
    const result = await env.page.evaluate(() => {
      const bar = document.querySelector('.flowbar.show');
      const pop = document.querySelector('.popover.wide');
      const next = [...(bar?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim().startsWith('Next step'));
      if (!bar || !pop || !next) return { failures: ['session bar, Steps popover or Next step button is missing'] };
      const box = (el) => el.getBoundingClientRect();
      const b = box(bar), p = box(pop), n = box(next);
      const intersects = p.left < b.right && p.right > b.left && p.top < b.bottom && p.bottom > b.top;
      const hit = document.elementFromPoint((n.left + n.right) / 2, (n.top + n.bottom) / 2);
      const failures = [];
      if (intersects) failures.push(`Steps popover intersects the session bar (${Math.round(p.top)}-${Math.round(p.bottom)} vs ${Math.round(b.top)}-${Math.round(b.bottom)})`);
      if (hit !== next && !next.contains(hit)) failures.push(`Next step centre hits ${hit?.getAttribute('aria-label') ?? hit?.textContent?.trim() ?? hit?.tagName ?? 'nothing'}`);
      return { failures, viewport: `${innerWidth}x${innerHeight}`, popover: { top: p.top, bottom: p.bottom }, bar: { top: b.top, bottom: b.bottom }, hit: hit?.textContent?.trim() };
    });
    console.log(`${name} ${JSON.stringify(result)}`);
    if (result.failures.length) throw new Error(`${name}: ${JSON.stringify(result.failures)}`);
}

// Press-kit shots: the seeded boards with the QA names swapped for roles, so nothing reads as a person or a localhost (business/press/press-kit.md)
async function pressRoles(page) {
  await page.evaluate(() => {
    const swaps = [[/Visual QA/g, 'Facilitator'], [/VISUAL QA/g, 'FACILITATOR'], [/http:\/\/127\.0\.0\.1:\d+/g, 'https://sample.gettabula.app'], [/^\s*VQ\s*$/i, 'FA'], [/^\s*V\s*$/i, 'F']];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let t = n.nodeValue;
      for (const [re, to] of swaps) t = t.replace(re, to);
      if (t !== n.nodeValue) n.nodeValue = t;
    }
    // a start message is not a feature of the product
    document.querySelector('.toast')?.classList.remove('show');
  });
}
async function pressZoom(page, factor) {
  // a phone shows the retro frames at about 3x the fitted size, or the notes are unreadable
  await page.evaluate(([f, phone]) => window.__board.zoomBy(phone && innerWidth < 500 ? f * 2 : f), [factor, true]);
}

async function openTrackerMockShell(page, base) {
  await page.goto(`${base}/?debug&trackerMock=1#/t/all`);
  await page.locator('.trk-route-root .trk-shell').waitFor();
  await page.locator('.trk-list-row').first().waitFor();
}

async function openTrackerMockFrame(env) {
  await openSeedBoard(env, '?debug&trackerMock=board');
  const { page } = env;
  await page.waitForFunction(() => window.__trackerStore && [...window.__board.store.cache.values()].some((obj) => obj.type === 'tracker'));
  const frame = await page.evaluate(() => [...window.__board.store.cache.values()].find((obj) => obj.type === 'tracker'));
  if (!frame) throw new Error('tracker-frame: visual mock frame was not created');
  return frame;
}

async function assertTrackerLayout(page) {
  const result = await page.evaluate(() => {
    const failures = [];
    const overflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth;
    if (overflow > 0) failures.push(`horizontal overflow ${overflow}px`);
    const shell = document.querySelector('.trk-shell');
    if (!shell) failures.push('tracker shell is missing');
    if (innerWidth <= 500) {
      const small = [...document.querySelectorAll('.trk button')].filter((button) => button.getClientRects().length).find((button) => {
        const box = button.getBoundingClientRect();
        return box.width < 44 || box.height < 44;
      });
      if (small) {
        const box = small.getBoundingClientRect();
        failures.push(`phone target ${Math.round(box.width)}×${Math.round(box.height)}px: ${small.getAttribute('aria-label') || small.textContent.trim()}`);
      }
    }
    const color = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const values = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
      if (values.length < 3 || values.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
      return [values[0], values[1], values[2], values.length > 3 && Number.isFinite(values[3]) ? values[3] : 1];
    };
    const luminance = ([r, g, b]) => {
      const linear = (n) => { const x = n / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    const background = (element) => {
      for (let at = element; at; at = at.parentElement) {
        const parsed = color(getComputedStyle(at).backgroundColor);
        if (parsed && parsed[3] >= 0.99) return parsed;
      }
      return color(getComputedStyle(document.documentElement).backgroundColor) ?? [255, 255, 255, 1];
    };
    const textElements = [...document.querySelectorAll('.trk .trk-tabs [role="tab"], .trk .trk-header-actions button, .trk .trk-view-bar button, .trk .trk-list-header, .trk .trk-list-row, .trk .trk-group-heading, .trk .trk-filter-chip, .trk .trk-label-chip, .trk .trk-key-chip, .trk .trk-selection-bar, .trk .trk-new-issue-back .modal button')];
    for (const element of textElements) {
      if (!element.getClientRects().length || !element.textContent.trim()) continue;
      const foreground = color(getComputedStyle(element).color);
      if (!foreground) continue;
      const bg = background(element);
      const ratio = (Math.max(luminance(foreground), luminance(bg)) + 0.05) / (Math.min(luminance(foreground), luminance(bg)) + 0.05);
      if (ratio < 4.5) failures.push(`text contrast ${ratio.toFixed(2)}:1 for ${element.className || element.tagName}`);
    }
    return { failures, overflow };
  });
  if (result.failures.length) throw new Error(`tracker layout: ${result.failures.join('; ')}`);
}

const STATES = {
  async 'tracker-fullscreen'({ page, base }) {
    await page.goto(`${base}/?debug&trackerMock=1#/t/all`);
    await page.locator('.trk-route-root .trk-shell').waitFor();
    await page.locator('.trk-list-row').first().waitFor();
    if (!(await page.locator('.trk-fullscreen-strip').isVisible())) throw new Error('tracker-fullscreen: full-screen board strip is missing');
    await assertTrackerLayout(page);
  },
  async 'tracker-all-issues'({ page, base }) {
    await openTrackerMockShell(page, base);
    await page.locator('.trk-group-heading').first().waitFor();
    await page.locator('.trk-row-select').first().click();
    await page.locator('.trk-selection-bar:not([hidden])').waitFor();
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.locator('.trk-filter-editor:not([hidden])').waitFor();
    await assertTrackerLayout(page);
  },
  async 'tracker-filter-open'({ page, base }) {
    await openTrackerMockShell(page, base);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.locator('.trk-filter-editor:not([hidden])').waitFor();
    await assertTrackerLayout(page);
    return { noPark: true };
  },
  async 'tracker-picker-open'({ page, base }) {
    await openTrackerMockShell(page, base);
    await page.locator('.trk-state-value').first().click();
    await page.locator('.trk-pop').waitFor();
    await assertTrackerLayout(page);
    return { noPark: true };
  },
  async 'tracker-new-issue'({ page, base }) {
    await openTrackerMockShell(page, base);
    await page.getByRole('button', { name: /New issue/ }).click();
    await page.locator('.trk-new-issue-back[role="dialog"], .trk-new-issue-back .modal[role="dialog"]').first().waitFor();
    await page.getByLabel('Issue title').fill('Keep the current camera after expanding');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.locator('.trk-new-preview:not([hidden])').waitFor();
    if (await page.locator('.trk-new-preview script').count()) throw new Error('tracker-new-issue: preview inserted an executable script node');
    return { noPark: true };
  },
  async 'tracker-phone'({ page, base, width }) {
    if (width > 500) throw new Error('tracker-phone is only valid at phone widths');
    await openTrackerMockShell(page, base);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.locator('.trk-filter-editor:not([hidden])').waitFor();
    const sheet = await page.locator('.trk-filter-editor').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, bottom: box.bottom, width: box.width };
    });
    if (sheet.left !== 0 || sheet.width < width - 1 || sheet.bottom < page.viewportSize().height - 90) throw new Error(`tracker-phone: filter is not a bottom sheet ${JSON.stringify(sheet)}`);
    await assertTrackerLayout(page);
    return { noPark: true };
  },
  async 'tracker-phone-new-issue'({ page, base, width }) {
    if (width > 500) throw new Error('tracker-phone-new-issue is only valid at phone widths');
    await openTrackerMockShell(page, base);
    await page.getByRole('button', { name: /New issue/ }).click();
    await page.locator('.trk-new-issue-back .modal[role="dialog"]').waitFor();
    const sheet = await page.locator('.trk-new-issue-back .modal').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, bottom: box.bottom, width: box.width };
    });
    if (sheet.left !== 0 || sheet.width < width - 1 || sheet.bottom < page.viewportSize().height - 90) throw new Error(`tracker-phone-new-issue: create form is not a full sheet ${JSON.stringify(sheet)}`);
    await assertTrackerLayout(page);
    return { noPark: true };
  },
  async 'tracker-keyboard'({ page, base }) {
    await openTrackerMockShell(page, base);
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.activeElement?.closest('.trk-shell'));
    const focusRingVisible = await page.evaluate(() => {
      const outline = getComputedStyle(document.activeElement).outline;
      return outline !== 'none' && outline.includes('solid') && !outline.includes('transparent');
    });
    if (!focusRingVisible) throw new Error('tracker-keyboard: focus ring is not visible on the shell control');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('s');
    await page.locator('.trk-pop').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.trk-pop').waitFor({ state: 'detached' });
    await page.keyboard.press('Enter');
    await page.locator('.trk-ticket-stub h1').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.trk-list-row').first().waitFor();
    return { noPark: true };
  },
  async 'tracker-frame-overview'(env) {
    const frame = await openTrackerMockFrame(env);
    if (env.width > 600) {
      await env.page.evaluate((id) => { window.__board.zoomTo(0.5); window.__board.setSelection([id]); }, frame.id);
      await env.page.keyboard.press('Enter');
      await env.page.locator('.trk-frame-wrap.is-work .trk-shell').waitFor();
      await env.page.getByRole('tab', { name: 'All issues' }).click();
      await env.page.locator('.trk-frame-wrap .trk-list-row').first().waitFor();
      await env.page.keyboard.press('Escape');
      await env.page.waitForFunction(() => !document.querySelector('.trk-frame-wrap')?.classList.contains('is-work'));
    } else {
      await env.page.evaluate((id) => window.__board.setSelection([id]), frame.id);
    }
    return { noPark: true };
  },
  async 'tracker-frame-work'(env) {
    const frame = await openTrackerMockFrame(env);
    await env.page.evaluate((id) => { if (innerWidth > 600) window.__board.zoomTo(0.5); window.__board.setSelection([id]); }, frame.id);
    await env.page.keyboard.press('Enter');
    await env.page.locator('.trk-route-root .trk-shell, .trk-frame-wrap.is-work .trk-shell').waitFor();
    const allIssuesTab = env.width <= 600
      ? env.page.locator('.trk-route-root [role="tab"][aria-label="All issues"]')
      : env.page.locator('.trk-frame-wrap.is-work [role="tab"][aria-label="All issues"]');
    await allIssuesTab.click();
    await env.page.locator('.trk-list-row').first().waitFor();
    if (env.width > 600 && !(await env.page.locator('.trk-frame-wrap.is-work').count())) throw new Error('tracker-frame-work: work surface is not mounted over the frame');
    await assertTrackerLayout(env.page);
    return { noPark: true };
  },
  async 'tracker-frame-fullscreen'(env) {
    const frame = await openTrackerMockFrame(env);
    await env.page.evaluate((id) => { if (innerWidth > 600) window.__board.zoomTo(0.5); window.__board.setSelection([id]); }, frame.id);
    await env.page.keyboard.press('Enter');
    await env.page.getByRole('tab', { name: 'All issues' }).click();
    await env.page.locator('.trk-list-row').first().waitFor();
    const before = await env.page.evaluate(() => ({ ...window.__board.r.cam }));
    if (env.width > 600) {
      await env.page.locator('.trk-frame-wrap.is-selected .trk-frame-open').click().catch((error) => { throw new Error(`tracker-frame-fullscreen: open chip: ${error.message}`); });
      await env.page.locator('.trk-frame-wrap.is-work').waitFor();
      await env.page.locator('.trk-frame-wrap.is-work .trk-frame-expand').click().catch((error) => { throw new Error(`tracker-frame-fullscreen: frame expand: ${error.message}`); });
      await env.page.locator('.trk-route-root').waitFor();
    } else {
      await env.page.locator('.trk-route-root').waitFor();
    }
    const afterOpen = await env.page.evaluate(() => ({ ...window.__board.r.cam }));
    if (before.x !== afterOpen.x || before.y !== afterOpen.y || before.zoom !== afterOpen.zoom) throw new Error('tracker-frame-fullscreen: opening full screen moved the board camera');
    await env.page.locator('.trk-route-root .trk-fullscreen-strip button').click().catch((error) => { throw new Error(`tracker-frame-fullscreen: back to board: ${error.message}`); });
    await env.page.locator('.trk-route-root').waitFor({ state: 'detached' });
    const afterClose = await env.page.evaluate(() => ({ ...window.__board.r.cam }));
    if (before.x !== afterClose.x || before.y !== afterClose.y || before.zoom !== afterClose.zoom) throw new Error('tracker-frame-fullscreen: closing full screen changed the board camera');
    if (env.width > 600) {
      await env.page.locator('.trk-frame-wrap.is-selected .trk-frame-expand').click().catch((error) => { throw new Error(`tracker-frame-fullscreen: reopen expand: ${error.message}`); });
    } else {
      await env.page.evaluate((id) => window.__board.setSelection([id]), frame.id);
      await env.page.keyboard.press('Enter');
    }
    await env.page.locator('.trk-route-root').waitFor();
    return { noPark: true };
  },
  async 'tracker-foundation'({ page, base, width }) {
    await page.goto(`${base}/?debug=tracker-foundation`);
    await page.getByRole('main', { name: 'Tracker UI foundation gallery' }).waitFor();
    await page.getByRole('listbox', { name: 'State' }).waitFor();
    await page.locator('.trk-pop .trk-picker-option').first().waitFor();
    const audit = await page.evaluate((viewportWidth) => {
      const failures = [];
      const contrast = (foreground, background) => {
        const rgb = (value) => {
          const match = value.match(/rgba?\(([^)]+)\)/i);
          if (!match) return null;
          const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
          return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? parts.slice(0, 3) : null;
        };
        const fg = rgb(foreground), bg = rgb(background);
        if (!fg || !bg) return 0;
        const luminance = ([r, g, b]) => {
          const linear = (n) => { const x = n / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
        };
        const a = luminance(fg), b = luminance(bg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const background = (element) => {
        for (let at = element; at; at = at.parentElement) {
          const color = getComputedStyle(at).backgroundColor;
          if (!color.includes('rgba(0, 0, 0, 0)') && color !== 'transparent') return color;
        }
        return getComputedStyle(document.documentElement).backgroundColor;
      };
      const textNodes = [...document.querySelectorAll('.trk .trk-key-chip, .trk .trk-label-chip, .trk .trk-count-badge, .trk .trk-actor-badge, .trk .trk-due-chip, .trk .trk-filter-chip, .trk .trk-list-title, .trk .trk-list-group-head')];
      for (const element of textNodes) {
        const ratio = contrast(getComputedStyle(element).color, background(element));
        if (ratio < 4.5) failures.push(`text contrast ${ratio.toFixed(2)}:1 on .${element.className}`);
      }
      const nonText = [...document.querySelectorAll('.trk .trk-glyph, .trk .trk-label-chip, .trk .trk-count-badge, .trk .trk-actor-badge, .trk .trk-due-chip, .trk .trk-filter-chip')];
      for (const element of nonText) {
        const style = getComputedStyle(element);
        const foreground = element.matches('svg') ? style.color : style.borderTopColor;
        const ratio = contrast(foreground, background(element));
        if (ratio < 3) failures.push(`non-text contrast ${ratio.toFixed(2)}:1 on .${element.className}`);
      }
      const listbox = document.querySelector('[role="listbox"]');
      const options = [...document.querySelectorAll('[role="option"]')];
      if (!listbox?.getAttribute('aria-label')) failures.push('picker listbox has no accessible name');
      if (!options.length || options.some((option) => !option.textContent.trim())) failures.push('picker options have no accessible names');
      const activeId = listbox?.getAttribute('aria-activedescendant');
      if (!activeId || !document.getElementById(activeId)) failures.push('picker has no live active descendant');
      if (!document.querySelector('[aria-pressed="true"]')) failures.push('pressed state is missing');
      if (!document.querySelector('[role="checkbox"][aria-checked="mixed"]')) failures.push('mixed checkbox state is missing');
      if ([...document.querySelectorAll('.trk svg')].some((icon) => icon.getAttribute('aria-hidden') !== 'true')) failures.push('decorative glyph is exposed to assistive technology');
      if (viewportWidth <= 390) {
        const targets = [...document.querySelectorAll('.trk button, .trk [role="option"], .trk [role="row"]')].filter((element) => element.getClientRects().length);
        const tooSmall = targets.find((element) => element.getBoundingClientRect().height < 44);
        if (tooSmall) failures.push(`touch target is ${Math.round(tooSmall.getBoundingClientRect().height)}px: ${tooSmall.textContent.trim()}`);
      }
      const overflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth;
      if (overflow > 0) failures.push(`horizontal overflow ${overflow}px`);
      return { failures, overflow };
    }, width);
    if (audit.failures.length) throw new Error(`tracker-foundation accessibility/contrast audit: ${audit.failures.join('; ')}`);
    if (width <= 390) {
      // Check the live phone sheet above, then dismiss it so the full-page shot also shows the filter bar and grouped list.
      await page.keyboard.press('Escape');
      await page.locator('.trk-pop').waitFor({ state: 'detached' });
    }
  },
  async 'tracker-inbox'({ page, base }) {
    await page.goto(`${base}/?debug=tracker-foundation&inbox=populated`);
    await page.getByRole('main', { name: 'Tracker inbox gallery' }).waitFor();
    await page.getByRole('listbox', { name: 'Inbox notices' }).waitFor();
    await page.locator('.trk-inbox-row').nth(6).waitFor();
  },
  async 'tracker-inbox-empty'({ page, base }) {
    await page.goto(`${base}/?debug=tracker-foundation&inbox=empty`);
    await page.getByText('Nothing needs you.', { exact: true }).waitFor();
  },
  async 'tracker-inbox-loading'({ page, base }) {
    await page.goto(`${base}/?debug=tracker-foundation&inbox=loading`);
    await page.locator('.trk-inbox-skeleton-row').nth(2).waitFor();
  },
  async 'tracker-inbox-error'({ page, base }) {
    await page.goto(`${base}/?debug=tracker-foundation&inbox=error`);
    await page.getByText('Could not load your inbox.').waitFor();
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  },
  async 'tracker-inbox-long-list'({ page, base }) {
    await page.goto(`${base}/?debug=tracker-foundation&inbox=long-list`);
    await page.getByRole('button', { name: 'Load more' }).click();
    await page.locator('.trk-inbox-row').nth(47).waitFor();
  },
  async 'tracker-inbox-narrow'({ page, base }) {
    await page.goto(`${base}/?debug=tracker-foundation&inbox=narrow`);
    await page.locator('.trk-inbox-row').nth(6).waitFor();
    const reason = page.locator('.trk-inbox-reason').first();
    if (await reason.isVisible()) throw new Error('tracker inbox reason text should be hidden below 720px');
  },
  async 'tracker-notification-prefs'({ page, base }) {
    await page.goto(`${base}/?debug=tracker-foundation&inbox=prefs`);
    await page.locator('.trk-prefs').waitFor();
    await page.getByRole('radiogroup', { name: 'Assigned to me' }).waitFor();
  },
  async home({ page, base }) {
    await page.goto(`${base}/#/`);
    await page.locator('.home-title').waitFor();
    await page.waitForFunction((n) => document.querySelectorAll('.board-row').length >= n, OTHER_BOARDS.length + 1);
  },
  async board(env) {
    await openSeedBoard(env);
  },
  async 'resize-guides-size'(env) {
    await openSeedBoard(env);
    const { page } = env;
    const drag = await page.evaluate(() => {
      const app = window.__board;
      app.r.setCamera({ zoom: 0.5 });
      const vp = app.r.viewport();
      const size = app.r.size();
      const startPx = Math.max(96, (size.w - 190) / 2);
      const x = vp.x + startPx / app.zoom;
      const y = vp.y + 180 / app.zoom;
      const moving = app.makeObj('sticky', { x, y, w: 100, h: 90 }, { text: 'Resize me', fontSize: 16, fill: '#FFE16B' });
      const reference = app.makeObj('sticky', { x: x + 250, y, w: 130, h: 90 }, { text: 'Match width', fontSize: 16, fill: '#BCE88C' });
      moving.id = 'visual-resize-size-target';
      reference.id = 'visual-resize-size-reference';
      delete moving.parent;
      delete reference.parent;
      [moving.z, reference.z] = app.store.topZs(2);
      app.store.transact(() => {
        app.store.create(moving);
        app.store.create(reference);
      });
      app.setSelection([moving.id]);
      const svg = app.r.svg.getBoundingClientRect();
      const handle = app.r.toScreen({ x: moving.x + moving.w, y: moving.y + moving.h / 2 });
      return {
        start: { x: svg.left + handle.x, y: svg.top + handle.y },
        end: { x: svg.left + handle.x + 14, y: svg.top + handle.y },
      };
    });
    if (process.env.VISUAL_BROWSER === 'firefox' && page.viewportSize().width < 600) {
      // Firefox's touch emulation turns Playwright's mouse into mouse events with no pointer events, so feed the pointer drag directly.
      await page.evaluate(({ start, end }) => {
        const svg = window.__board.r.svg;
        svg.setPointerCapture = () => {};
        const fire = (type, pt) => svg.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: pt.x, clientY: pt.y,
        }));
        fire('pointermove', start);
        fire('pointerdown', start);
        for (let i = 1; i <= 5; i++) fire('pointermove', { x: start.x + (end.x - start.x) * i / 5, y: start.y });
      }, drag);
    } else {
      await page.mouse.move(drag.start.x, drag.start.y);
      await page.mouse.down();
      await page.mouse.move(drag.end.x, drag.end.y, { steps: 5 });
    }
    await page.waitForFunction(() => {
      const width = window.__board.store.getPlaced('visual-resize-size-target')?.w;
      return width !== undefined && width !== 100;
    });
    const result = await page.evaluate(() => {
      const app = window.__board;
      const moving = app.store.getPlaced('visual-resize-size-target');
      const reference = app.store.getPlaced('visual-resize-size-reference');
      return {
        width: moving?.w,
        referenceWidth: reference?.w,
        sizeMark: app.r.overlay.guides.some((guide) => guide.kind === 'size' && guide.axis === 'x'),
      };
    });
    if (result.width === undefined || result.referenceWidth === undefined || Math.abs(result.width - result.referenceWidth) > 1e-9) {
      throw new Error(`resize-guides-size: dragged width ${result.width} did not match reference width ${result.referenceWidth}`);
    }
    if (!result.sizeMark) throw new Error('resize-guides-size: overlay has no width size mark during the drag');
    return { noPark: true };
  },
  async 'uml-arrows-themes'({ page, base }) {
    await openSeedBoard({ page, base });
    await page.getByRole('button', { name: 'UML', exact: true }).click();
    await page.locator('.drawer.show[data-tab="uml"]').waitFor();
    await page.getByRole('button', { name: 'Menu' }).click();
    const themes = readThemes();
    for (const theme of themes) {
      const row = page.getByRole('radio', { name: theme.name, exact: true });
      await row.click();
      await page.waitForFunction((id) => document.documentElement.dataset.theme === id, theme.id);
      const result = await page.evaluate(() => {
        const parse = (value) => {
          const m = /^rgba?\(([^)]+)\)$/.exec(value);
          if (!m) return null;
          const parts = m[1].split(',').map((v) => Number.parseFloat(v.trim()));
          return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
        };
        const blend = (front, back) => {
          const a = front[3] + back[3] * (1 - front[3]);
          if (!a) return [0, 0, 0, 0];
          return [0, 1, 2].map((i) => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / a).concat(a);
        };
        const luminance = (rgba) => {
          const channels = rgba.slice(0, 3).map((v) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        };
        const contrast = (a, b) => {
          const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
          return (light + 0.05) / (dark + 0.05);
        };
        const backgroundFor = (el) => {
          const chain = [];
          for (let node = el.parentElement; node; node = node.parentElement) chain.push(node);
          let bg = [255, 255, 255, 1];
          for (const node of chain.reverse()) {
            const style = getComputedStyle(node);
            const color = parse(style.backgroundColor);
            if (color) {
              color[3] *= Number.parseFloat(style.opacity || '1');
              bg = blend(color, bg);
            }
          }
          return bg;
        };
        const failures = [];
        let checked = 0;
        for (const row of document.querySelectorAll('.rel-row')) {
          const label = row.querySelector('span')?.textContent?.trim() || '(unknown relation)';
          const svg = row.querySelector('svg');
          if (!svg) { failures.push(`${label}: missing svg`); continue; }
          for (const shape of svg.querySelectorAll('path, line, polyline, polygon, circle, rect, ellipse')) {
            const style = getComputedStyle(shape);
            const bg = backgroundFor(shape);
            const opacity = Number.parseFloat(style.opacity || '1');
            for (const prop of ['stroke', 'fill']) {
              const value = style[prop];
              if (!value || value === 'none' || value === 'transparent') continue;
              const color = parse(value);
              if (!color) continue;
              color[3] *= opacity;
              const visible = blend(color, bg);
              const ratio = contrast(visible, bg);
              // Hollow arrowheads intentionally paint the tray colour into their interior; that's negative space,
              // not glyph ink. Every visible stroke and every contrasting fill must still meet 3:1.
              if (prop === 'fill' && ratio < 1.01) continue;
              checked++;
              if (ratio < 3) failures.push(`${label} ${prop} ${value} against rgb(${bg.slice(0, 3).map(Math.round).join(', ')}) (${ratio.toFixed(2)}:1)`);
            }
          }
        }
        return { failures, checked, relations: document.querySelectorAll('.rel-row').length };
      });
      console.log(`uml-arrows-themes ${theme.id} ${JSON.stringify(result)}`);
      if (result.relations !== 13) throw new Error(`uml-arrows-themes: expected 13 relation glyphs in ${theme.id}, got ${result.relations}`);
      if (result.failures.length) throw new Error(`uml-arrows-themes ${theme.id}: ${result.failures.slice(0, 6).join('; ')}`);
    }
    await page.keyboard.press('Escape');
  },
  async 'connector-heads'(env) {
    const { page } = env;
    await openSeedBoard(env);
    await page.evaluate(() => window.__board.setSelection(['seed-conn-1']));
    const more = page.getByRole('button', { name: 'More properties' });
    await more.waitFor();
    await more.evaluate((el) => el.click());
    await page.locator('.props.show').waitFor();

    const button = page.locator('.props.show [role="combobox"][aria-label="End arrowhead"]');
    await button.waitFor();
    const closedSvg = button.locator('.combo-option-icon svg');
    await closedSvg.waitFor();
    const closedPreview = await closedSvg.evaluate((svg) => {
      return { width: Number(svg.getAttribute('width')), height: Number(svg.getAttribute('height')), ariaHidden: svg.getAttribute('aria-hidden') };
    });
    if (closedPreview.width <= 0 || closedPreview.height <= 0 || closedPreview.ariaHidden !== 'true') {
      throw new Error(`connector-heads: closed value preview is not visible: ${JSON.stringify(closedPreview)}`);
    }

    await button.click();
    const list = page.locator('.combo-list[aria-label="End arrowhead"]');
    await list.waitFor();
    const rows = await list.locator('.combo-opt').evaluateAll((options) => options.map((option) => {
      const preview = option.querySelector('.combo-option-icon svg');
      const box = preview?.getBoundingClientRect();
      const rowBox = option.getBoundingClientRect();
      const style = preview ? getComputedStyle(preview) : null;
      return {
        label: option.lastElementChild?.textContent?.trim() ?? '',
        visible: !!preview && style?.display !== 'none' && style?.visibility !== 'hidden' && Number.parseFloat(style?.opacity || '1') > 0,
        width: box?.width ?? 0,
        height: box?.height ?? 0,
        ariaHidden: preview?.getAttribute('aria-hidden') ?? null,
        rowHeight: rowBox.height,
      };
    }));
    const expected = readHeads().map(({ label }) => label);
    const failures = [];
    if (rows.map(({ label }) => label).join('\0') !== expected.join('\0')) failures.push(`options ${rows.map(({ label }) => label).join(', ')} do not match HEADS`);
    for (const row of rows) {
      if (!row.visible || row.width <= 0 || row.height <= 0 || row.ariaHidden !== 'true') failures.push(`${row.label}: invalid preview ${JSON.stringify(row)}`);
      if (page.viewportSize().width <= 600 && row.rowHeight < 44) failures.push(`${row.label}: row is ${row.rowHeight}px, below 44px`);
    }
    if (rows.length !== expected.length) failures.push(`expected ${expected.length} options, got ${rows.length}`);
    const result = { viewport: page.viewportSize(), closedPreview, options: rows.length, rows, failures };
    console.log(`connector-heads ${JSON.stringify(result)}`);
    if (failures.length) throw new Error(`connector-heads: ${failures.slice(0, 6).join('; ')}`);
    return { noPark: true };
  },
  async 'esc-trays'(env) {
    await openSeedBoard(env);
    const page = env.page;
    const trays = [
      { name: 'Shapes', open: () => page.getByRole('button', { name: 'Shapes', exact: true }).click(), focus: '.rail [aria-label="Shapes"]' },
      { name: 'UML', open: () => page.getByRole('button', { name: 'UML', exact: true }).click(), focus: '.rail [data-drawer="uml"]' },
      { name: 'Icons', open: () => page.getByRole('button', { name: 'Icons', exact: true }).click(), focus: '.rail [data-drawer="icons"]' },
      { name: 'Stickers', open: () => page.getByRole('button', { name: 'Stickers', exact: true }).click(), focus: '.rail [data-drawer="stickers"]' },
      { name: 'Templates', open: () => page.getByRole('button', { name: 'Templates and team exercises', exact: true }).click(), focus: '.rail [data-drawer="templates"]' },
      { name: 'Layers', open: () => page.getByRole('button', { name: 'Layers', exact: true }).click(), focus: '.rail [data-drawer="layers"]' },
      { name: 'Comments', open: () => page.locator('.comment-toggle').click(), focus: '.comment-toggle' },
    ];
    if (!(await page.locator('.chat-toggle').count())) throw new Error('esc-trays: Chat button is missing in accounts mode');
    trays.push({ name: 'Chat', open: () => page.locator('.chat-toggle').click(), focus: '.chat-toggle' });
    for (const tray of trays) {
      await tray.open();
      await page.locator(tray.name === 'Comments' || tray.name === 'Chat' ? '.side-tray.show' : '.drawer.show').waitFor();
      await page.keyboard.press('Escape');
      const result = await page.evaluate((focusSelector) => {
        const open = document.querySelector('.drawer.show, .side-tray.show');
        const focus = document.querySelector(focusSelector);
        return { open: open?.getAttribute('aria-label') ?? open?.dataset.tab ?? null, focusReturned: document.activeElement === focus };
      }, tray.focus);
      if (result.open) throw new Error(`esc-trays: ${tray.name} tray is still shown (${result.open})`);
      if (!result.focusReturned) throw new Error(`esc-trays: focus did not return to the ${tray.name} button`);
    }
  },
  async 'join-short-code'({ page, base }) {
    // the page is signed in as the owner, which leaves /join for the home page: a guest is signed out; the relay runs with TABULA_JOIN_CODES=on (without it /join goes to sign-in)
    await page.context().clearCookies();
    await page.goto(`${base}/join`);
    const code = page.getByLabel('Join code');
    await code.fill('ABC');
    await page.getByLabel('Display name').fill('Visual guest');
    await page.getByRole('button', { name: 'Join board' }).click();
    await page.getByText('That code looks too short', { exact: true }).waitFor();
  },
  // TAB-239: three stickies selected, so the quick bar is at its longest; at phone widths it scrolls, and `-end` scrolls it to Delete and More properties
  async 'quickbar-multi'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => window.__board.setSelection(['seed-note-1', 'seed-note-2', 'seed-note-3']));
    await env.page.locator('.quickbar.show').waitFor();
    await env.page.waitForTimeout(150);
  },
  async 'quickbar-multi-end'(env) {
    await STATES['quickbar-multi'](env);
    await env.page.locator('.quickbar.show').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await env.page.waitForTimeout(150);
  },
  async 'flip-menu'(env) {
    const { page, outDir, theme, width } = env;
    await openSeedBoard(env);
    await page.evaluate(() => {
      const app = window.__board;
      const store = app.store;
      const at = Date.now();
      const objects = [
        { id: 'flip-menu-arrow', type: 'shape', kind: 'arrow-right', x: 20, y: 20, w: 140, h: 90, rotation: Math.PI / 6, text: 'Arrow', z: 'z1', fill: '#DCEBFF' },
        { id: 'flip-menu-image', type: 'image', x: 190, y: 20, w: 120, h: 90, rotation: 0, asset: '00'.repeat(32), mime: 'image/png', z: 'z2' },
        { id: 'flip-menu-icon', type: 'icon', x: 340, y: 20, w: 90, h: 90, rotation: 0, viewBox: [0, 0, 24, 24], body: '<path d="M3 3h8v8H3zM13 13h8v8h-8zM13 3h8v8h-8zM3 13h8v8H3z"/>', z: 'z3' },
      ];
      store.transact(() => objects.forEach((o) => {
        if (!store.get(o.id)) store.create({ ...o, createdBy: 'visual-seed', updatedAt: at });
      }));
      app.setSelection(objects.map((o) => o.id));
      const bounds = app.r.contentBounds(objects.map((o) => o.id));
      if (bounds) app.r.fit(bounds, 120, 1.15);
    });
    await page.locator('.quickbar.show').waitFor();
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.locator('.qb-action-menu [role="menuitem"]').first().waitFor();
    const quickItems = await page.locator('.qb-action-menu [role="menuitem"]').allTextContents();
    if (!quickItems.some((x) => x.includes('Flip horizontal')) || !quickItems.some((x) => x.includes('Flip vertical'))) {
      throw new Error(`flip-menu: quickbar entries missing: ${JSON.stringify(quickItems)}`);
    }
    if (width <= 500) {
      const heights = await page.locator('.qb-action-menu [role="menuitem"]').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      if (heights.some((height) => height < 44)) throw new Error(`flip-menu: quickbar phone rows are below 44px: ${heights.join(', ')}`);
    }
    const engine = process.env.VISUAL_BROWSER || 'chromium';
    await page.mouse.move(1, 1);
    await page.screenshot({ path: path.join(outDir, `flip-menu-quickbar-${engine}-${theme}-${width}.png`), animations: 'disabled', caret: 'hide' });
    await page.keyboard.press('Escape');
    const at = await page.evaluate(() => {
      const app = window.__board;
      const o = app.store.get('flip-menu-arrow');
      return app.r.toScreen({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
    });
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.locator('.ctx-menu [role="menuitem"]').first().waitFor();
    const contextItems = await page.locator('.ctx-menu [role="menuitem"]').allTextContents();
    if (!contextItems.some((x) => x.includes('Flip horizontal')) || !contextItems.some((x) => x.includes('Flip vertical'))) {
      throw new Error(`flip-menu: context entries missing: ${JSON.stringify(contextItems)}`);
    }
    if (width <= 500) {
      const heights = await page.locator('.ctx-menu [role="menuitem"]').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      if (heights.some((height) => height < 44)) throw new Error(`flip-menu: context phone rows are below 44px: ${heights.join(', ')}`);
    }
    await page.screenshot({ path: path.join(outDir, `flip-menu-context-${engine}-${theme}-${width}.png`), animations: 'disabled', caret: 'hide' });
  },
  async 'flip-visual'(env) {
    const { page, outDir, theme, width } = env;
    await openSeedBoard(env);
    await page.evaluate(() => {
      const app = window.__board;
      const store = app.store;
      const at = Date.now();
      const objects = [
        { id: 'flip-arrow', type: 'shape', kind: 'arrow-right', x: -200, y: 0, w: 150, h: 90, rotation: Math.PI / 10, fill: '#DCEBFF', text: 'Start', z: 'z1' },
        { id: 'flip-callout', type: 'shape', kind: 'callout-round', x: -10, y: -120, w: 170, h: 110, rotation: 0, fill: '#FFF2C2', text: 'Still readable', z: 'z2' },
        { id: 'flip-triangle', type: 'shape', kind: 'triangle', x: 150, y: 0, w: 120, h: 110, rotation: 0, fill: '#DDF5E8', text: 'Turn', z: 'z3' },
        { id: 'flip-path', type: 'path', x: -150, y: 150, w: 130, h: 70, rotation: 0, points: [0, 55, 30, 10, 65, 48, 95, 18, 130, 60], stroke: '#D64545', strokeWidth: 5, z: 'z4' },
        { id: 'flip-icon', type: 'icon', x: 30, y: 155, w: 80, h: 80, rotation: 0, viewBox: [0, 0, 24, 24], body: '<path fill="currentColor" d="M3 3h8v18H3zM13 3h8v8h-8zM13 13h8v8h-8z"/>', z: 'z5' },
        { id: 'flip-connector', type: 'connector', from: { kind: 'bound', id: 'flip-arrow', anchor: 'right' }, to: { kind: 'bound', id: 'flip-triangle', anchor: 'left' }, route: 'elbow', startHead: 'none', endHead: 'arrow', z: 'z6' },
        { id: 'flip-arrow-check', type: 'connector', from: { kind: 'free', x: 0, y: 45 }, to: { kind: 'bound', id: 'flip-arrow', anchor: 'right' }, route: 'straight', startHead: 'none', endHead: 'none', z: 'z7' },
        { id: 'flip-callout-check', type: 'connector', from: { kind: 'bound', id: 'flip-callout', anchor: 'top' }, to: { kind: 'free', x: 180, y: -70 }, route: 'curved', startHead: 'none', endHead: 'none', z: 'z8' },
      ];
      store.transact(() => {
        for (const o of objects) {
          const current = store.get(o.id);
          if (current) store.update(o.id, { ...o, flipX: undefined, flipY: undefined, createdBy: undefined, updatedAt: at });
          else store.create({ ...o, createdBy: 'visual-seed', updatedAt: at });
        }
      });
      app.setSelection(objects.filter((o) => o.type !== 'connector').map((o) => o.id));
      const bounds = app.r.contentBounds(objects.filter((o) => o.type !== 'connector').map((o) => o.id));
      if (bounds) app.r.fit(bounds, 32, 1.15);
    });
    await page.waitForTimeout(200);
    const engine = process.env.VISUAL_BROWSER || 'chromium';
    await page.screenshot({ path: path.join(outDir, `flip-visual-before-${engine}-${theme}-${width}.png`), animations: 'disabled', caret: 'hide' });
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Flip horizontal' }).click();
    await page.waitForFunction(() => window.__board.store.get('flip-arrow')?.flipX === true && window.__board.store.get('flip-icon')?.flipX === true);
    await page.evaluate(() => window.__board.setSelection(['flip-callout']));
    await page.locator('.quickbar.show').waitFor();
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Flip vertical' }).click();
    await page.waitForFunction(() => window.__board.store.get('flip-callout')?.flipY === true);
    await page.waitForTimeout(120);
    const state = await page.evaluate(() => {
      const app = window.__board;
      const elbow = app.store.get('flip-connector');
      const arrow = app.store.get('flip-arrow-check');
      const callout = app.store.get('flip-callout-check');
      const screenPoint = (path, atEnd) => {
        const length = path.getTotalLength();
        const point = path.getPointAtLength(atEnd ? length : 0);
        return new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
      };
      const outlineDistance = (shapeId, point) => {
        const outline = document.querySelector(`.objects [data-id="${shapeId}"] path`);
        const length = outline?.getTotalLength() ?? 0;
        if (!outline || !length) return Infinity;
        const count = Math.max(300, Math.ceil(length * 2));
        let closest = Infinity;
        for (let i = 0; i <= count; i++) {
          const p = outline.getPointAtLength((length * i) / count);
          const screen = new DOMPoint(p.x, p.y).matrixTransform(outline.getScreenCTM());
          closest = Math.min(closest, Math.hypot(screen.x - point.x, screen.y - point.y));
        }
        return closest;
      };
      const routePath = (id) => document.querySelector(`.objects [data-id="${id}"] path`);
      const elbowRoute = routePath('flip-connector');
      const arrowRoute = routePath('flip-arrow-check');
      const calloutRoute = routePath('flip-callout-check');
      const outlineErrors = {
        arrowElbow: outlineDistance('flip-arrow', screenPoint(elbowRoute, false)),
        arrowStraight: outlineDistance('flip-arrow', screenPoint(arrowRoute, true)),
        calloutCurved: outlineDistance('flip-callout', screenPoint(calloutRoute, false)),
      };
      return {
        flags: ['flip-arrow', 'flip-callout', 'flip-triangle', 'flip-path', 'flip-icon'].map((id) => app.store.get(id)?.flipX),
        verticalCallout: app.store.get('flip-callout')?.flipY,
        ends: [elbow.from.anchor, elbow.to.anchor, arrow.to.anchor, callout.from.anchor],
        outlineErrors,
        text: app.store.get('flip-callout')?.text,
      };
    });
    if (state.flags.some((flag) => flag !== true) || state.verticalCallout !== true || state.ends.join(',') !== 'left,right,right,top' ||
        Object.values(state.outlineErrors).some((distance) => distance > 1.5) || state.text !== 'Still readable') {
      throw new Error(`flip-visual: incorrect result: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(outDir, `flip-visual-after-${engine}-${theme}-${width}.png`), animations: 'disabled', caret: 'hide' });
  },
  async 'touch-targets'(env) {
    const { page } = env;
    await page.goto(`${env.base}/#/`);
    await page.locator('.home-title').waitFor();
    await page.waitForFunction((n) => document.querySelectorAll('.board-row').length >= n, OTHER_BOARDS.length + 1);
    await assertTouchTargets(page, 'boards home and search');

    await openSeedBoard(env);
    await page.evaluate(() => window.__board.setSelection(['seed-title']));
    await page.locator('.quickbar.show').waitFor();
    await assertTouchTargets(page, 'board and quick actions');

    await page.getByRole('button', { name: 'More properties' }).click();
    await page.locator('.props.show').waitFor();
    await assertTouchTargets(page, 'properties panel');

    await page.locator('.font-btn').click();
    await page.locator('.font-picker').waitFor();
    await page.locator('.font-picker .chip').first().waitFor();
    await assertTouchTargets(page, 'font popover and chips');
    await page.keyboard.press('Escape');
    await page.locator('.font-picker').waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('button', { name: 'Board settings' }).click();
    await page.getByRole('dialog', { name: 'Board settings' }).waitFor();
    await assertTouchTargets(page, 'settings dialog and close button');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.querySelector('.props')?.classList.remove('show'));

    await page.evaluate(() => {
      const app = window.__board;
      app.r.flyTo(app.r.contentBounds(['seed-note-1']), 24, 0.9);
    });
    await page.waitForFunction(() => window.__board.r.cam.zoom >= 0.31);
    await page.evaluate(() => window.__board.editor.start('seed-note-1'));
    await page.waitForFunction(() => document.activeElement === document.querySelector('.text-editor'));
    const editorSize = await page.locator('.text-editor').evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    if (editorSize < 16) throw new Error(`canvas text editor computed to ${editorSize}px on a coarse pointer`);
    console.log(`touch-target exceptions: ${TOUCH_TARGET_EXCEPTIONS.join('; ')}`);
    console.log(`touch-targets canvas text editor: ${editorSize}px computed font size at board zoom`);
    return { keepFocus: true };
  },
  async 'board-selected'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => window.__board.setSelection(['seed-rect']));
    const more = env.page.getByRole('button', { name: 'More properties' });
    await more.waitFor();
    await more.evaluate((el) => el.click());
    await env.page.locator('.props.show').waitFor();
  },
  async 'group-selected'(env) {
    await openSeedBoard(env);
    await waitForGroupStyles(env.page);
    const { outerId } = await ensureVisualGroups(env.page);
    await env.page.evaluate((id) => {
      const app = window.__board;
      app.store.transact(() => app.store.update(id, { name: undefined, locked: undefined }));
      app.setSelection([id]);
    }, outerId);
    await env.page.waitForFunction(() => {
      const chip = document.querySelector('.group-chip:not(.group-path-chip)');
      return window.__board.r.cam.zoom < 0.3 ? chip.hidden : !chip.hidden;
    });
  },
  // the quick-action bar with three notes selected: the Group button (a group selected shows Ungroup, see group-selected)
  async 'group-multi'(env) {
    await openSeedBoard(env);
    await waitForGroupStyles(env.page);
    // the relay keeps the groups the other group states made (ensureVisualGroups), which would turn the three notes into a group
    // member and the Group button into Ungroup: dissolve them, outermost first, before selecting the loose notes
    await env.page.evaluate(() => {
      const app = window.__board;
      for (let guard = 0; guard < 10; guard++) {
        const g = [...app.store.cache.values()].find((o) => o.type === 'group' && app.store.get(o.parent)?.type !== 'group');
        if (!g) break;
        app.store.transact(() => app.store.update(g.id, { locked: undefined }));
        app.setSelection([g.id]);
        if (!app.ungroupSelection()) break;
      }
      app.setSelection(['seed-note-1', 'seed-note-2', 'seed-note-3']);
    });
    await env.page.getByRole('button', { name: 'Group', exact: true }).waitFor();
  },
  // phones fit the seed board at 11%, where chips, handles and the lock badge are not drawn: these two zoom the camera onto the group first (at most 90%, so on a phone the whole group fills the width)
  async 'group-selected-zoom'(env) {
    await STATES['group-selected'](env);
    await env.page.evaluate(() => {
      const app = window.__board;
      app.r.flyTo(app.r.contentBounds(app.selection), 24, 0.9);
    });
    await env.page.waitForFunction(() => window.__board.r.cam.zoom >= 0.31);
    await env.page.waitForTimeout(500);
    await env.page.locator('.group-chip:not(.group-path-chip):not([hidden])').waitFor();
  },
  async 'group-entered-zoom'(env) {
    await STATES['group-entered'](env);
    const { outerId } = await ensureVisualGroups(env.page);
    await env.page.evaluate((id) => {
      const app = window.__board;
      app.r.flyTo(app.r.contentBounds([id]), 24, 0.9);
    }, outerId);
    await env.page.waitForFunction(() => window.__board.r.cam.zoom >= 0.31);
    await env.page.waitForTimeout(500);
  },
  // TAB-253: a group selected and the Comments tray open on a phone: the quick bar, the properties panel and the group chips all wait
  async 'group-selected-tray'(env) {
    await STATES['group-selected-zoom'](env);
    await env.page.locator('.comment-toggle').click();
    await env.page.locator('.side-tray.show').waitFor();
    await env.page.waitForTimeout(150);
  },
  async 'group-entered-tray'(env) {
    await STATES['group-entered-zoom'](env);
    await env.page.locator('.comment-toggle').click();
    await env.page.locator('.side-tray.show').waitFor();
    await env.page.waitForTimeout(150);
  },
  // TAB-253: a touch long press on the selection opens the context menu (Group, Ungroup). With the tray open the board shows only in the
  // 12px gutters beside it, so the member is moved under the left one (x 70) before the press
  async 'group-menu-tray'(env) {
    await STATES['group-selected-tray'](env);
    const { outerId } = await ensureVisualGroups(env.page);
    await longPressMember(env.page, 'seed-note-3', outerId);
  },
  async 'group-multi-menu-tray'(env) {
    await STATES['group-multi'](env);
    await env.page.locator('.comment-toggle').click();
    await env.page.locator('.side-tray.show').waitFor();
    await longPressMember(env.page, 'seed-note-1');
  },
  // the same press with no tray open
  async 'group-menu'(env) {
    await STATES['group-selected-zoom'](env);
    const { outerId } = await ensureVisualGroups(env.page);
    await longPressMember(env.page, 'seed-note-3', outerId, 200);
  },
  // TAB-253: Undo and Redo stay at the foot of the rail; the rail is scrolled to its top, where they used to be off screen
  async 'rail-end'(env) {
    await openSeedBoard(env);
    const m = await env.page.evaluate(() => {
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      const rail = box('.rail');
      const redo = box('.rail [aria-label="Redo"]');
      const el = document.querySelector('.rail');
      return { scrolls: el.scrollHeight > el.clientHeight + 1, railBottom: rail.bottom, redoBottom: redo.bottom, vh: innerHeight };
    });
    console.log(`rail-end ${JSON.stringify(m)}`);
    if (m.redoBottom > m.railBottom + 0.5 || m.redoBottom > m.vh) throw new Error(`Redo is out of reach: ${JSON.stringify(m)}`);
  },
  async 'rail-overlap'(env) {
    await openSeedBoard(env);
    const m = await env.page.evaluate(() => {
      const rail = document.querySelector('.rail');
      // on a rail without the .rail-tools wrapper (the TAB-253 layout) the rail itself scrolls: the check must catch that bug too
      const scroller = rail?.querySelector('.rail-tools') ?? rail;
      const undo = rail?.querySelector('[aria-label="Undo"]');
      const redo = rail?.querySelector('[aria-label="Redo"]');
      const failures = [];
      const bounds = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const insideViewport = (r) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const hitTarget = (target, name, position) => {
        const r = bounds(target);
        const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        if (hit !== target && !target.contains(hit)) failures.push(`${position}:${name} centre hit ${hit?.getAttribute('aria-label') ?? hit?.tagName ?? 'nothing'}`);
      };
      if (!rail || !scroller || !undo || !redo) {
        return { failures: ['rail, scroller, Undo or Redo is missing'], maxScroll: 0, positions: [] };
      }
      for (const [name, button] of [['Undo', undo], ['Redo', redo]]) {
        if (!rail.contains(button)) failures.push(`${name} is outside the rail`);
        if (!insideViewport(bounds(button))) failures.push(`${name} is outside the viewport`);
      }
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const stops = [['top', 0], ['middle', maxScroll / 2], ['bottom', maxScroll]];
      const positions = [];
      for (const [position, requestedTop] of stops) {
        scroller.scrollTop = requestedTop;
        const clip = bounds(scroller);
        const pinned = [['Undo', bounds(undo)], ['Redo', bounds(redo)]];
        let visibleButtons = 0;
        let fullyVisibleButtons = 0;
        for (const button of scroller.querySelectorAll('.rail-btn')) {
          const r = bounds(button);
          if (r.width <= 0 || r.height <= 0) continue;
          const visible = {
            left: Math.max(r.left, clip.left),
            top: Math.max(r.top, clip.top),
            right: Math.min(r.right, clip.right),
            bottom: Math.min(r.bottom, clip.bottom),
          };
          if (visible.left >= visible.right || visible.top >= visible.bottom) continue;
          visibleButtons++;
          for (const [label, pin] of pinned) {
            if (visible.left < pin.right && visible.right > pin.left && visible.top < pin.bottom && visible.bottom > pin.top) {
              failures.push(`${position}:${button.getAttribute('aria-label')} overlaps ${label}`);
            }
          }
          const full = r.left >= clip.left && r.top >= clip.top && r.right <= clip.right && r.bottom <= clip.bottom && insideViewport(r);
          if (full) {
            fullyVisibleButtons++;
            hitTarget(button, button.getAttribute('aria-label') ?? 'unnamed tool', position);
          }
        }
        for (const [label, button] of [['Undo', undo], ['Redo', redo]]) hitTarget(button, label, position);
        positions.push({ name: position, scrollTop: scroller.scrollTop, visibleButtons, fullyVisibleButtons });
      }
      scroller.scrollTop = 0;
      return { failures, maxScroll, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, positions };
    });
    console.log(`rail-overlap ${JSON.stringify(m)}`);
    if (m.failures.length) throw new Error(`Rail overlap or hit-test failure: ${JSON.stringify(m.failures)}`);
  },
  async 'group-hover'(env) {
    await openSeedBoard(env);
    await waitForGroupStyles(env.page);
    const { outerId } = await ensureVisualGroups(env.page);
    await env.page.evaluate((id) => {
      const app = window.__board;
      app.store.transact(() => app.store.update(id, { locked: undefined }));
      app.setSelection([]);
      app.r.setOverlay({ hover: id, lockedHover: null });
    }, outerId);
    return { noPark: true };
  },
  async 'group-entered'(env) {
    await openSeedBoard(env);
    await waitForGroupStyles(env.page);
    const { outerId, innerId } = await ensureVisualGroups(env.page);
    await env.page.evaluate(({ outer, inner }) => {
      const app = window.__board;
      app.store.transact(() => {
        app.store.update(outer, { name: 'Header', locked: undefined });
        app.store.update(inner, { name: 'Notes', locked: undefined });
      });
      app.enterGroup(outer);
      app.enterGroup(inner);
    }, { outer: outerId, inner: innerId });
    await env.page.locator('.group-done:not([hidden])').waitFor();
  },
  async 'group-locked'(env) {
    await openSeedBoard(env);
    await waitForGroupStyles(env.page);
    const { outerId } = await ensureVisualGroups(env.page);
    await env.page.evaluate((id) => {
      const app = window.__board;
      app.store.transact(() => app.store.update(id, { name: undefined, locked: true }));
      app.setSelection([]);
      app.r.setOverlay({ hover: null, lockedHover: id });
    }, outerId);
    return { noPark: true };
  },
  // TAB-232: the step before a dot vote, with an item selected (so Selected items is the default) and then the vote running with its outlines
  async 'vote-setup'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => window.__board.setSelection(['seed-rect']));
    await env.page.getByRole('button', { name: 'Start a dot vote' }).click();
    await env.page.getByRole('dialog', { name: 'Start a dot vote' }).waitFor();
  },
  async 'vote-running'(env) {
    await openSeedBoard(env);
    // the vote step lives in the seeded board, so a later width may find it already running
    if (!(await env.page.evaluate(() => window.__board.flow.isVoting()))) {
      await env.page.getByRole('button', { name: 'Start a dot vote' }).click();
      await env.page.getByRole('button', { name: 'Start on everything' }).evaluate((el) => el.click());
    }
    await env.page.locator('.flow-bar, .flowbar').first().waitFor().catch(() => {});
  },
  async 'vote-running-touch'(env) {
    await STATES['vote-running'](env);
    await voteBarOneRow(env, 'vote-running-touch');
  },
  // the same bar when the vote is one step of a session: Next step takes the place of Finish and must still fit the row
  async 'vote-running-touch-steps'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => {
      const f = window.__board.flow;
      f.setSteps([{ id: 'vs1', title: 'Vote', instructions: 'Click any note or shape to add a dot.', mode: 'vote' }, { id: 'vs2', title: 'Discuss', instructions: '', mode: 'discuss' }]);
      f.goto(0);
    });
    await voteBarOneRow(env, 'vote-running-touch-steps');
  },
  // phones only: the properties panel folded to its title row (TAB-187); on wider windows the fold button is not shown
  async 'board-selected-folded'(env) {
    await STATES['board-selected'](env);
    const fold = env.page.getByRole('button', { name: 'Fold properties' });
    if (await fold.isVisible()) {
      await fold.click();
      await env.page.locator('.props.folded').waitFor();
    }
  },
  // TAB-112 and TAB-133: panels and drawers on the right start below the top bars at every width
  async 'drawer-stickers'(env) {
    await openSeedBoard(env);
    await env.page.getByRole('button', { name: 'Stickers', exact: true }).click();
    await env.page.locator('.drawer.show').waitFor();
  },
  async layers(env) {
    await openLayers(env);
    await env.page.evaluate(() => window.__board.setSelection(['seed-rect']));
    await env.page.locator('.layer-row[aria-selected="true"]').waitFor();
  },
  async 'layers-hidden'(env) {
    await openLayers(env, ['seed-note-2', 'seed-diamond']);
    await env.page.locator('.layers-count', { hasText: '2 hidden' }).waitFor();
    await env.page.locator('.layer-row.is-hidden').nth(1).waitFor();
  },
  async history(env) {
    await openSeedBoard(env);
    await env.page.getByRole('button', { name: 'Menu', exact: true }).click();
    await env.page.getByRole('button', { name: 'Version history' }).click();
    await env.page.locator('.history.show, [aria-label="Version history"]').first().waitFor();
  },
  async comments(env) {
    await openSeedBoard(env);
    await env.page.locator('.comment-toggle').click();
    await env.page.locator('.side-tray.show .comment-row').first().waitFor();
  },
  // TAB-231: one comment opened as a thread, its author named once
  async 'comment-thread'(env) {
    await openSeedBoard(env);
    await env.page.locator('.comment-toggle').click();
    await env.page.locator('.side-tray.show .comment-row').first().click();
    await env.page.locator('.comment-msg').first().waitFor();
  },
  // TAB-124: the empty-board hint lies under every overlay
  async 'empty-templates'(env) {
    await openEmptyBoard(env);
    await env.page.getByRole('button', { name: 'Start from a template' }).click();
    await env.page.locator('.drawer.show').waitFor();
  },
  async 'empty-share'(env) {
    await openEmptyBoard(env);
    await env.page.getByRole('button', { name: 'Share', exact: true }).click();
    await env.page.locator('[role="dialog"]').first().waitFor();
  },
  async 'share-code-phone'({ page, base, width }) {
    if (width > 500) throw new Error('share-code-phone is only valid at phone widths');
    await openSeedBoard({ page, base });
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.locator('.modal').waitFor();
    await page.getByRole('button', { name: 'Create code', exact: true }).click();
    const panel = page.locator('.join-code-created');
    await panel.waitFor();
    await page.waitForFunction(() => {
      const element = document.querySelector('.join-code-created');
      const body = element?.closest('.modal-body');
      if (!element || !body) return false;
      const panelRect = element.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      return panelRect.top >= bodyRect.top && panelRect.bottom <= bodyRect.bottom;
    }, undefined, { timeout: 3000 });
    const visible = await panel.evaluate((element) => {
      const body = element.closest('.modal-body');
      const panelRect = element.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const copy = element.querySelector('button');
      return {
        panel: { top: panelRect.top, bottom: panelRect.bottom },
        body: { top: bodyRect.top, bottom: bodyRect.bottom },
        fits: panelRect.top >= bodyRect.top && panelRect.bottom <= bodyRect.bottom,
        copyFocused: copy?.textContent?.trim() === 'Copy code' && document.activeElement === copy,
      };
    });
    if (!visible.fits) throw new Error(`share-code-phone: new code panel is clipped by the modal body: ${JSON.stringify(visible)}`);
    if (!visible.copyFocused) throw new Error('share-code-phone: focus did not move to Copy code');
    return { noPark: true };
  },
  async 'empty-menu'(env) {
    await openEmptyBoard(env);
    await env.page.getByRole('button', { name: 'Menu', exact: true }).click();
    await env.page.getByRole('button', { name: 'Board settings' }).waitFor();
  },
  async 'empty-focus'(env) {
    await openEmptyBoard(env);
    // a second person on the same board asks everyone to look at their view
    // it stays open until the next shot of this state (the card goes when its sender leaves), then it is closed
    await focusSender?.close();
    const other = await newPage(env.page.context().browser(), { width: 1024, theme: 'default', mode: 'open', base: env.base });
    focusSender = other.context;
    {
      const tag = Math.random().toString(36).slice(2, 8);
      await other.page.addInitScript((id) => localStorage.setItem('driftboard:user', JSON.stringify({ id, name: 'Ana', color: '#D64545' })), `visual-other-${tag}`);
      await other.page.goto(`${env.base}/?debug#/b/${EMPTY_ID}`);
      await other.page.waitForFunction(() => window.__board);
      // the request focus.ts puts on its sender's awareness (src/focus-requests.ts buildRequest); the button lives in a running session
      await other.page.evaluate(() => {
        const app = window.__board;
        const u = app.user;
        app.conn.awareness.setLocalStateField('focusRequest', { id: `ask-${u.id}`, x: 0, y: 0, zoom: 1, ts: Date.now(), kind: 'view', from: { id: u.id, name: u.name, color: u.color } });
      });
      await env.page.locator('.focus-stack > *').first().waitFor({ timeout: 8000 });
      await env.page.waitForTimeout(300);
    }
  },
  async 'chat-unread'(env) {
    await resetChatMarker(env);
    await openSeedBoard(env);
    await env.page.locator('.chat-count.show.mention').waitFor();
  },
  async chat(env) {
    await openSeedChat(env);
  },
  // the Chat page (TAB-132 slice 3): the list and the conversation; on a phone the list first, then a conversation
  async 'chat-page'(env) {
    await resetChatMarker(env);
    await env.page.goto(`${env.base}/#/chat`);
    await env.page.locator('.chat-row').first().waitFor();
    if (await env.page.locator('.chat-conv.open').count()) await env.page.locator('.chat-conv.open .chat-msg').first().waitFor();
  },
  async 'chat-page-team'(env) {
    await resetChatMarker(env);
    await env.page.goto(`${env.base}/#/chat/team/${env.chat.teamId}`);
    await env.page.locator('.chat-conv.open .chat-msg').first().waitFor();
    await env.page.locator('.chat-new').waitFor();
  },
  // a message menu with its six reactions, and the card for a mention in a channel you are not looking at
  async 'chat-react'(env) {
    await openSeedChat(env);
    await env.page.locator('.chat-reaction').first().waitFor();
    await env.page.locator('.chat-msg', { has: env.page.locator('.chat-text', { hasText: 'Are we starting at ten?' }) }).locator('.chat-more').click();
    await env.page.getByRole('menuitem', { name: 'React' }).click();
    await env.page.locator('.chat-picker').waitFor();
  },
  async 'chat-mention'(env) {
    await resetChatMarker(env);
    await env.page.goto(`${env.base}/#/`);
    await env.page.locator('.topbar-badge.show').waitFor();
    // the socket is open once the unread total shows; a pause makes sure the server has it before the mention is sent
    await env.page.waitForTimeout(1000);
    await apiJson(env.base, 'POST', `chat/team/${env.chat.teamId}/messages`, { clientId: `visual-mention-${Date.now()}`, text: `@{${env.chat.ownerId}} can you confirm the room before lunch? I need it for the design review on Thursday.` }, env.chat.anaCookie);
    await env.page.locator('.mention-card').waitFor();
  },
  // the Members tab with the two chat actions on a person (TAB-132 slice 5)
  async 'chat-members'({ page, base }) {
    await page.goto(`${base}/#/admin/members`);
    await page.getByRole('button', { name: 'Erase chat messages' }).first().waitFor();
  },
  // TAB-243: the chat tray open while a dot vote runs: the session bar waits, so the message box is on screen and can be typed in
  // TAB-240, TAB-241 and TAB-242: the session bar in a write step, in a poll step, and the Steps list from it, at phone widths
  async 'flow-write'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => {
      const f = window.__board.flow;
      f.setSteps([{ id: 'vc-write', title: 'Brainstorm on sticky notes', mode: 'write', instructions: 'Add one idea per note. Quantity over quality, nobody comments yet.', durationSec: 300 }]);
      f.start();
    });
    await env.page.locator('.flowbar.show .flow-step').waitFor();
  },
  async 'flow-poll'(env) {
    await openSeedBoard(env);
    // the poll lives in the seeded board, so a later width may find it already open
    await env.page.evaluate(() => {
      if (window.__board.flow.pollOpen()) return;
      window.__board.flow.quickPoll({ question: 'Which day should we ship the next release of the mobile app to everyone?', options: ['Monday', 'Wednesday', 'Friday'], multiple: false, anonymous: true });
    });
    await env.page.locator('.flowbar.show').waitFor();
  },
  async 'flow-steps'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => {
      const f = window.__board.flow;
      f.setSteps([
        { id: 'vc-a', title: 'Brainstorm on sticky notes', mode: 'private-write', instructions: 'Write alone first.', durationSec: 300 },
        { id: 'vc-b', title: 'Dot vote', mode: 'vote', instructions: 'Vote for the ideas you like.', durationSec: 180, votesPerPerson: 3 },
      ]);
      f.start();
    });
    await env.page.getByRole('button', { name: 'All steps' }).click();
    await env.page.locator('.step-list').waitFor();
  },
  // QA's Firefox finding: the rail scrolls in a short window with no sign that it does. The edge with more behind it must fade (data-more-y plus a mask)
  async 'rail-scroll-cue'(env) {
    await openSeedBoard(env);
    const result = await env.page.evaluate(async () => {
      const tools = document.querySelector('.rail-tools');
      if (!tools) return { failures: ['.rail-tools is missing'] };
      const max = tools.scrollHeight - tools.clientHeight;
      if (max <= 1) return { failures: [], scrolls: false, viewport: `${innerWidth}x${innerHeight}` };
      const failures = [];
      const mask = () => getComputedStyle(tools).maskImage || getComputedStyle(tools).webkitMaskImage || 'none';
      const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      tools.scrollTop = 0; await settle();
      if (tools.dataset.moreY !== 'down' || mask() === 'none') failures.push(`at the top: data-more-y is ${tools.dataset.moreY ?? 'missing'}, mask ${mask().slice(0, 20)}`);
      tools.scrollTop = Math.floor(max / 2); await settle();
      if (tools.dataset.moreY !== 'both' || mask() === 'none') failures.push(`in the middle: data-more-y is ${tools.dataset.moreY ?? 'missing'}`);
      tools.scrollTop = max; await settle();
      if (tools.dataset.moreY !== 'up' || mask() === 'none') failures.push(`at the bottom: data-more-y is ${tools.dataset.moreY ?? 'missing'}`);
      tools.scrollTop = 0; await settle();
      return { failures, scrolls: true, max, viewport: `${innerWidth}x${innerHeight}` };
    });
    console.log(`rail-scroll-cue ${JSON.stringify(result)}`);
    if (result.failures.length) throw new Error(`rail-scroll-cue: ${JSON.stringify(result.failures)}`);
  },
  // QA's Firefox finding: a toast shown while the Steps list is open covered the list's bottom row (End session). The toast must clear the panel
  async 'top-bars-320'(env) {
    await openSeedBoard(env);
    const result = await env.page.evaluate(() => {
      const left = document.querySelector('.top-left');
      const right = document.querySelector('.top-right');
      const avatar = right?.querySelector('.people .avatar');
      const share = right?.querySelector('.btn.primary');
      const failures = [];
      if (!left || !right || !avatar || !share) return { failures: ['board bars, first avatar or Share button is missing'] };
      const box = (el) => el.getBoundingClientRect();
      const l = box(left), r = box(right);
      if (l.left < 0 || l.right > innerWidth || l.top < 0 || l.bottom > innerHeight) failures.push(`left bar is outside the viewport: ${JSON.stringify(l.toJSON())}`);
      if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) failures.push(`right bar is outside the viewport: ${JSON.stringify(r.toJSON())}`);
      if (l.left < r.right && l.right > r.left && l.top < r.bottom && l.bottom > r.top) failures.push('top-left and top-right bars intersect');
      const rail = document.querySelector('.rail');
      if (rail) {
        const k = box(rail);
        if (r.left < k.right && r.right > k.left && r.top < k.bottom && r.bottom > k.top) failures.push(`the tool rail (${Math.round(k.left)}-${Math.round(k.right)}) covers the right bar (${Math.round(r.left)}-${Math.round(r.right)})`);
      }
      for (const [name, target] of [['first avatar', avatar], ['Share', share]]) {
        const rect = box(target);
        const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        if (rect.width < 44 || rect.height < 44) failures.push(`${name} target is ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}px`);
        if (hit !== target && !target.contains(hit)) failures.push(`${name} centre hits ${hit?.getAttribute('aria-label') ?? hit?.tagName ?? 'nothing'}`);
      }
      return { failures, viewport: `${innerWidth}x${innerHeight}`, left: l.toJSON(), right: r.toJSON() };
    });
    console.log(`top-bars-320 ${JSON.stringify(result)}`);
    if (result.failures.length) throw new Error(`top-bars-320: ${JSON.stringify(result.failures)}`);
  },
  // CDX-21: six people should never push the presence cluster beneath the left tool rail on a phone.
  async 'presence-avatars-many'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => {
      const app = window.__board;
      const self = app.participants().find((person) => person.isMe);
      if (!self) throw new Error('presence-avatars-many: current user is missing');
      const others = [
        { clientId: 71001, user: { id: 'visual-person-1', name: 'Nia', color: '#D64545' }, isMe: false },
        { clientId: 71002, user: { id: 'visual-person-2', name: 'Guest', color: '#4977D1', guest: true }, isMe: false },
        { clientId: 71003, user: { id: 'visual-person-3', name: 'Milo', color: '#177D68' }, isMe: false },
        { clientId: 71004, user: { id: 'visual-person-4', name: 'Ari', color: '#A13BA5' }, isMe: false },
        { clientId: 71005, user: { id: 'visual-person-5', name: 'Sol', color: '#A95C00' }, isMe: false },
        ...Array.from({ length: 6 }, (_, index) => ({ clientId: 71006 + index, user: { id: `visual-person-${index + 6}`, name: `Person ${index + 6}`, color: '#A95C00' }, isMe: false })),
      ];
      app.participants = () => [...others.slice(0, 4), self];
      app.emit('presence');
    });
    await env.page.waitForFunction(() => document.querySelectorAll('.people .avatar').length >= 2);
    const result = await env.page.evaluate(() => {
      const app = window.__board;
      const self = app.participants().find((person) => person.isMe);
      if (!self) throw new Error('presence-avatars-many: current user is missing after seeding');
      const others = [
        { clientId: 71001, user: { id: 'visual-person-1', name: 'Nia', color: '#D64545' }, isMe: false },
        { clientId: 71002, user: { id: 'visual-person-2', name: 'Guest', color: '#4977D1', guest: true }, isMe: false },
        { clientId: 71003, user: { id: 'visual-person-3', name: 'Milo', color: '#177D68' }, isMe: false },
        { clientId: 71004, user: { id: 'visual-person-4', name: 'Ari', color: '#A13BA5' }, isMe: false },
        { clientId: 71005, user: { id: 'visual-person-5', name: 'Sol', color: '#A95C00' }, isMe: false },
      ];
      const people = document.querySelector('.people');
      const topRight = document.querySelector('.top-right');
      const topLeft = document.querySelector('.top-left');
      const rail = document.querySelector('.rail');
      if (!people || !topRight || !topLeft || !rail) return { failures: ['people, top bars, or tool rail are missing'] };
      const box = (element) => element.getBoundingClientRect();
      const baseLimit = innerWidth < 380 ? 1 : innerWidth < 480 ? 2 : 3;
      const scenarios = [];
      const failures = [];
      const sixAvatarCandidateFits = () => {
        const candidate = topRight.cloneNode(true);
        const candidatePeople = candidate.querySelector('.people');
        const avatar = candidatePeople?.querySelector('.avatar:not(.more)');
        if (!candidatePeople || !avatar) return false;
        const more = document.createElement('span');
        more.className = 'avatar more';
        more.textContent = '+6';
        candidatePeople.replaceChildren(...Array.from({ length: 6 }, () => avatar.cloneNode(true)), more);
        Object.assign(candidate.style, { position: 'fixed', top: '0px', left: '-10000px', right: 'auto', width: 'max-content', maxWidth: 'none', visibility: 'hidden' });
        topRight.parentElement.append(candidate);
        const candidateWidth = box(candidate).width;
        candidate.remove();
        const chromeStyle = getComputedStyle(topRight.parentElement);
        const safeLeft = Number.parseFloat(chromeStyle.getPropertyValue('--safe-left')) || 0;
        const safeRight = Number.parseFloat(chromeStyle.getPropertyValue('--safe-right')) || 0;
        return candidateWidth <= innerWidth - 24 - safeLeft - safeRight + 1;
      };
      const fitsSix = sixAvatarCandidateFits();
      for (const total of [5, 6]) {
        app.participants = () => [...others.slice(0, total - 1), self];
        app.emit('presence');
        const bar = box(topRight), left = box(topLeft), tools = box(rail);
        const avatars = [...people.querySelectorAll('.avatar:not(.more)')];
        const more = people.querySelector('.avatar.more');
        const cluster = box(people);
        const visibleLimit = innerWidth < 480 ? baseLimit : fitsSix ? 6 : 3;
        const expectedVisible = Math.min(total, visibleLimit);
        const remaining = Math.max(0, total - visibleLimit);
        const topRightChildren = [...topRight.children].map(box);
        const rowCenters = topRightChildren.map((rect) => rect.top + rect.height / 2);
        const avatarCenters = avatars.map((avatar) => {
          const rect = box(avatar);
          return rect.top + rect.height / 2;
        });
        if (avatars.length !== expectedVisible) failures.push(`${total} participants: expected ${expectedVisible} visible avatars, got ${avatars.length}`);
        if (!avatars[0]?.getAttribute('aria-label')?.includes('(you)')) failures.push(`${total} participants: the viewer own avatar is not first and visible`);
        if (expectedVisible >= 3 && !avatars[2]?.querySelector('.avatar-guest')) failures.push(`${total} participants: the visible guest avatar is missing its Guest badge`);
        if (remaining > 0 && more?.textContent?.trim() !== `+${remaining}`) failures.push(`${total} participants: expected a +${remaining} remainder chip, got ${more?.textContent?.trim() ?? 'none'}`);
        if (remaining > 0 && more?.getAttribute('aria-label') !== `${remaining} more people here`) failures.push(`${total} participants: remainder chip has the wrong accessible name`);
        if (remaining > 0 && more) {
          const chip = box(more);
          if (Math.abs(chip.width - 30) > 0.5 || Math.abs(chip.height - 30) > 0.5) failures.push(`${total} participants: +N chip is ${Math.round(chip.width)}x${Math.round(chip.height)}, expected 30x30`);
        }
        if (remaining === 0 && more) failures.push(`${total} participants: no remainder is expected`);
        if (rowCenters.length && Math.max(...rowCenters) - Math.min(...rowCenters) > 1.5) failures.push(`${total} participants: right tray children wrap onto multiple rows`);
        if (avatarCenters.length && Math.max(...avatarCenters) - Math.min(...avatarCenters) > 1.5) failures.push(`${total} participants: participant avatars are not on one row`);
        if (bar.left < 0 || bar.right > innerWidth) failures.push('right-hand top bar extends outside the viewport');
        if (bar.left < left.right && bar.right > left.left && bar.top < left.bottom && bar.bottom > left.top) failures.push('right-hand top bar overlaps the left top-bar rectangle');
        if (innerWidth <= 860 && bar.top - left.bottom < 7.5) failures.push(`phone bars have only ${Math.round(bar.top - left.bottom)}px vertical clearance, expected 8px`);
        if (tools.top < bar.bottom + 7.5) failures.push(`tool rail starts ${Math.round(bar.bottom - tools.top)}px before the tray clears it by 8px`);
        if (cluster.left < bar.left - 0.5 || cluster.right > bar.right + 0.5) failures.push(`${total} participants: presence cluster is outside the right tray`);
        scenarios.push({ total, visibleAvatars: avatars.length, remainder: remaining, cluster: { left: Math.round(cluster.left), right: Math.round(cluster.right) } });
      }
      const finalBar = box(topRight), finalLeft = box(topLeft), finalTools = box(rail);
      return {
        failures,
        viewport: `${innerWidth}x${innerHeight}`,
        sixAvatarCandidateFits: fitsSix,
        participantScenarios: scenarios,
        railTop: Math.round(finalTools.top),
        topRight: { left: Math.round(finalBar.left), right: Math.round(finalBar.right) },
        topLeft: { left: Math.round(finalLeft.left), right: Math.round(finalLeft.right), top: Math.round(finalLeft.top), bottom: Math.round(finalLeft.bottom) },
        tray: { left: Math.round(finalBar.left), right: Math.round(finalBar.right), top: Math.round(finalBar.top), bottom: Math.round(finalBar.bottom) },
      };
    });
    await env.page.waitForTimeout(900);
    console.log(`presence-avatars-many ${JSON.stringify(result)}`);
    if (result.failures.length) throw new Error(`presence-avatars-many: ${JSON.stringify(result.failures)}`);
  },
  async 'press-board'(env) {
    await openSeedBoard(env);
    await pressZoom(env.page, 1.5);
    await pressRoles(env.page);
  },
  async 'press-poll'(env) {
    await STATES['vote-running'](env);
    await env.page.evaluate(() => window.__board.setSelection([]));
    await pressZoom(env.page, 1.5);
    const spots = await env.page.evaluate(() => {
      const app = window.__board;
      const at = { 'Reviews were fast': 3, 'Clear sprint goal': 1, 'Too many meetings': 4, 'Unclear ownership': 2, 'Flaky tests': 1 };
      const box = app.r.svg.getBoundingClientRect();
      return [...app.store.cache.values()].filter((o) => at[o.text]).map((o) => {
        const c = app.r.toScreen({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
        return { x: c.x + box.left, y: c.y + box.top, times: at[o.text] };
      });
    });
    if (spots.length < 5) throw new Error(`press-poll: found ${spots.length} of the 5 notes`);
    for (const { x, y, times } of spots) for (let i = 0; i < times; i++) await env.page.mouse.click(x, y);
    await env.page.evaluate(() => window.__board.setSelection([]));
    await env.page.mouse.move(1, 1);
    await pressRoles(env.page);
  },
  async 'press-timer'(env) {
    await STATES['flow-write'](env);
    await env.page.evaluate(() => window.__board.flow.startTimer());
    await pressZoom(env.page, 1.5);
    await pressRoles(env.page);
  },
  async 'press-comments'(env) {
    await STATES['comment-thread'](env);
    await pressRoles(env.page);
  },
  async 'press-admin'(env) {
    await STATES.admin(env);
    await pressRoles(env.page);
  },
  // sticky notes with emoji: the sequences that break when text is cut between code points (ZWJ families, skin tones, flags, keycaps), and a row too long for the note
  async 'emoji-text'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => {
      const app = window.__board;
      const set = (id, text) => app.store.transact(() => app.store.update(id, { text }));
      set('seed-note-1', 'Ship it \u{1F680} \u{1F44D}\u{1F3FD}');
      set('seed-note-2', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} family \u{1F1F8}\u{1F1EA} 1\uFE0F\u20E3');
      set('seed-note-3', '\u{1F680}\u{1F44D}\u{1F3FD}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u{1F1F8}\u{1F1EA}1\uFE0F\u20E3\u{1F680}\u{1F44D}\u{1F3FD}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u{1F1F8}\u{1F1EA}');
      app.zoomToFit();
      app.zoomBy(2.4);
    });
    await settle(env.page);
  },
  async 'emoji-picker'(env) {
    const page = env.page;
    await openEmojiPickerForNote(env, { clearPoll: true });
    const result = await page.evaluate(() => {
      const bar = document.querySelector('.edit-bar.show').getBoundingClientRect();
      const button = document.querySelector('.edit-emoji');
      const buttonBox = button.getBoundingClientRect();
      const picker = document.querySelector('.emoji-pop');
      const pickerBox = picker.getBoundingClientRect();
      const noteBox = document.querySelector('.text-editor').getBoundingClientRect();
      const search = picker.querySelector('[aria-label="Search emoji"]');
      const buttons = [...document.querySelectorAll('.edit-emoji, .emoji-cell')].map((el) => {
        const box = el.getBoundingClientRect();
        return { width: box.width, height: box.height, label: el.getAttribute('aria-label') };
      });
      const hit = document.elementFromPoint(buttonBox.left + buttonBox.width / 2, buttonBox.top + buttonBox.height / 2);
      const outside = (box) => box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight;
      return {
        pickerHeight: pickerBox.height, overNote: !(pickerBox.right <= noteBox.left || pickerBox.left >= noteBox.right || pickerBox.bottom <= noteBox.top || pickerBox.top >= noteBox.bottom),
        barOutside: outside(bar), pickerOutside: outside(pickerBox), pickerWidth: pickerBox.width, windowWidth: innerWidth,
        small: buttons.filter((box) => box.width < 44 || box.height < 44), hitButton: hit === button, searchFocused: document.activeElement === search,
      };
    });
    if (result.barOutside) throw new Error('emoji-picker: edit bar is outside the window');
    if (result.pickerOutside) throw new Error('emoji-picker: picker is outside the window');
    if (result.overNote) throw new Error('emoji-picker: the picker covers the note being edited');
    if (result.pickerHeight < 220) throw new Error(`emoji-picker: the picker is only ${Math.round(result.pickerHeight)} px tall, under four rows`);
    if (result.pickerWidth > result.windowWidth) throw new Error(`emoji-picker: picker width ${result.pickerWidth} exceeds ${result.windowWidth}`);
    if (result.small.length) throw new Error(`emoji-picker: controls smaller than 44x44: ${JSON.stringify(result.small)}`);
    if (!result.hitButton) throw new Error('emoji-picker: the Add emoji button centre is covered');
    if (!result.searchFocused) throw new Error('emoji-picker: search is not focused');
  },
  async 'emoji-keyboard'(env) {
    await emojiKeyboard(env, null);
  },
  // a note high on the screen: neither side has room for the panel, so it docks above the keyboard
  async 'emoji-keyboard-high'(env) {
    await emojiKeyboard(env, 126);
  },
  // a finger on Add emoji: WebKit drops the click of a tap whose pointerdown was cancelled, so the picker never opened
  async 'emoji-tap'(env) {
    const page = env.page;
    await openSeedBoard(env);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__board.editor.start('seed-note-1'));
    await page.locator('.edit-bar.show').waitFor();
    await page.waitForFunction(() => document.activeElement === document.querySelector('.text-editor'));
    const box = await page.locator('.edit-emoji').boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    const opened = await page.locator('.emoji-pop').waitFor({ timeout: 3000 }).then(() => true, () => false);
    const active = await page.evaluate(() => window.__board.editor.active);
    console.log(`emoji-tap ${JSON.stringify({ opened, active })}`);
    if (!opened) throw new Error('emoji-tap: a touch tap on Add emoji did not open the picker');
    if (!active) throw new Error('emoji-tap: the tap ended the edit');
  },
  async 'emoji-insert'(env) {
    const page = env.page;
    await openEmojiPickerForNote(env, { clearPoll: true });
    await page.keyboard.type('rock');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.emoji-pop') && window.__board.store.get('seed-note-1').text.endsWith('🚀'));
    const result = await page.evaluate(() => {
      const app = window.__board;
      const textarea = document.querySelector('.text-editor');
      let recent = [];
      try {
        recent = JSON.parse(localStorage.getItem('tabula.emoji.recent') || '[]');
      } catch {
        recent = [];
      }
      return {
        text: app.store.get('seed-note-1').text, active: app.editor.active, focused: document.activeElement === textarea,
        caretAtEnd: textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length,
        pickerOpen: !!document.querySelector('.emoji-pop'), recentFirst: recent[0],
      };
    });
    if (!result.text.endsWith('🚀')) throw new Error('emoji-insert: sticky text does not end with the matching rocket emoji');
    if (!result.active) throw new Error('emoji-insert: editing ended after insertion');
    if (!result.focused) throw new Error('emoji-insert: focus did not return to the textarea');
    if (!result.caretAtEnd) throw new Error('emoji-insert: textarea caret is not after the emoji');
    if (result.pickerOpen) throw new Error('emoji-insert: picker stayed open');
    if (result.recentFirst !== '🚀') throw new Error('emoji-insert: recent emoji did not move to the front');
  },
  async 'emoji-esc'(env) {
    const page = env.page;
    await openEmojiPickerForNote(env);
    const before = await page.evaluate(() => window.__board.store.get('seed-note-1').text);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.emoji-pop') && document.activeElement === document.querySelector('.text-editor'));
    const afterPickerEscape = await page.evaluate(() => ({
      active: window.__board.editor.active, focused: document.activeElement === document.querySelector('.text-editor'),
      text: window.__board.store.get('seed-note-1').text,
    }));
    if (!afterPickerEscape.active || !afterPickerEscape.focused || afterPickerEscape.text !== before) {
      throw new Error(`emoji-esc: first Escape changed the edit state: ${JSON.stringify(afterPickerEscape)}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__board.editor.active);
    const afterEditorEscape = await page.evaluate(() => ({ active: window.__board.editor.active, text: window.__board.store.get('seed-note-1').text }));
    if (afterEditorEscape.active || afterEditorEscape.text !== before) throw new Error(`emoji-esc: second Escape did not commit unchanged text: ${JSON.stringify(afterEditorEscape)}`);
  },
  // frame size presets: pick one in the inspector, type an exact size, undo
  async 'frame-size'(env) {
    const page = env.page;
    await openSeedBoard(env);
    await page.evaluate(() => {
      const b = window.__board;
      b.store.transact(() => b.store.create({ id: 'k-frame', type: 'frame', name: 'Frame 1', x: -300, y: -200, w: 960, h: 600, rotation: 0, z: 1, fill: '#FFFFFF', createdBy: 'seed', createdAt: 1, updatedAt: 1 }));
      b.setSelection(['k-frame']);
    });
    const size = () => page.evaluate(() => { const o = window.__board.store.get('k-frame'); return `${o.w}x${o.h}`; });
    const combo = page.getByRole('combobox', { name: 'Frame size' });
    if (!await combo.count()) await page.getByRole('button', { name: 'More properties' }).click().catch(() => {});
    await combo.waitFor({ timeout: 5000 }).catch(async (e) => { console.log(await page.evaluate(() => JSON.stringify({ sel: window.__board.selected().map((o) => o.type), props: document.querySelector('.props')?.className, text: document.querySelector('.props')?.innerText.slice(0, 200) }))); throw e; });
    const before = await size();
    await combo.click();
    for (const [label, want] of [['A4 portrait', '794x1123'], ['1920 × 1080', '1920x1080'], ['390 × 844', '390x844'], ['Letter landscape', '1056x816']]) {
      if (!await combo.getAttribute('aria-expanded').then((v) => v === 'true')) await combo.click();
      const opt = page.getByRole('option', { name: label, exact: true });
      await opt.scrollIntoViewIfNeeded();
      const box = await opt.boundingBox();
      // Firefox at phone width sends a mouse click at the list to the board's quick bar behind it (no pointerdown reaches the list), so there the option is activated by its click event
      if (process.env.VISUAL_BROWSER === 'firefox' && page.viewportSize().width < 600) await opt.dispatchEvent('click');
      else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(200);
      const got = await size();
      if (got !== want) throw new Error(`frame-size: ${label} gave ${got}, wanted ${want}`);
      await page.waitForFunction(([l]) => [...document.querySelectorAll('[role=combobox]')].some((c) => c.getAttribute('aria-label') === 'Frame size' && c.textContent.includes(l)), [label], { timeout: 3000 })
        .catch(async () => { throw new Error(`frame-size: the box shows "${await combo.textContent()}" after choosing ${label}`); });
    }
    const width = page.getByRole('spinbutton', { name: 'Frame width' });
    await width.fill('700');
    await width.press('Enter');
    await page.waitForFunction(() => window.__board.store.get('k-frame').w === 700);
    await page.waitForFunction(() => [...document.querySelectorAll('[role=combobox]')].some((c) => c.getAttribute('aria-label') === 'Frame size' && c.textContent.includes('Custom')), null, { timeout: 3000 })
      .catch(() => { throw new Error('frame-size: a typed width should read Custom'); });
    await page.waitForFunction(() => !window.__board.styleEdit.active, null, { timeout: 3000 });
    // the number field's Enter and blur both commit, which can leave one empty undo step above the real one
    let undone = false;
    for (let i = 0; i < 3 && !undone; i++) {
      await page.evaluate(() => window.__board.store.undo.undo());
      undone = (await page.evaluate(() => window.__board.store.get('k-frame').w)) !== 700;
    }
    if (!undone) throw new Error('frame-size: undo did not take back the typed width');
    await page.evaluate(() => window.__board.zoomToFit?.());
    console.log(`frame-size before ${before}, now ${await size()}`);
  },
  // Verify rounded chrome against unchanged board geometry across the requested views.
  async 'radius-chrome'(env) {
    const page = env.page;
    const openCleanBoard = async () => {
      await openSeedBoard(env);
      // Earlier poll states can leave the latest closed poll in the idle bar; dismiss it through the app's normal Escape action.
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        const app = window.__board;
        app.scope = null;
        app.setSelection([]);
      });
    };
    const frameObject = async (id) => page.evaluate((objectId) => {
      const app = window.__board;
      app.scope = null;
      app.setSelection([objectId]);
      app.zoomToSelection();
    }, id);
    const zoomToProbe = async () => {
      await page.waitForTimeout(180);
      await page.evaluate(() => window.__board.zoomTo(0.8));
    };
    const addProbe = async () => page.evaluate(() => {
      const app = window.__board;
      const id = 'radius-chrome-probe';
      if (app.store.get(id)) app.store.transact(() => app.store.remove([id]));
      const font = app.store.getMeta().headingFont;
      const z = app.store.get('seed-title')?.z;
      if (!z) throw new Error('radius-chrome probe needs the seeded title z key');
      app.store.transact(() => app.store.create({
        id, type: 'text', x: 1400, y: -130, w: 640, h: 52, rotation: 0, z,
        text: 'Radius check', fontSize: 40, fontWeight: 700, font,
        createdBy: 'visual-radius', updatedAt: Date.now(),
      }));
    });
    const removeProbe = async () => page.evaluate(() => {
      const app = window.__board;
      if (app?.store.get('radius-chrome-probe')) app.store.transact(() => app.store.remove(['radius-chrome-probe']));
    }).catch(() => {});
    const shot = async (part) => page.screenshot({
      path: path.join(env.outDir, `radius-chrome-${env.theme}-${env.width}-${part}.png`),
      animations: 'disabled', caret: 'hide',
    });
    const assertRadii = async (name, checks) => {
      const result = await page.evaluate((entries) => {
        const values = {};
        const failures = [];
        for (const [selector, expected] of entries) {
          const el = document.querySelector(selector);
          if (!el) { failures.push(`${selector} is missing`); continue; }
          const actual = getComputedStyle(el).borderTopLeftRadius;
          values[selector] = actual;
          if (Number.parseFloat(actual) <= 0 || actual !== `${expected}px`) failures.push(`${selector} radius is ${actual}, expected ${expected}px`);
        }
        return { failures, values };
      }, Object.entries(checks));
      if (result.failures.length) throw new Error(`radius-chrome ${name}: ${result.failures.join('; ')}`);
      console.log(`radius-chrome ${name} ${JSON.stringify(result.values)}`);
    };

    await openCleanBoard();
    await addProbe();
    try {
    await frameObject('radius-chrome-probe');
    await zoomToProbe();
    await page.locator('.quickbar.show').waitFor();
    await assertRadii('toolbar', {
      '.top-left': 12, '.top-right': 12, '.rail': 12, '.quickbar': 12, '.zoom-tray': 12,
      '.quickbar .icon-btn': 8, '.top-right .btn': 8,
    });
    await shot('toolbar');

    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('.menu').waitFor();
    await assertRadii('menu', { '.menu': 12, '.menu-item': 8 });
    const clipping = await page.evaluate(() => {
      const menu = document.querySelector('.menu').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.menu .menu-item')];
      const first = rows[0]?.getBoundingClientRect();
      const last = rows.at(-1)?.getBoundingClientRect();
      const contained = (r) => r && r.left >= menu.left && r.right <= menu.right && r.top >= menu.top && r.bottom <= menu.bottom;
      return { rows: rows.length, first: first && { top: first.top, bottom: first.bottom }, last: last && { top: last.top, bottom: last.bottom }, failures: [!contained(first) && 'first menu item extends beyond its container', !contained(last) && 'last menu item extends beyond its container'].filter(Boolean) };
    });
    if (!clipping.rows || clipping.failures.length) throw new Error(`radius-chrome menu clipping: ${JSON.stringify(clipping)}`);
    await shot('menu');
    await page.keyboard.press('Escape');

    await openEmojiPickerForNote(env, { clearPoll: true, frameNote: true, objectId: 'radius-chrome-probe' });
    await assertRadii('emoji popover', { '.emoji-pop': 12, '.emoji-search': 8, '.emoji-cell': 4 });
    await shot('popover');
    await page.keyboard.press('Escape');

    await openCleanBoard();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.locator('.modal').waitFor();
    await assertRadii('Share dialog', { '.modal': 14, '.modal input': 8, '.modal .icon-btn': 8, '.modal .btn': 8 });
    // Keep a focused control in each engine's capture to inspect how its outline follows the computed radius.
    await page.locator('.modal input').click();
    const inputFocused = await page.locator('.modal input').evaluate((el) => document.activeElement === el);
    if (!inputFocused) throw new Error('radius-chrome Share input did not receive focus');
    const modalClipping = await page.locator('.modal').evaluate((el) => getComputedStyle(el).overflow);
    if (modalClipping !== 'hidden') throw new Error(`radius-chrome Share dialog should clip nested content, got overflow ${modalClipping}`);
    await shot('dialog');

    await openCleanBoard();
    await frameObject('radius-chrome-probe');
    await zoomToProbe();
    await page.evaluate(() => window.__board.editor.start('radius-chrome-probe'));
    await page.locator('.text-editor[data-mode="text"]').waitFor();
    const boardText = await page.evaluate(() => {
      const editor = document.querySelector('.text-editor');
      const object = document.querySelector('.canvas [data-id="radius-chrome-probe"]');
      return { editor: getComputedStyle(editor).borderRadius, object: object && getComputedStyle(object).borderRadius };
    });
    if (!boardText.object || boardText.editor !== boardText.object || boardText.object !== '0px') {
      throw new Error(`radius-chrome board text/editor geometry changed: ${JSON.stringify(boardText)}`);
    }

    await page.keyboard.press('Escape');
    await frameObject('seed-conn-3');
    const labelGeometry = await page.locator('.canvas [data-id="seed-conn-3"] rect[rx="4"]').getAttribute('rx');
    if (labelGeometry !== '4') throw new Error('radius-chrome connector label pill geometry is missing or changed');
    await page.evaluate(() => window.__board.editor.start('seed-conn-3'));
    await page.locator('.text-editor[data-mode="label"]').waitFor();
    await assertRadii('connector label editor', { '.text-editor[data-mode="label"]': 4 });

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Toggle minimap', exact: true }).click();
    await page.locator('.minimap.show').waitFor();
    await assertRadii('minimap', { '.minimap': 12, '.minimap canvas': 4 });
    await shot('minimap');
    } finally {
      await page.keyboard.press('Escape').catch(() => {});
      await removeProbe();
    }
  },
  async 'steps-toast'(env) {
    await STATES['flow-steps-overlap-edit'](env);
    const result = await env.page.evaluate(async () => {
      document.body.append(Object.assign(document.createElement('div'), { className: 'toast show', textContent: 'Dot vote started on 2 items, no limit. Click one to add a dot.' }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const toast = document.querySelector('.toast.show').getBoundingClientRect();
      const pop = document.querySelector('.popover.wide').getBoundingClientRect();
      const bar = document.querySelector('.flowbar.show').getBoundingClientRect();
      const hits = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const failures = [];
      if (hits(toast, pop)) failures.push(`the toast (${Math.round(toast.top)}-${Math.round(toast.bottom)}) covers the Steps list (${Math.round(pop.top)}-${Math.round(pop.bottom)})`);
      if (hits(toast, bar)) failures.push('the toast covers the session bar');
      return { failures, toast: { top: toast.top, bottom: toast.bottom }, popover: { top: pop.top, bottom: pop.bottom }, viewport: `${innerWidth}x${innerHeight}` };
    });
    console.log(`steps-toast ${JSON.stringify(result)}`);
    if (result.failures.length) throw new Error(`steps-toast: ${JSON.stringify(result.failures)}`);
  },
  async 'flow-steps-overlap'(env) {
    await STATES['flow-steps'](env);
    await checkStepsOverlap(env, 'flow-steps-overlap');
  },
  // a long session: the Steps list is tall, so a popover that is only placed above the bar runs down over it (the reported case)
  // QA's WebKit case: Add step with its form open and the new step set to Dot vote makes the Steps list taller still
  async 'flow-steps-overlap-edit'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => {
      const f = window.__board.flow;
      f.setSteps([{ id: 'vc-q', title: 'Quick poll', mode: 'write', instructions: 'Answer.', durationSec: 120 }]);
      f.start();
    });
    await env.page.getByRole('button', { name: 'All steps' }).click();
    await env.page.locator('.step-list').waitFor();
    await env.page.getByRole('button', { name: 'Add step' }).click();
    const select = env.page.getByLabel('Step 2 mode');
    await select.selectOption('vote');
    await env.page.waitForTimeout(300);
    await checkStepsOverlap(env, 'flow-steps-overlap-edit');
  },
  async 'flow-steps-overlap-many'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => {
      const f = window.__board.flow;
      f.setSteps(Array.from({ length: 10 }, (_, i) => ({ id: `vc-m${i}`, title: `Step ${i + 1}: a longer title for the list`, mode: i % 3 === 1 ? 'vote' : 'write', instructions: 'Do the thing together.', durationSec: 180, votesPerPerson: i % 3 === 1 ? 3 : undefined })));
      f.start();
    });
    await env.page.getByRole('button', { name: 'All steps' }).click();
    await env.page.locator('.step-list').waitFor();
    await checkStepsOverlap(env, 'flow-steps-overlap-many');
  },
  async 'chat-session'(env) {
    await resetChatMarker(env);
    await openSeedBoard(env);
    if (!(await env.page.evaluate(() => window.__board.flow.isVoting()))) {
      await env.page.getByRole('button', { name: 'Start a dot vote' }).click();
      await env.page.getByRole('button', { name: 'Start on everything' }).evaluate((el) => el.click());
    }
    await env.page.locator('.chat-toggle').click();
    await env.page.getByRole('combobox', { name: 'Message' }).click({ timeout: 5000 });
  },
  // TAB-243 counterpart: a running poll card and facilitator bar wait while the chat tray is open on a phone.
  async 'chat-poll'(env) {
    await resetChatMarker(env);
    await STATES['flow-poll'](env);
    await env.page.locator('.chat-toggle').click();
    await env.page.getByRole('combobox', { name: 'Message' }).waitFor();
  },
  async 'chat-poll-overlap'(env) {
    await resetChatMarker(env);
    await STATES['flow-poll'](env);
    await env.page.locator('.chat-toggle').click();
    await env.page.locator('.side-tray.show .chat-composer').waitFor();
    const result = await env.page.evaluate(() => {
      const tray = document.querySelector('.side-tray.show');
      const composer = tray?.querySelector('.chat-composer');
      const surfaces = [...document.querySelectorAll('.poll-card:not([hidden]), .flowbar.show')];
      if (!tray || !composer) return { failures: ['Chat tray or composer is missing'] };
      const c = composer.getBoundingClientRect();
      const hit = document.elementFromPoint((c.left + c.right) / 2, (c.top + c.bottom) / 2);
      const failures = [];
      const checks = surfaces.map((el) => {
        const r = el.getBoundingClientRect();
        const intersects = r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
        const visible = getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
        if (visible && intersects) failures.push(`${el.className} visibly intersects the chat composer`);
        return { name: el.className, intersects, visible };
      });
      if (!composer.contains(hit)) failures.push(`composer centre hits ${hit?.className || hit?.tagName || 'nothing'}`);
      return { failures, viewport: `${innerWidth}x${innerHeight}`, surfaces: checks, hit: hit?.className || hit?.tagName };
    });
    console.log(`chat-poll-overlap ${JSON.stringify(result)}`);
    if (result.failures.length) throw new Error(`chat-poll-overlap: ${JSON.stringify(result.failures)}`);
  },
  async 'chat-object'(env) {
    await openSeedChat(env);
    await env.page.locator('.chat-object').first().waitFor();
    // a sticky selected on the board: the button that attaches it, and the chip it makes
    await env.page.evaluate(() => window.__board.setSelection(['seed-rect']));
    await env.page.getByRole('button', { name: 'Reference selection' }).click();
    await env.page.locator('.chat-attached').waitFor();
  },
  async 'chat-notifications'(env) {
    await env.page.goto(`${env.base}/#/chat`);
    await env.page.getByRole('button', { name: 'Notifications' }).click();
    await env.page.getByRole('checkbox', { name: 'Email me when I am mentioned in chat' }).waitFor();
    await env.page.waitForFunction(() => !document.querySelector('.modal input')?.disabled);
  },
  async 'chat-home'(env) {
    await resetChatMarker(env);
    await env.page.goto(`${env.base}/#/`);
    await env.page.locator('.topbar-badge.show').waitFor();
  },
  async 'chat-admin'({ page, base }) {
    await page.goto(`${base}/#/admin/chat`);
    await page.getByRole('radio', { name: '1 year' }).waitFor();
  },
  async 'chat-composer'(env) {
    await openSeedChat(env);
    const field = env.page.getByRole('combobox', { name: 'Message' });
    await field.click();
    await field.pressSequentially('Thanks @b');
    await env.page.locator('.chat-suggest .chat-option').first().waitFor();
    if (await env.page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await assertTouchTargets(env.page, 'chat composer');
    // the typeahead closes when the field loses focus, so this shot keeps it
    return { keepFocus: true };
  },
  async templates({ page, base }) {
    await page.goto(`${base}/#/templates`);
    await page.locator('.tpl-card').first().waitFor();
  },
  async 'templates-esc'(env) {
    await openSeedBoard(env);
    const button = env.page.getByRole('button', { name: 'Templates and team exercises' });
    await button.click();
    await env.page.locator('.drawer.show').waitFor();
    await env.page.keyboard.press('Escape');
    await env.page.locator('.drawer.show').waitFor({ state: 'hidden' });
    const result = await env.page.evaluate(() => ({
      open: !!document.querySelector('.drawer.show'),
      focusReturned: document.activeElement === document.querySelector('[data-drawer="templates"]'),
    }));
    if (result.open || !result.focusReturned) throw new Error(`templates-esc: ${JSON.stringify(result)}`);
  },
  async settings(env) {
    await openSeedBoard(env);
    await env.page.getByRole('button', { name: 'Menu', exact: true }).click();
    await env.page.getByRole('button', { name: 'Board settings' }).click();
    await env.page.getByRole('dialog', { name: 'Board settings' }).waitFor();
  },
  async kanban(env) {
    await openKanbanBoard(env);
  },
  async 'kanban-card'(env) {
    await openKanbanBoard(env);
    await env.page.evaluate(() => window.__board.setSelection(['k-c2']));
  },
  async 'kanban-drag'(env) {
    await openKanbanBoard(env);
    const { page } = env;
    const from = await screenOf(page, 'k-c3', 0.5, 0.5);
    const to = await screenOf(page, 'k-d1', 0.6, 0.95);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await settle(page);
    return { noPark: true };
  },
  async 'kanban-drag-empty'(env) {
    await openKanbanBoard(env);
    const { page } = env;
    const from = await screenOf(page, 'k-c3', 0.5, 0.5);
    const to = await screenOf(page, 'k-review', 0.5, 0.3);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await settle(page);
    return { noPark: true };
  },
  async 'kanban-keyboard'(env) {
    await openKanbanBoard(env);
    const { page } = env;
    await page.evaluate(() => window.__board.setSelection(['k-d2']));
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowDown');
    await page.locator('[role="status"][aria-live="polite"]').filter({ hasText: 'Moved to Doing' }).waitFor({ state: 'attached' });
  },
  async 'kanban-adding'(env) {
    await openKanbanBoard(env);
    const { page } = env;
    await page.evaluate(() => window.__board.cardInput.start('k-todo'));
    await page.locator('.k-input').fill('Draft the release notes');
    await settle(page);
    return { noPark: true };
  },
  async 'kanban-wip'(env) {
    // its own board: the extra card would otherwise stay in the shared one and change every later kanban shot
    await openKanbanBoard(env, { board: `${KANBAN_ID}-wip` });
    await env.page.evaluate(() => {
      const app = window.__board;
      if (!app.store.get('k-d4')) {
        const card = { id: 'k-d4', type: 'card', parent: 'k-doing', rank: 'a3@k-doing', text: 'Phone sheet at 390', labels: ['ui'], ownerName: 'Ana Novak', due: '2026-01-22', x: 0, y: 0, w: 264, h: 0, rotation: 0, z: 'a0', createdBy: 'visual-seed', updatedAt: Date.now(), font: app.store.getMeta().bodyFont };
        card.h = window.__kanban.cardContentHeight(card, 264);
        app.store.transact(() => app.store.create(card));
      }
      app.setSelection([]);
    });
  },
  // slice 3: the card dialog (a bottom sheet at phone width), the Labels dialog, a card with everything set, K
  async 'kanban-dialog'(env) {
    await openKanbanBoard(env);
    await env.page.evaluate(() => {
      const app = window.__board;
      app.setSelection(['k-c2']);
      app.openCardDialog('k-c2');
    });
    await env.page.getByRole('dialog', { name: 'Card in To do' }).waitFor();
    await env.page.evaluate(() => document.activeElement?.blur());
    await settle(env.page);
  },
  // v5: a card with an overdue date, an agent owner and a long link, in the phone card dialog and in the list sheet (360 and 390)
  async 'kanban-card-meta'(env) {
    await openKanbanBoard(env);
    await env.page.evaluate(() => {
      const app = window.__board;
      app.store.transact(() => app.store.update('k-c2', { due: '2020-01-01', ownerId: 'agent-token-1', ownerName: 'Build agent for the release', ownerKind: 'agent', link: 'https://example.com/team/releases/2026/q1/migration-guide-for-teams-moving-sprint-boards?ref=board-card&utm=press' }));
      app.setSelection(['k-c2']);
      app.openCardDialog('k-c2');
    });
    await env.page.getByRole('dialog', { name: 'Card in To do' }).waitFor();
    await env.page.evaluate(() => document.activeElement?.blur());
    await settle(env.page);
    const result = await env.page.evaluate(() => {
      const failures = [];
      const link = document.querySelector('.k-open-link');
      const dlg = link?.closest('[role="dialog"]');
      const mark = dlg?.querySelector('.k-owner-kind-btn[data-owner-kind="agent"]');
      if (!dlg || !link) return { failures: ['card dialog or its Open link is missing'] };
      const d = dlg.getBoundingClientRect();
      if (d.left < -0.5 || d.right > innerWidth + 0.5) failures.push(`the dialog is wider than the window (${Math.round(d.left)}-${Math.round(d.right)})`);
      if (dlg.scrollWidth > dlg.clientWidth + 1) failures.push(`the dialog scrolls sideways (${dlg.scrollWidth} > ${dlg.clientWidth})`);
      if (link.hidden || link.getClientRects().length === 0) failures.push('Open link is not shown');
      else {
        link.scrollIntoView({ block: 'center' });
        const r = link.getBoundingClientRect();
        const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        if (r.height < 44) failures.push(`Open link is ${Math.round(r.height)} px tall`);
        if (hit !== link && !link.contains(hit)) failures.push(`Open link centre hits ${hit?.className || hit?.tagName}`);
        if (r.right > innerWidth || r.left < 0) failures.push(`Open link is outside the window (${Math.round(r.left)}-${Math.round(r.right)})`);
      }
      if (mark) {
        const m = mark.getBoundingClientRect();
        if (m.right > innerWidth || m.left < 0) failures.push('the Agent owner button is outside the window');
      }
      return { failures, viewport: `${innerWidth}x${innerHeight}` };
    });
    console.log(`kanban-card-meta ${JSON.stringify(result)}`);
    if (result.failures.length) throw new Error(`kanban-card-meta: ${JSON.stringify(result.failures)}`);
  },
  async 'kanban-sheet-meta'(env) {
    await openKanbanBoard(env);
    await env.page.evaluate(() => {
      const app = window.__board;
      app.store.transact(() => app.store.update('k-c2', { due: '2020-01-01', ownerId: 'agent-token-1', ownerName: 'Build agent for the release', ownerKind: 'agent', link: 'https://example.com/team/releases/2026/q1/migration-guide?ref=board-card' }));
    });
    await openSheet(env.page, 'k-todo');
    const result = await env.page.evaluate(() => {
      const failures = [];
      const row = [...document.querySelectorAll('.ks-sheet .ks-meta')].find((m) => m.querySelector('.ks-link'));
      if (!row) return { failures: ['no row with an Open link in the sheet'] };
      const link = row.querySelector('.ks-link');
      const owner = row.querySelector('.ks-owner.agent');
      const due = row.querySelector('.ks-due.overdue');
      link.scrollIntoView({ block: 'center' });
      const m = row.getBoundingClientRect();
      if (row.scrollWidth > row.clientWidth + 1) failures.push(`the meta row overflows (${row.scrollWidth} > ${row.clientWidth})`);
      if (m.right > innerWidth + 0.5) failures.push(`the meta row runs past the window (${Math.round(m.right)})`);
      for (const [name, el] of [['Open link', link], ['agent owner', owner], ['overdue date', due]]) {
        if (!el) { failures.push(`${name} is missing`); continue; }
        const r = el.getBoundingClientRect();
        if (r.right > innerWidth || r.left < 0) failures.push(`${name} is outside the window (${Math.round(r.left)}-${Math.round(r.right)})`);
      }
      const r = link.getBoundingClientRect();
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      if (r.height < 44) failures.push(`Open link is ${Math.round(r.height)} px tall`);
      if (hit !== link && !link.contains(hit)) failures.push(`Open link centre hits ${hit?.className || hit?.tagName}`);
      return { failures, row: { left: m.left, right: m.right, width: m.width }, link: { w: r.width, h: r.height }, viewport: `${innerWidth}x${innerHeight}` };
    });
    console.log(`kanban-sheet-meta ${JSON.stringify(result)}`);
    if (result.failures.length) throw new Error(`kanban-sheet-meta: ${JSON.stringify(result.failures)}`);
    return { noPark: true };
  },
  async 'kanban-labels'(env) {
    await openKanbanBoard(env);
    await env.page.evaluate(() => window.__board.openLabels());
    await env.page.getByRole('dialog', { name: 'Labels' }).waitFor();
    await env.page.evaluate(() => document.activeElement?.blur());
    await settle(env.page);
  },
  async 'kanban-labels-colour'(env) {
    // the Labels dialog with the first label's colour list open
    await openKanbanBoard(env);
    await env.page.evaluate(() => window.__board.openLabels());
    await env.page.getByRole('dialog', { name: 'Labels' }).waitFor();
    await env.page.locator('.k-colour-btn').first().click();
    await env.page.locator('.k-colour-pop').waitFor();
    await settle(env.page);
  },
  async 'kanban-full-card'(env) {
    // its own board: the description and the comment would otherwise stay in the shared one
    await openKanbanBoard(env, { board: `${KANBAN_ID}-card`, fit: false });
    await env.page.evaluate(() => {
      const app = window.__board;
      if (!app.store.get('k-c2').desc) {
        app.store.transact(() => app.store.update('k-c2', { desc: 'Steps: open Safari 17, sign in, watch the redirect.' }));
        app.comments.addThread({ id: 'visual-user', name: 'Visual QA', color: '#2F6FED' }, { x: 0, y: 0, obj: 'k-c2', fx: 0.95, fy: 0.1 }, 'Seen on iOS too.');
      }
      app.setSelection(['k-c2']);
      app.r.fit(app.r.contentBounds(['k-c2']), window.innerWidth < 600 ? 24 : 240, 2);
    });
    await settle(env.page);
  },
  async 'kanban-convert'(env) {
    // its own board: K turns the note into a card in Review, which would change every later kanban shot
    await openKanbanBoard(env, { board: `${KANBAN_ID}-convert` });
    await env.page.evaluate(() => {
      const app = window.__board;
      // every shot shares the board: an earlier one left the note a card, so it goes back to a sticky first
      if (app.store.get('k-note-1').type === 'card') app.turnIntoStickies(['k-note-1']);
      const lane = app.store.getPlaced('k-review');
      app.store.transact(() => app.store.update('k-note-1', { x: lane.x + 40, y: lane.y + 60, parent: undefined }));
      app.setSelection(['k-note-1']);
    });
    await env.page.keyboard.press('k');
    await env.page.waitForFunction(() => window.__board.store.get('k-note-1').type === 'card');
    await settle(env.page);
  },
  // slice 4: the lane and kanban menus, the Filter popover, a filter on, a refused drop into a full block lane, a new lane
  // a selected lane (and the kanban around it) shows no connector anchor dots: lanes and the kanban take no connectors; a hovered card still does
  async 'kanban-lane-no-anchors'(env) {
    await openKanbanBoard(env);
    // a point on the screen where the pointer is over that object itself (not a card or the kanban around it)
    const at = (id) => env.page.evaluate((id) => {
      const app = window.__board;
      const o = app.store.getPlaced(id);
      const r = app.r.svg.getBoundingClientRect();
      for (let fy = 0.02; fy < 1; fy += 0.04) for (let fx = 0.1; fx < 0.95; fx += 0.1) {
        const w = { x: o.x + o.w * fx, y: o.y + o.h * fy };
        if (app.hit(w)?.id !== id) continue;
        const q = app.r.toScreen(w);
        return { x: r.left + q.x, y: r.top + q.y };
      }
      return null;
    }, id);
    const anchors = () => env.page.evaluate(() => document.querySelectorAll('svg .anchor').length);
    await env.page.evaluate(() => window.__board.setSelection(['k-doing']));
    const lane = await at('k-doing');
    if (!lane) throw new Error('kanban-lane-no-anchors: no point of the Doing lane is reachable by the pointer');
    await env.page.mouse.move(lane.x - 8, lane.y - 8);
    await env.page.mouse.move(lane.x, lane.y, { steps: 4 });
    await env.page.waitForTimeout(250);
    const onLane = await anchors();
    await env.page.evaluate(() => window.__board.setSelection(['k-c2']));
    const card = await at('k-c2');
    if (!card) throw new Error('kanban-lane-no-anchors: no point of the card is reachable by the pointer');
    await env.page.mouse.move(card.x - 8, card.y - 8);
    await env.page.mouse.move(card.x, card.y, { steps: 4 });
    await env.page.waitForTimeout(250);
    const onCard = await anchors();
    console.log(`kanban-lane-no-anchors ${JSON.stringify({ onLane, onCard })}`);
    if (onLane !== 0) throw new Error(`kanban-lane-no-anchors: a selected lane shows ${onLane} anchor dots`);
    if (onCard !== 4) throw new Error(`kanban-lane-no-anchors: a hovered card should keep its 4 anchors (found ${onCard}); the check would prove nothing`);
    // dragging a connector from a note onto the lane must not bind to the lane or the kanban: the end stays free
    await env.page.evaluate(() => { window.__board.setSelection([]); window.__board.setTool({ kind: 'connector' }); });
    const from = await at('k-note-1');
    if (!from) throw new Error('kanban-lane-no-anchors: no point of the note is reachable by the pointer');
    await env.page.mouse.move(from.x, from.y);
    await env.page.mouse.down();
    await env.page.mouse.move((from.x + lane.x) / 2, (from.y + lane.y) / 2, { steps: 6 });
    await env.page.mouse.move(lane.x, lane.y, { steps: 6 });
    await env.page.mouse.up();
    await env.page.waitForTimeout(250);
    const end = await env.page.evaluate(() => {
      const app = window.__board;
      const c = [...app.store.cache.values()].find((o) => o.type === 'connector' && ((o.from.kind === 'bound' && o.from.id === 'k-note-1') || (o.to.kind === 'bound' && o.to.id === 'k-note-1')));
      return c ? { from: c.from.kind === 'bound' ? c.from.id : 'free', to: c.to.kind === 'bound' ? c.to.id : 'free' } : null;
    });
    console.log(`kanban-lane-no-anchors drag ${JSON.stringify(end)}`);
    if (!end) throw new Error('kanban-lane-no-anchors: dragging from the note made no connector, so the drag check proves nothing');
    if (end.to === 'k-doing' || end.to === 'k-box') throw new Error(`kanban-lane-no-anchors: a dragged connector bound to ${end.to}`);
    await env.page.evaluate(() => { window.__board.setTool({ kind: 'select' }); window.__board.setSelection(['k-doing']); });
  },
  // the board menu opens with the User guide: first, an accent of at least 3:1 on its icon, the same button and name
  async 'board-menu-guide'(env) {
    await openSeedBoard(env);
    await env.page.getByRole('button', { name: 'Menu', exact: true }).click();
    await env.page.locator('.menu').waitFor();
    const r = await env.page.evaluate(() => {
      const rgb = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      const menu = document.querySelector('.menu');
      const first = menu.querySelector('.menu-item');
      const icon = first.querySelector('.ico');
      const bg = getComputedStyle(menu.closest('.popover') ?? menu).backgroundColor;
      return { text: first.textContent.trim(), tag: first.tagName, firstChild: menu.firstElementChild === first, ratio: ratio(rgb(getComputedStyle(icon).color), rgb(bg)), weight: getComputedStyle(first.querySelector('span:not([class])')).fontWeight, name: first.textContent.trim() };
    });
    console.log(`board-menu-guide ${JSON.stringify(r)}`);
    if (!r.text.startsWith('User guide') || r.tag !== 'BUTTON' || !r.firstChild) throw new Error(`board-menu-guide: the first entry is not the User guide button (${JSON.stringify(r)})`);
    if (r.ratio < 3) throw new Error(`board-menu-guide: the accent is ${r.ratio.toFixed(2)}:1, under 3:1`);
    if (Number(r.weight) < 600) throw new Error(`board-menu-guide: the label is not heavier (${r.weight})`);
  },
  async 'kanban-lane-menu'(env) {
    await openKanbanBoard(env);
    await env.page.evaluate(() => window.__board.openLaneMenu('k-doing'));
    await env.page.getByRole('menu', { name: 'Doing lane menu' }).waitFor();
    await settle(env.page);
    return { noPark: true };
  },
  async 'kanban-menu'(env) {
    await openKanbanBoard(env);
    await env.page.evaluate(() => {
      window.__board.setSelection(['k-box']);
      window.__board.openContainerControl('k-box', 'menu');
    });
    await env.page.getByRole('menu', { name: 'Kanban menu' }).waitFor();
    await settle(env.page);
    return { noPark: true };
  },
  async 'kanban-filter'(env) {
    // its own board: a filter is kept per board in this browser, and would dim every later kanban shot
    await openKanbanBoard(env, { board: `${KANBAN_ID}-filter` });
    await env.page.evaluate(() => {
      const app = window.__board;
      app.setKanbanFilter('k-box', { mine: true, labels: ['bug'], due: [], text: '' });
      app.openContainerControl('k-box', 'filter');
    });
    await env.page.getByRole('dialog', { name: 'Filter cards' }).waitFor();
    await settle(env.page);
    return { noPark: true };
  },
  async 'kanban-filter-on'(env) {
    await openKanbanBoard(env, { board: `${KANBAN_ID}-filter` });
    await env.page.evaluate(() => window.__board.setKanbanFilter('k-box', { mine: true, labels: ['bug'], due: [], text: '' }));
    await settle(env.page);
    await zoomOnLane(env.page, 'k-doing'); // phone: one lane at about 100%, where the dimming shows
  },
  async 'kanban-wip-block'(env) {
    // its own board: Review is filled to its limit of 2
    await openKanbanBoard(env, { board: `${KANBAN_ID}-block` });
    const { page } = env;
    await fillReview(page);
    await settle(page);
    // phone: Doing and Review side by side, zoomed before the pickup (a card picked up at the whole-board zoom keeps its
    // low-detail ghost), and the card taken from Doing so that it and the full lane are both on screen
    const phone = await page.evaluate(() => window.innerWidth < 600);
    if (phone) await zoomOnLane(page, ['k-doing', 'k-review']);
    const from = await screenOf(page, phone ? 'k-d1' : 'k-c3', 0.5, 0.5);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
    const over = await screenOf(page, 'k-review', 0.5, 0.55);
    await page.mouse.move(over.x, over.y, { steps: 8 });
    await settle(page);
    return { noPark: true };
  },
  async 'kanban-wip-refused'(env) {
    await STATES['kanban-wip-block'](env);
    await env.page.mouse.up();
    await env.page.locator('.toast').filter({ hasText: 'Review is full' }).waitFor();
    return { noPark: true };
  },
  async 'kanban-addlane'(env) {
    // its own board: the new lane would otherwise widen every later kanban shot
    await openKanbanBoard(env, { board: `${KANBAN_ID}-addlane` });
    await env.page.evaluate(() => {
      const app = window.__board;
      if (app.store.containerLayout('k-box').lanes.length < 5) app.addLaneTo('k-box');
      app.r.fit(window.innerWidth < 600 ? app.r.contentBounds(['k-box']) : app.r.contentBounds(), window.innerWidth < 600 ? 8 : 40, 1);
    });
    await settle(env.page);
    // phone: the new lane, with its name field open, at about 100%
    await zoomOnLane(env.page, await env.page.evaluate(() => window.__board.store.containerLayout('k-box').lanes.at(-1)));
    return { noPark: true };
  },
  // slice 5: the list sheet, its filter, Move to… (with a full block lane), the kanban templates
  async 'kanban-sheet'(env) {
    await openKanbanBoard(env);
    await openSheet(env.page, 'k-doing');
    return { noPark: true };
  },
  async 'kanban-sheet-filter'(env) {
    await openKanbanBoard(env, { board: `${KANBAN_ID}-filter` });
    await env.page.evaluate(() => window.__board.setKanbanFilter('k-box', { mine: true, labels: ['bug'], due: [], text: '' }));
    await openSheet(env.page, 'k-todo');
    await env.page.locator('.ks-filter').click();
    await env.page.getByRole('dialog', { name: 'Filter cards' }).waitFor();
    await settle(env.page);
    return { noPark: true };
  },
  async 'kanban-sheet-adding'(env) {
    await openKanbanBoard(env, { board: `${KANBAN_ID}-sheet-add` });
    await openSheet(env.page, 'k-review');
    await env.page.locator('.ks-add-btn').click();
    await env.page.locator('.ks-input').fill('Draft the release notes');
    await settle(env.page);
    return { noPark: true };
  },
  async 'kanban-moveto'(env) {
    await openKanbanBoard(env);
    await openSheet(env.page, 'k-doing');
    await openMoveTo(env.page, 'Lane menu and WIP warning');
    return { noPark: true };
  },
  async 'kanban-moveto-full'(env) {
    await openKanbanBoard(env, { board: `${KANBAN_ID}-block` });
    await fillReview(env.page);
    await openSheet(env.page, 'k-doing');
    await openMoveTo(env.page, 'Lane menu and WIP warning');
    return { noPark: true };
  },
  async 'kanban-lane-drag'(env) {
    // slice 5, part 2: a lane held by its header over the gap after the next lane (a pointer; a finger pans)
    await openKanbanBoard(env, { board: `${KANBAN_ID}-lane-drag` });
    const { page } = env;
    if (await page.evaluate(() => window.innerWidth < 600)) await zoomOnLane(page, ['k-todo', 'k-doing']);
    const from = await screenOf(page, 'k-todo', 0.4, 0.05);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
    const over = await screenOf(page, 'k-doing', 0.7, 0.05);
    await page.mouse.move(over.x, over.y, { steps: 8 });
    await settle(page);
    return { noPark: true };
  },
  async 'kanban-sheet-viewer'(env) {
    // a viewer: no Add card bar, no grips; the last row must scroll clear of the home indicator
    await openKanbanBoard(env, { board: `${KANBAN_ID}-viewer` });
    await env.page.evaluate(() => {
      window.__board.store.setReadOnly(true);
      window.__board.comments.setReadOnly(true);
    });
    await openSheet(env.page, 'k-doing');
    // headless has no home indicator, so check the rule that reserves its space is the one that applies
    const reserved = await env.page.evaluate(() => !!document.querySelector('.ks-panel:has(+ .ks-add[hidden])'));
    if (!reserved) throw new Error('kanban-sheet-viewer: the panel does not reserve the safe area under the last row');
    await env.page.evaluate(() => document.querySelector('.ks-panel')?.scrollTo(0, 1e6));
    await settle(env.page);
    return { noPark: true };
  },
  async 'kanban-sheet-full'(env) {
    await openKanbanBoard(env, { board: `${KANBAN_ID}-block` });
    await fillReview(env.page);
    await openSheet(env.page, 'k-review');
    return { noPark: true };
  },
  async 'kanban-templates'({ page, base }) {
    await page.goto(`${base}/#/templates`);
    await page.locator('.tpl-card').first().waitFor();
    await page.getByRole('button', { name: 'Planning', exact: true }).click();
    await page.getByRole('heading', { name: 'Sprint board' }).waitFor();
    await settle(page);
  },
  async 'kanban-lowdetail'(env) {
    await openKanbanBoard(env, { fit: false });
    await env.page.evaluate(() => {
      const app = window.__board;
      const b = app.store.getPlaced('k-box');
      const s = app.r.size();
      const zoom = 0.3;
      app.r.setCamera({ zoom, x: b.x + b.w / 2 - s.w / 2 / zoom, y: b.y + b.h / 2 - s.h / 2 / zoom });
    });
    await settle(env.page);
  },
  async admin({ page, base }) {
    await page.goto(`${base}/#/admin`);
    await waitForAdminPanel(page);
  },
  async 'admin-tokens'({ page, base }) {
    const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('**/api/me', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      return json(route, { ...(await res.json()), mcp: true });
    });
    await page.route('**/api/admin/tokens', (route) => json(route, []));
    await page.goto(`${base}/#/admin/tokens`);
    await page.getByRole('button', { name: 'Create a token' }).waitFor();
    await page.getByText('No active access tokens.', { exact: true }).waitFor();
  },
  async 'backups-list'({ page, base }) {
    await mockBackups(page);
    await page.goto(`${base}/#/admin/backups`);
    await page.locator('.backups-row').first().waitFor();
    await waitForAdminPanel(page);
  },
  async 'backups-detail'(env) {
    await openBackup(env);
  },
  async 'backups-board-copy'(env) {
    await openBackup(env);
    await env.page.getByRole('button', { name: 'Restore a board as a copy' }).click();
    await env.page.locator('.backups-pick-row').first().waitFor();
    await env.page.locator('.backups-pick-row').nth(1).click();
  },
  async 'backups-confirm'(env) {
    await openBackup(env);
    await env.page.getByRole('button', { name: 'Restore the whole workspace' }).click();
    await env.page.locator('#backups-confirm').waitFor();
  },
  async 'backups-restoring'(env) {
    await openBackup(env);
    await env.page.getByRole('button', { name: 'Restore the whole workspace' }).click();
    await env.page.locator('#backups-confirm').fill('RESTORE');
    await env.page.getByRole('button', { name: 'Restore this backup' }).click();
    await env.page.locator('.restoring').waitFor();
  },
  // QA sweep of the AI surfaces: Test key answered well and badly, and the review panel of someone else's proposal
  async 'ai-key-test'(env) {
    await openAiKeyDialogWith(env, { ok: true });
    await env.page.getByText('The key works.').waitFor();
  },
  async 'ai-key-test-error'(env) {
    await openAiKeyDialogWith(env, { ok: false, status: 502, body: { error: 'ai_key_invalid', message: 'rejected' } });
    await env.page.getByText('The AI key was rejected.').waitFor();
  },
  // TAB-222: both key screens, Anthropic and OpenAI-compatible, empty, filled in, with a bad address, and with a saved key
  async 'ai-key-me'(env) {
    await openMyAiKey(env, {});
  },
  async 'ai-key-me-openai'(env) {
    await openMyAiKey(env, {});
    await fillOpenAiKey(env);
  },
  async 'ai-key-me-openai-bad'(env) {
    await openMyAiKey(env, {});
    await fillOpenAiKey(env, { baseUrl: 'http://10.0.0.5/v1', model: 'a b' });
  },
  async 'ai-key-me-openai-saved'(env) {
    await openMyAiKey(env, { mine: { provider: 'openai-compatible', hint: '1234', ...NVIDIA } });
  },
  async 'ai-key-me-anthropic-saved'(env) {
    await openMyAiKey(env, { mine: { provider: 'anthropic', hint: '4f2a' } });
  },
  async 'ai-admin'(env) {
    await openAdminAi(env, {});
  },
  async 'ai-admin-openai'(env) {
    await openAdminAi(env, {});
    await fillOpenAiKey(env);
  },
  // keyboard only: the focus order of the key form and the provider select
  async 'ai-key-me-keyboard'(env) {
    await openMyAiKey(env, {});
    await walkKeyFormByKeyboard(env, { saveName: 'Save key' });
  },
  async 'ai-admin-keyboard'(env) {
    await openAdminAi(env, {});
    await walkKeyFormByKeyboard(env, { saveName: 'Save key' });
  },
  async 'ai-admin-openai-bad'(env) {
    await openAdminAi(env, {});
    await fillOpenAiKey(env, { baseUrl: 'https://localhost/v1', model: '-x' });
  },
  async 'ai-admin-openai-saved'(env) {
    await openAdminAi(env, { workspace: { provider: 'openai-compatible', hint: '1234', ...NVIDIA } });
  },
  async 'ai-admin-anthropic-saved'(env) {
    await openAdminAi(env, { workspace: { provider: 'anthropic', hint: '4f2a' } });
  },
  async 'text-handles'(env) {
    // TAB-233: a selected text shows handles on its sides (wrap width) and corners (type size)
    await openSeedBoard(env);
    await env.page.evaluate(() => {
      const app = window.__board;
      const s = app.store;
      // on clear canvas, right of everything the seed board holds
      const all = app.r.contentBounds();
      s.transact(() => s.create({ id: 'visual-text', type: 'text', x: all ? all.x + all.w + 120 : 0, y: all ? all.y + 40 : 0, w: 300, h: 80, rotation: 0, z: s.topZ(), text: 'Paste your thinking together', fontSize: 26, createdBy: app.user.id, updatedAt: Date.now() }));
      app.r.fit(app.r.contentBounds(['visual-text']), 140, 1.4);
      app.setSelection(['visual-text']);
    });
    await settle(env.page);
  },
  async 'paste-text'(env) {
    const { page } = env;
    await openSeedBoard(env);
    const paste = async (worldPoint, text) => {
      const screen = await page.evaluate((p) => {
        const app = window.__board;
        const point = app.r.toScreen(p);
        const bounds = app.r.root.getBoundingClientRect();
        return { x: bounds.left + point.x, y: bounds.top + point.y };
      }, worldPoint);
      await page.mouse.move(screen.x, screen.y);
      // Mobile emulation in Firefox does not send a mouse pointermove from page.mouse; seed the canvas's pointer listener
      // at the same client point so lastPointer has the same value in all three engines.
      await page.evaluate((point) => {
        window.__board.r.svg.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: point.x, clientY: point.y,
        }));
      }, screen);
      const event = await page.evaluate((value) => {
        const data = new DataTransfer();
        data.setData('text/plain', value);
        const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
        if (paste.clipboardData !== data) Object.defineProperty(paste, 'clipboardData', { configurable: true, value: data });
        window.dispatchEvent(paste);
        return { prevented: paste.defaultPrevented, textCount: [...window.__board.store.cache.values()].filter((o) => o.type === 'text').length };
      }, text);
      if (!event.prevented) throw new Error('paste-text: the window paste event was not handled');
      return event;
    };
    await page.evaluate(() => window.__board.r.setCamera({ x: 0, y: 0, zoom: 0.7 }));
    const firstText = 'First pasted line\nSecond pasted line\n\nFourth line';
    const beforeFirstPaste = await page.evaluate(() => [...window.__board.store.cache.values()].filter((o) => o.type === 'text').length);
    const first = await paste({ x: 320, y: 600 }, firstText);
    if (first.textCount !== beforeFirstPaste + 1) throw new Error('paste-text: the first clipboard paste did not add exactly one text object');
    const firstObject = await page.evaluate((value) => {
      const app = window.__board;
      return [...app.store.cache.values()].find((o) => o.type === 'text' && o.text === value);
    }, firstText);
    if (!firstObject || firstObject.parent) throw new Error(`paste-text: multi-line clipboard text was not kept as one loose object: ${JSON.stringify(firstObject ?? null)}`);
    const secondText = 'Text pasted inside a frame';
    const second = await paste({ x: 220, y: 380 }, secondText);
    const child = await page.evaluate((value) => {
      const app = window.__board;
      return [...app.store.cache.values()].find((o) => o.type === 'text' && o.text === value);
    }, secondText);
    if (!child || child.parent !== 'seed-frame-good') throw new Error(`paste-text: expected the second paste to be a child of seed-frame-good, got ${child?.parent ?? 'no object'}`);
    if (second.textCount !== first.textCount + 1) throw new Error('paste-text: expected each paste to add exactly one text object');
    await page.evaluate(() => window.__board.r.setCamera({ x: -50, y: 0, zoom: 0.7 }));
    console.log(`paste-text ${JSON.stringify({ first: firstObject.text, firstWidth: firstObject.w, frameParent: child.parent })}`);
    await settle(page);
  },
  async 'text-scale-touch'(env) {
    const { page, browserName } = env;
    await openSeedBoard(env);
    await page.evaluate(() => {
      const app = window.__board;
      const store = app.store;
      store.undo.stopCapturing();
      store.transact(() => store.create({
        id: 'visual-touch-text', type: 'text', x: 1100, y: 120, w: 300, h: 80, rotation: 0,
        z: store.topZ(), text: 'Touch the corner to scale this text', fontSize: 26,
        createdBy: app.user.id, updatedAt: Date.now(),
      }));
      store.undo.stopCapturing();
      app.r.fit(app.r.contentBounds(['visual-touch-text']), 30, 1.4);
      app.setSelection(['visual-touch-text']);
    });
    await settle(page);
    const start = await page.evaluate(() => {
      const app = window.__board;
      const o = app.store.get('visual-touch-text');
      const bounds = app.r.root.getBoundingClientRect();
      const screen = (p) => {
        const q = app.r.toScreen(p);
        return { x: bounds.left + q.x, y: bounds.top + q.y };
      };
      const corner = screen({ x: o.x + o.w, y: o.y + o.h });
      const opposite = screen({ x: o.x, y: o.y });
      const target = { x: opposite.x + (corner.x - opposite.x) * 1.6, y: opposite.y + (corner.y - opposite.y) * 1.6 };
      return {
        corner: { x: corner.x + 21.9, y: corner.y + 21.9 }, target,
        fontSize: o.fontSize, undoDepth: app.store.undo.undoStack.length,
        coarse: matchMedia('(pointer: coarse)').matches,
      };
    });
    if (env.width <= 500 && !start.coarse) throw new Error('text-scale-touch: the phone viewport did not get a coarse pointer');
    const dragTouch = async (from, to) => {
      if (browserName === 'chromium') {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: from.x, y: from.y }] });
        for (let i = 1; i <= 8; i++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ id: 1, x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }],
          });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
        return;
      }
      // Playwright exposes tap but not a touch drag in WebKit and Firefox. Keep the same coarse-pointer hit path by
      // checking the far edge with a real touch tap, then dispatching touch pointer moves on the canvas.
      if (env.width <= 500) await page.touchscreen.tap(from.x, from.y);
      await page.evaluate(({ from: a, to: b }) => {
        const svg = window.__board.r.svg;
        Object.defineProperty(svg, 'setPointerCapture', { configurable: true, value() {} });
        const send = (type, point, buttons) => svg.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 31, pointerType: 'touch', isPrimary: true,
          button: 0, buttons, clientX: point.x, clientY: point.y,
        }));
        send('pointerdown', a, 1);
        for (let i = 1; i <= 8; i++) send('pointermove', { x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 }, 1);
        send('pointerup', b, 0);
      }, { from, to });
    };
    await dragTouch(start.corner, start.target);
    const scaled = await page.evaluate(() => {
      const app = window.__board;
      const o = app.store.get('visual-touch-text');
      return { fontSize: o.fontSize, undoDepth: app.store.undo.undoStack.length, coarse: matchMedia('(pointer: coarse)').matches };
    });
    if (scaled.fontSize <= start.fontSize) throw new Error(`text-scale-touch: font size did not grow from ${start.fontSize}`);
    if (scaled.undoDepth !== start.undoDepth + 1) throw new Error(`text-scale-touch: drag used ${scaled.undoDepth - start.undoDepth} undo steps`);
    await page.evaluate(() => window.__board.store.undo.undo());
    await page.waitForFunction((size) => window.__board.store.get('visual-touch-text').fontSize === size, start.fontSize);
    await page.evaluate(() => window.__board.store.undo.redo());
    await page.waitForFunction((size) => window.__board.store.get('visual-touch-text').fontSize > size, start.fontSize);
    await page.evaluate(() => window.__board.r.fit(window.__board.r.contentBounds(['visual-touch-text']), 30, 1.4));
    console.log(`text-scale-touch ${JSON.stringify({ browser: browserName, from: start.fontSize, to: scaled.fontSize, hitTarget: start.coarse ? '44×44px' : 'coarse pointer not enabled at this width' })}`);
    await settle(page);
  },
  async 'ai-preview-empty'(env) {
    // TAB-214: a preview on an empty board hides the "An empty board" hint
    await openEmptyBoard(env, '?debug');
    await sendAiRun(env.page);
    await env.page.locator('.empty-hint').waitFor({ state: 'hidden' });
    await settle(env.page);
  },
  async 'ai-review'(env) {
    const { page } = env;
    await openSeedBoard(env, '?debug');
    await sendAiRun(page);
    await page.getByRole('button', { name: /review/i }).first().click();
    await page.locator('.aireview').first().waitFor();
    await settle(page);
  },
  // TAB-141: another person's AI run in flight, outlined in their colour around what it reads (docs/ai-toolbar.md, "Multiplayer")
  async 'ai-live-remote-ring'(env) {
    const { page } = env;
    await openSeedBoard(env, '?debug');
    await handAiRuns(page, [{ id: 'visual-run', feature: 'cluster', status: 'running', private: false, startedAt: 1, readyAt: null, cut: false, by: ANA, target: { ids: ['seed-note-1', 'seed-note-2'] }, proposal: null }]);
    await page.locator('.ailive-run:not([hidden])').first().waitFor();
    await settle(page);
  },
  // TAB-141: another person's ready preview, with its label row, outline and ghost frame title. zoomToFit fits what is on the board,
  // not a preview beside it, so the view is fitted to the board and the room right of it, where the preview lands.
  async 'ai-live-remote-preview'(env) {
    const { page } = env;
    await openSeedBoard(env, '?debug');
    await handAiRuns(page, [{
      id: 'visual-run', feature: 'generate', status: 'ready', private: false, startedAt: 1, readyAt: 2, cut: false, by: ANA, target: null,
      proposal: { kind: 'create', objects: [{ text: 'Pilot with five teams', color: 'Yellow' }, { text: 'Write the migration guide', color: 'Pink' }, { text: 'Decide the pricing copy', color: 'Blue' }], frame: { title: 'Ideas' } },
    }]);
    await page.locator('.ailive-row:not([hidden])').first().waitFor();
    await page.evaluate(() => {
      const app = window.__board;
      const b = app.r.contentBounds();
      app.r.fit({ x: b.x, y: b.y, w: b.w + 760, h: b.h }, 60, 2);
    });
    await page.locator('.ailive-row:not([hidden])').first().waitFor();
    await settle(page);
  },
  async 'backups-off'({ page, base }) {
    await page.goto(`${base}/#/admin/backups`);
    await page.getByText('Not set up', { exact: true }).waitFor();
  },
};
// These pages are longer than the window and the point of the shot is the whole of it (the list under the status).
const FULL_PAGE = new Set(['tracker-foundation', 'tracker-inbox-long-list', 'tracker-notification-prefs', 'backups-list', 'backups-detail', 'backups-board-copy', 'backups-confirm']);
const BACKUPS_STATES = ['backups-list', 'backups-detail', 'backups-board-copy', 'backups-confirm', 'backups-restoring', 'backups-off'];
/** States that drive the kanban's phone sheet, which only exists under 600 px (it is a side panel on a wide screen): not run wider. */
const PHONE_ONLY_STATES = new Set(['kanban-moveto', 'kanban-moveto-full', 'kanban-sheet-adding', 'kanban-sheet-filter', 'kanban-card-meta', 'kanban-sheet-meta', 'vote-running-touch', 'vote-running-touch-steps', 'emoji-keyboard', 'emoji-keyboard-high', 'emoji-tap', 'tracker-phone', 'tracker-phone-new-issue', 'share-code-phone']);
const NARROW_STATES = new Set(['tracker-inbox-narrow']);
const CHAT_STATES = new Set(['chat', 'chat-composer', 'chat-unread', 'chat-page', 'chat-page-team', 'chat-home', 'chat-admin', 'chat-react', 'chat-mention', 'chat-notifications', 'chat-members', 'chat-object', 'chat-session', 'chat-poll', 'chat-poll-overlap', 'esc-trays']);
// The kanban board is opened by id and seeded with a fixed comment author, which only open mode accepts as it is.
const KANBAN_STATES = Object.keys(STATES).filter((s) => s.startsWith('kanban'));
const STATE_MODES = { admin: ['accounts'], 'press-admin': ['accounts'], 'admin-tokens': ['accounts'], 'ai-key-test': ['accounts'], 'ai-key-test-error': ['accounts'], 'join-short-code': ['accounts'], 'share-code-phone': ['accounts'], ...Object.fromEntries(['ai-key-me', 'ai-key-me-openai', 'ai-key-me-openai-bad', 'ai-key-me-openai-saved', 'ai-key-me-anthropic-saved', 'ai-admin', 'ai-admin-openai', 'ai-admin-openai-bad', 'ai-admin-openai-saved', 'ai-admin-anthropic-saved', 'ai-key-me-keyboard', 'ai-admin-keyboard'].map((s) => [s, ['accounts']])), 'ai-review': ['open'], 'ai-preview-empty': ['open'], 'text-handles': ['open'], 'paste-text': ['open'], 'text-scale-touch': ['open'], 'ai-live-remote-ring': ['open'], 'ai-live-remote-preview': ['open'], ...Object.fromEntries(KANBAN_STATES.map((s) => [s, ['open']])), ...Object.fromEntries([...CHAT_STATES].map((s) => [s, ['accounts']])), ...Object.fromEntries(BACKUPS_STATES.map((s) => [s, ['accounts']])) };
const statesFor = (mode) => Object.keys(STATES).filter((s) => !STATE_MODES[s] || STATE_MODES[s].includes(mode));

// ---------------------------------------------------------------- relay

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

function relayEnv({ mode, port, dataDir, distDir, frameable, chat, joinCodes }) {
  // Nothing from the caller's shell may reach the relay: it would turn on MCP, backups, AI or a hosted workspace.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TABULA_|MIRA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: distDir, QUIET: '1' });
  if (mode === 'accounts') {
    Object.assign(env, { TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: OWNER_EMAIL, TABULA_BASE_URL: `http://127.0.0.1:${port}` });
    if (chat) env.TABULA_CHAT = 'on';
    if (joinCodes) env.TABULA_JOIN_CODES = 'on';
  }
  if (frameable) env.TABULA_DEV_ALLOW_FRAMING = '1';
  return env;
}

const newRelayHandle = () => ({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-visual-')), base: '', child: null });

/** Starts the relay for `handle` and resolves when it answers. The caller stops it, also when this throws. */
async function startRelay(handle, options) {
  const port = await freePort();
  handle.base = `http://127.0.0.1:${port}`;
  let stderr = '';
  let exited = false;
  // cwd is the empty data folder because the relay loads a .env file from where it starts
  const child = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], {
    cwd: handle.dataDir,
    env: relayEnv({ ...options, port, dataDir: handle.dataDir }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  handle.child = child;
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  child.on('exit', () => (exited = true));
  child.on('error', (err) => (stderr += String(err)));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (exited) throw new Error(`the relay stopped at start:\n${stderr.trim()}`);
    if (Date.now() > deadline) throw new Error(`the relay did not answer in 20 seconds:\n${stderr.trim()}`);
    const ok = await fetch(`${handle.base}/api/health`).then((res) => res.ok, () => false);
    if (ok) return;
    await sleep(100);
  }
}

async function stopRelay(handle) {
  const { child } = handle;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    const stopped = await Promise.race([exited.then(() => true), sleep(5000, null, { ref: false }).then(() => false)]);
    if (!stopped) {
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(2000, null, { ref: false })]);
    }
  }
  removeDir(handle.dataDir);
}

// ---------------------------------------------------------------- accounts mode

async function postJson(base, route, body, cookie, verb = 'POST') {
  const headers = { 'content-type': 'application/json', 'x-tabula': '1', ...(cookie ? { cookie } : {}) };
  const init = { method: verb, headers, body: JSON.stringify(body) };
  const res = await fetch(`${base}/api/${route}`, init);
  if (!res.ok) throw new Error(`${verb} /api/${route} answered ${res.status}: ${await res.text()}`);
  return res;
}

async function readLoginToken(dataDir) {
  const outbox = path.join(dataDir, 'outbox.jsonl');
  for (let i = 0; i < 100; i++) {
    const last = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).at(-1) : undefined;
    const match = last && /token=([^\s&]+)/.exec(JSON.parse(last).text);
    if (match) return decodeURIComponent(match[1]);
    await sleep(100);
  }
  throw new Error('no sign-in mail reached outbox.jsonl');
}

/** Signs the owner in over the API and creates the boards the home screen lists. Returns the session cookie. */
async function prepareAccounts({ base, dataDir }) {
  await postJson(base, 'auth/request', { email: OWNER_EMAIL });
  const verified = await postJson(base, 'auth/verify', { token: await readLoginToken(dataDir) });
  const [pair] = verified.headers.getSetCookie()[0].split(';');
  const cookie = pair.trim();
  await postJson(base, 'me', { name: USER.name }, cookie, 'PATCH');
  // created oldest first, a second apart, so the list order does not depend on the server's clock resolution
  for (const { id, title } of [...OTHER_BOARDS, { id: BOARD_ID, title: SEED_TITLE }]) {
    await postJson(base, 'boards', { id, title }, cookie);
    await sleep(1100);
  }
  const eq = cookie.indexOf('=');
  return { session: { name: cookie.slice(0, eq), value: cookie.slice(eq + 1) }, cookie };
}

// ---------------------------------------------------------------- browser

// Fonts come from Fontshare (the app's own choice). They are fetched once per run and replayed, so the run does not
// depend on the network after that; every other outside host is refused. Offline, the app falls back to system fonts.
const fontCache = new Map();
const isOutside = (url) => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1';

async function serveOutside(route) {
  const url = new URL(route.request().url());
  if (!url.hostname.endsWith('fontshare.com')) return route.abort();
  const key = url.href;
  if (!fontCache.has(key)) {
    fontCache.set(key, route.fetch({ timeout: 8000 }).then(async (res) => ({
      status: res.status(),
      headers: {
        ...Object.fromEntries(Object.entries(res.headers()).filter(([name]) => !/^(content-encoding|content-length|transfer-encoding)$/.test(name))),
        ...(url.hostname === 'api.fontshare.com' ? { 'access-control-allow-origin': '*' } : {}),
      },
      body: await res.body(),
    }), () => null));
  }
  const cached = await fontCache.get(key);
  return cached ? route.fulfill(cached) : route.abort();
}

async function newPage(browser, { width, theme, mode, base, session, touch = false, offlineFontCatalogue = false }) {
  const emulateTouch = touch || width <= 500;
  const context = await browser.newContext({
    viewport: { width, height: heightFor(width) },
    deviceScaleFactor: 1,
    isMobile: emulateTouch,
    hasTouch: emulateTouch,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.clock.setFixedTime(NOW);
  await context.route(isOutside, serveOutside);
  const boards = mode === 'open'
    ? [
      { id: BOARD_ID, name: SEED_TITLE, createdAt: NOW - 2 * HOUR, updatedAt: NOW - 5 * MINUTE },
      ...OTHER_BOARDS.map((b) => ({ id: b.id, name: b.title, createdAt: NOW - b.ago - HOUR, updatedAt: NOW - b.ago })),
    ]
    : null;
  await context.addInitScript(({ themeId, user, index, offlineFontCatalogue: cachedFonts }) => {
    try {
      localStorage.setItem('driftboard:theme', themeId);
      localStorage.setItem('driftboard:user', JSON.stringify(user));
      if (index) localStorage.setItem('driftboard:boards', JSON.stringify(index));
      if (cachedFonts) localStorage.setItem('driftboard:fontshare-catalogue', JSON.stringify({ at: Date.now(), fonts: [] }));
    } catch {
      /* storage is not available in this frame */
    }
  }, { themeId: theme, user: USER, index: boards, offlineFontCatalogue });
  if (session) await context.addCookies([{ ...session, url: base, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return { context, page, errors };
}

async function capture({ browser, state, theme, width, file, shared }) {
  const { context, page, errors } = await newPage(browser, {
    width, theme, ...shared, touch: shared.touch || (state === 'text-scale-touch' && width <= 500),
    offlineFontCatalogue: state === 'paste-text' || state === 'text-scale-touch',
  });
  const result = { state, theme, width, file, overflow: 0, errors, failed: null };
  try {
    const shot = await STATES[state]({ page, base: shared.base, dataDir: shared.dataDir, chat: shared.chat, outDir: shared.outDir, browserName: browser.browserType().name(), theme, width });
    // a state that holds the mouse down or keeps an input focused would be undone by parking
    if (shot?.noPark) { /* left as it is */ }
    else if (shot?.keepFocus) await page.mouse.move(1, 1);
    else await park(page);
    await settle(page);
    result.overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    await page.screenshot({ path: path.join(shared.outDir, file), animations: 'disabled', caret: 'hide', fullPage: FULL_PAGE.has(state) });
  } catch (err) {
    result.failed = String(err.message).split('\n')[0];
    result.file = file.replace(/\.png$/, '-FAILED.png');
    await page.screenshot({ path: path.join(shared.outDir, result.file), animations: 'disabled' }).catch(() => undefined);
  } finally {
    await context.close().catch(() => undefined);
  }
  return result;
}

// ---------------------------------------------------------------- contact sheet

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function writeIndex(outDir, { id, mode, results, seconds }) {
  const notes = (r) => [
    r.failed && `failed: ${r.failed}`,
    r.overflow > 0 && `page is ${r.overflow}px wider than the window`,
    r.errors.length > 0 && `${r.errors.length} script error${r.errors.length > 1 ? 's' : ''}: ${r.errors[0]}`,
  ].filter(Boolean);
  const states = [...new Set(results.map((r) => r.state))];
  const sections = states.map((state) => {
    const ofState = results.filter((r) => r.state === state);
    const rows = [...new Set(ofState.map((r) => r.theme))].map((theme) => {
      const figures = ofState.filter((r) => r.theme === theme).map((r) => {
        const flags = notes(r);
        return `<figure style="width:${Math.min(360, Math.max(140, Math.round(r.width / 4)))}px">
<a href="${esc(r.file)}"><img src="${esc(r.file)}" alt="${esc(`${r.state} ${r.theme} ${r.width}`)}" loading="lazy"></a>
<figcaption>${esc(r.theme)} · ${r.width}px${flags.length ? `<br><b>${esc(flags.join('; '))}</b>` : ''}</figcaption>
</figure>`;
      });
      return `<div class="row">\n${figures.join('\n')}\n</div>`;
    });
    return `<section><h2>${esc(state)}</h2>\n${rows.join('\n')}\n</section>`;
  });
  const problems = results.filter((r) => notes(r).length).length;
  fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(id)} visual check</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#18212b}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-top:1px solid #d5dbe2;padding-top:12px}
p{margin:0;color:#5b6672}.row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;margin-bottom:16px}
figure{margin:0}img{display:block;width:100%;height:auto;border:1px solid #d5dbe2}
figcaption{font-size:12px;color:#5b6672;margin-top:4px}figcaption b{color:#d41e24;font-weight:600}
</style></head><body>
<h1>${esc(id)} visual check</h1>
<p>${results.length} screenshots, ${esc(mode)} mode, ${problems} with problems, ${seconds}s. Click a shot for full size.</p>
${sections.join('\n')}
</body></html>
`);
}

// ---------------------------------------------------------------- main

function readOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        id: { type: 'string' }, mode: { type: 'string', default: 'open' }, states: { type: 'string' }, widths: { type: 'string' },
        themes: { type: 'string' }, out: { type: 'string', default: 'tabula-review' }, 'no-build': { type: 'boolean' },
        frameable: { type: 'boolean' }, touch: { type: 'boolean' }, dark: { type: 'boolean' }, light: { type: 'boolean' }, help: { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { help: true };
  if (!values.id) throw new UsageError('--id is required, for example --id TAB-123');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(values.id)) throw new UsageError('--id may only hold letters, digits, dot, dash and underscore');
  if (values.mode !== 'open' && values.mode !== 'accounts') throw new UsageError('--mode must be open or accounts');
  if (values.dark && values.light) throw new UsageError('--dark and --light exclude each other');

  const themes = readThemes();
  const chosenThemes = values.themes ? list(values.themes) : themes.map((t) => t.id);
  for (const t of chosenThemes) if (!themes.some((x) => x.id === t)) throw new UsageError(`unknown theme "${t}" (known: ${themes.map((x) => x.id).join(', ')})`);
  const scheme = values.dark ? 'dark' : values.light ? 'light' : null;
  const finalThemes = chosenThemes.filter((t) => !scheme || themes.find((x) => x.id === t).scheme === scheme);
  if (!finalThemes.length) throw new UsageError(`no ${scheme} theme among ${chosenThemes.join(', ')}`);

  const available = statesFor(values.mode);
  const states = values.states ? list(values.states) : available;
  for (const s of states) {
    if (!(s in STATES)) throw new UsageError(`unknown state "${s}" (known: ${Object.keys(STATES).join(', ')})`);
    if (!available.includes(s)) throw new UsageError(`state "${s}" needs --mode ${STATE_MODES[s].join(' or ')}`);
  }

  const widths = values.widths ? list(values.widths) : DEFAULT_WIDTHS;
  for (const w of widths) if (!/^\d+$/.test(String(w)) || w < 200 || w > 4000) throw new UsageError(`bad width "${w}" (200 to 4000)`);

  return {
    id: values.id, mode: values.mode, states, widths: widths.map(Number), themes: finalThemes, noBuild: values['no-build'] === true,
    frameable: values.frameable === true, touch: values.touch === true, outDir: path.resolve(values.out, values.id),
  };
}

function ensureBuilt(noBuild) {
  const custom = process.env.DIST_DIR;
  const distDir = path.resolve(custom || path.join(root, 'dist'));
  const built = fs.existsSync(path.join(distDir, 'index.html'));
  if (custom) {
    if (!built) throw new Error(`DIST_DIR is set but ${distDir}/index.html does not exist`);
    return distDir;
  }
  if (noBuild && built) return distDir;
  console.log('building the app (npm run build:app)');
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:app', '--', '--mode', 'visual'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (run.status !== 0) throw new Error('npm run build:app failed');
  return distDir;
}

async function launchChromium() {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new UsageError('playwright is not installed. Run npm ci, then once: npx playwright install chromium', false);
  }
  try {
    // VISUAL_BROWSER=webkit or firefox runs the same states in another engine (cross-browser findings); the default is Chromium
    const engine = process.env.VISUAL_BROWSER ?? 'chromium';
    if (!['chromium', 'webkit', 'firefox'].includes(engine)) throw new UsageError(`VISUAL_BROWSER must be chromium, webkit or firefox, not ${engine}`, false);
    return await playwright[engine].launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  } catch (err) {
    if (/Executable doesn't exist/i.test(err.message)) throw new UsageError('Chromium for Playwright is not installed. Run once: npx playwright install chromium', false);
    throw err;
  }
}

async function main() {
  const options = readOptions();
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const started = Date.now();
  let browser = null;
  let relay = null;
  let closing = null;
  const cleanup = () => (closing ??= (async () => {
    await browser?.close().catch(() => undefined);
    if (relay) await stopRelay(relay);
  })());
  const interrupted = () => cleanup().finally(() => process.exit(130));
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  process.on('SIGHUP', interrupted);

  const results = [];
  try {
    browser = await launchChromium();
    const distDir = ensureBuilt(options.noBuild);
    fs.mkdirSync(options.outDir, { recursive: true });
    relay = newRelayHandle();
    const chat = options.mode === 'accounts' && options.states.some((s) => CHAT_STATES.has(s));
    const joinCodes = options.mode === 'accounts' && options.states.some((state) => ['join-short-code', 'share-code-phone'].includes(state));
    await startRelay(relay, { mode: options.mode, distDir, frameable: options.frameable, chat, joinCodes });
    const shared = { base: relay.base, mode: options.mode, outDir: options.outDir, session: null, dataDir: relay.dataDir, chat: null, touch: options.touch };
    if (options.mode === 'accounts') {
      const owner = await prepareAccounts(relay);
      shared.session = owner.session;
      if (chat) shared.chat = await seedChat(relay, owner.cookie);
    }
    for (const state of options.states) {
      for (const theme of options.themes) {
        for (const width of options.widths) {
          if (PHONE_ONLY_STATES.has(state) && width >= 600) continue;
          if (NARROW_STATES.has(state) && width >= 720) continue;
          results.push(await capture({ browser, state, theme, width, file: `${state}-${theme}-${width}.png`, shared }));
        }
      }
    }
  } finally {
    await cleanup();
  }

  const seconds = Math.round((Date.now() - started) / 100) / 10;
  writeIndex(options.outDir, { id: options.id, mode: options.mode, results, seconds });
  const failed = results.filter((r) => r.failed);
  const flagged = results.filter((r) => !r.failed && (r.overflow > 0 || r.errors.length));
  for (const r of failed) console.error(`failed: ${r.state} ${r.theme} ${r.width}: ${r.failed}`);
  for (const r of flagged) console.error(`check: ${r.state} ${r.theme} ${r.width}: ${r.overflow > 0 ? `${r.overflow}px wider than the window` : `${r.errors.length} script error(s): ${r.errors[0]}`}`);
  const where = path.relative(process.cwd(), options.outDir) || '.';
  console.log(`visual-check: ${results.length - failed.length} screenshot${results.length - failed.length === 1 ? '' : 's'}${failed.length ? `, ${failed.length} failed` : ''}${flagged.length ? `, ${flagged.length} to look at` : ''} in ${where} (${seconds}s), open ${path.join(where, 'index.html')}`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err instanceof UsageError) {
      console.error(err.showUsage ? `${err.message}\n\n${USAGE}` : err.message);
      process.exit(err.showUsage ? 2 : 1);
    }
    console.error(err);
    process.exit(1);
  },
);
