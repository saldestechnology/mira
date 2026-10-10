// Re-creates the screenshots in docs/images (README and user guide) from the built app, in headless Chromium, with
// fixed demo data and no shared browser. It starts throwaway relays (open, accounts and chat modes) in temporary
// data folders and stops them at the end. Usage and notes: docs/visual-check.md ("Docs images").
//   npm run docs:images                      all images, into docs/images
//   npm run docs:images -- --only share-roles,signin --out /tmp/shots
//   npm run docs:images -- --only admin-backups,chat-tray,kanban-card-dialog,layers-panel
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openDirectory } from '../server/directory.mjs';
import { openChat } from '../server/chat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_EMAIL = 'maya@example.test';
const ANA_EMAIL = 'ana@example.test';
const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const SCALE = 2;
const OPEN_USER = { id: 'docs-user', name: 'Lena Lund', color: '#D64545' };
const ANA_USER = { name: 'Ana', color: '#E8743B' };
const CHAT_OWNER = 'docs-chat-owner';
const CHAT_REVIEWER = 'docs-chat-reviewer';

const { values: opts } = parseArgs({ options: { only: { type: 'string' }, out: { type: 'string' }, 'no-build': { type: 'boolean' } } });
const outDir = path.resolve(opts.out ?? path.join(root, 'docs', 'images'));
const only = opts.only ? new Set(opts.only.split(',')) : null;

// ---------------------------------------------------------------- relays

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function startRelay(mode, distDir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `tabula-docs-${mode}-`));
  if (mode === 'chat') {
    // Avatar colours come from user IDs. Seed fixed, synthetic identities before this isolated relay starts.
    const file = path.join(dataDir, 'directory.sqlite');
    const directory = openDirectory(file);
    try {
      // The browser clock is fixed, while relay maintenance uses real time: never expire these demo messages.
      directory.setSetting('chat.retentionDays', 'forever');
    } finally {
      directory.close();
    }
    const db = new DatabaseSync(file);
    try {
      const insert = db.prepare('INSERT INTO users (id, email, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)');
      insert.run(CHAT_OWNER, OWNER_EMAIL, 'Maya', 'owner', NOW);
      insert.run(CHAT_REVIEWER, ANA_EMAIL, 'Ana', 'member', NOW);
    } finally {
      db.close();
    }
  }
  // Let the OS assign each screenshot relay a port so concurrent runs cannot claim the same fixed port.
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // nothing from the caller's shell may reach the relay
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA_|MIRA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(k)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: distDir, QUIET: '1' });
  if (mode === 'accounts' || mode === 'chat') Object.assign(env, { TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: OWNER_EMAIL, TABULA_BASE_URL: base });
  if (mode === 'chat') env.TABULA_CHAT = 'on';
  let stderr = '';
  const child = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], { cwd: dataDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (c) => (stderr += String(c)));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the ${mode} relay stopped at start:\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`the ${mode} relay did not answer in 20 seconds`);
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  return { base, dataDir, child };
}

async function stopRelay(relay) {
  if (!relay) return;
  const { child } = relay;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(relay.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ---------------------------------------------------------------- accounts data

async function api(base, who, method, route, body) {
  const headers = { 'content-type': 'application/json', 'x-tabula': '1', origin: base, ...(who ? { cookie: who.cookie } : {}) };
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${text}`);
  return { json: text ? JSON.parse(text) : null, res };
}

async function signIn(relay, email, invite) {
  const outbox = path.join(relay.dataDir, 'outbox.jsonl');
  const seen = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0;
  await api(relay.base, null, 'POST', '/api/auth/request', { email, ...(invite ? { invite } : {}) });
  let token = null;
  for (let i = 0; i < 100 && !token; i++) {
    const rows = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).slice(seen) : [];
    const row = rows.map((r) => JSON.parse(r)).find((r) => JSON.stringify(r).includes(email));
    token = row && /token=([A-Za-z0-9_-]+)/.exec(row.text)?.[1];
    if (!token) await sleep(100);
  }
  if (!token) throw new Error(`no sign-in mail for ${email}`);
  const { json, res } = await api(relay.base, null, 'POST', '/api/auth/verify', { token });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { cookie, user: json.user };
}

/** Maya owns the workspace, Ana is in the Design team. Fixed names, titles and roles. */
async function seedAccounts(relay) {
  const b = relay.base;
  const owner = await signIn(relay, OWNER_EMAIL);
  await api(b, owner, 'PATCH', '/api/me', { name: 'Maya' });
  const design = (await api(b, owner, 'POST', '/api/teams', { name: 'Design' })).json;
  const invite = (await api(b, owner, 'POST', `/api/teams/${design.id}/invites`, { role: 'member', days: 7 })).json;
  const ana = await signIn(relay, ANA_EMAIL, invite.token);
  await api(b, ana, 'PATCH', '/api/me', { name: ANA_USER.name });
  const board = (id, title, extra = {}) => api(b, owner, 'POST', '/api/boards', { id, title, ...extra });
  const research = (await api(b, owner, 'POST', '/api/teams', { name: 'Research' })).json;
  const samInvite = (await api(b, owner, 'POST', `/api/teams/${research.id}/invites`, { role: 'member', days: 7 })).json;
  const sam = await signIn(relay, 'sam@example.test', samInvite.token);
  await api(b, sam, 'PATCH', '/api/me', { name: 'Sam' });
  await board('retro', 'Sprint retro', { teamId: design.id });
  await board('roadmap', 'Roadmap 2026', { teamId: design.id });
  await board('quarterly', 'Quarterly numbers');
  await api(b, owner, 'POST', '/api/boards/quarterly/shares', { principalType: 'user', principalId: ana.user.id, role: 'viewer' });
  await board('teamnote', 'Team board');
  await api(b, owner, 'POST', '/api/boards/teamnote/shares', { principalType: 'user', principalId: ana.user.id, role: 'editor' });
  await api(b, ana, 'POST', '/api/boards', { id: 'ana-ideas', title: 'Workshop ideas' });
  await api(b, owner, 'POST', '/api/boards/roadmap/shares', { principalType: 'team', principalId: design.id, role: 'editor' });
  await api(b, owner, 'POST', '/api/boards/roadmap/shares', { principalType: 'user', principalId: ana.user.id, role: 'commenter' });
  return { owner, ana, design };
}

/** Real chat storage and HTTP reads, with fixed times, IDs and synthetic participants for repeatable pixels. */
async function seedGuideChat(relay) {
  const owner = await signIn(relay, OWNER_EMAIL);
  await api(relay.base, owner, 'POST', '/api/boards', { id: 'docs-chat', title: 'Design review' });
  await api(relay.base, owner, 'POST', '/api/boards/docs-chat/shares', { principalType: 'user', principalId: CHAT_REVIEWER, role: 'editor' });
  const chat = openChat(path.join(relay.dataDir, 'chat.sqlite'));
  try {
    const say = (authorId, authorName, body, minutesAgo, extra = {}) => chat.insertMessage({
      kind: 'board', ref: 'docs-chat', authorId, authorName, body, clientId: `docs-chat-${minutesAgo}`,
      now: NOW - minutesAgo * 60_000, ...extra,
    }).message.id;
    const question = say(CHAT_REVIEWER, 'Ana', 'Can we review the launch plan today?', 12, { objectId: 'docs-chat-plan' });
    const reply = say(CHAT_OWNER, 'Maya', `Yes! @{${CHAT_REVIEWER}} the notes are ready.`, 10, { replyTo: question, mentions: [CHAT_REVIEWER] });
    chat.setReaction(reply, CHAT_REVIEWER, '👍', true);
    say(CHAT_REVIEWER, 'Ana', 'The checklist covers the last two actions.', 8, { objectId: 'docs-chat-checklist' });
    say(CHAT_OWNER, 'Maya', 'Looks good. Let’s share it with the team.', 6, { replyTo: reply });
  } finally {
    chat.close();
  }
  return { owner };
}

/** No real backup bucket or keys: only the list response is stubbed, matching the guide’s three states. */
const GUIDE_BACKUPS = {
  backups: [
    { name: '20260115T093000Z.json.enc', createdAt: NOW - 30 * 60_000, readable: true, files: 14, bytes: 4_823_552, keyId: 'a1b2c3d4', protected: true, protectedUntil: NOW + 7 * 86_400_000 },
    { name: '20260115T083000Z.json.enc', createdAt: NOW - 90 * 60_000, readable: false, error: 'unknown_key', protected: false, protectedUntil: null },
    { name: '20260114T100000Z.json.enc', createdAt: NOW - 86_400_000, readable: false, error: 'tamper', protected: false, protectedUntil: null },
  ],
  truncated: false,
  status: {
    lastSuccessAt: NOW - 30 * 60_000, lastFailureAt: null, lastFailureError: null, consecutiveFailures: 0,
    nextRunAt: NOW + 30 * 60_000, running: false, intervalMinutes: 60, keyId: 'a1b2c3d4', bytesStored: 18_874_368, objects: 52, manifests: 3,
  },
  restore: { inProgress: null, maintenance: false, last: null, protectedBackups: [], oldData: [] },
};

// ---------------------------------------------------------------- browser

const fontCache = new Map();
async function serveOutside(route) {
  const url = new URL(route.request().url());
  if (!url.hostname.endsWith('fontshare.com')) return route.abort();
  if (!fontCache.has(url.href)) {
    fontCache.set(url.href, route.fetch({ timeout: 8000 }).then(async (res) => ({
      status: res.status(),
      headers: Object.fromEntries(Object.entries(res.headers()).filter(([n]) => !/^(content-encoding|content-length|transfer-encoding)$/.test(n))),
      body: await res.body(),
    }), () => null));
  }
  const cached = await fontCache.get(url.href);
  return cached ? route.fulfill(cached) : route.abort();
}

/** A fresh context: fixed clock, locale, zone and theme, motion off, no service worker, outside hosts refused. */
async function newPage(browser, { base, width, height, theme = 'default', user, session, clock = NOW }) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: SCALE, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  await context.clock.setFixedTime(clock);
  await context.route((url) => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', serveOutside);
  await context.addInitScript(({ themeId, who }) => {
    try {
      localStorage.setItem('driftboard:theme', themeId);
      if (who) localStorage.setItem('driftboard:user', JSON.stringify(who));
    } catch {
      /* storage is not available in this frame */
    }
  }, { themeId: theme, who: user ?? null });
  if (session) {
    for (const pair of session.cookie.split('; ')) {
      const eq = pair.indexOf('=');
      await context.addCookies([{ name: pair.slice(0, eq), value: pair.slice(eq + 1), url: base, httpOnly: true, sameSite: 'Lax' }]);
    }
  }
  const page = await context.newPage();
  return { context, page };
}

async function openBoard(page, base, id) {
  await page.goto(`${base}/?debug#/b/${id}`);
  await page.waitForFunction(() => window.__board, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const provider = window.__board.conn.provider;
    return !provider || provider.synced;
  }, null, { timeout: 15_000 });
}

const park = (page) => page.mouse.move(2, 2);
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await sleep(250);
};

/** Fixed demo content. Positions in board units; the callers fit the view. */
const seeds = {
  layers: (app) => {
    const z = app.store.topZs(5);
    app.store.transact(() => {
      app.store.create({ id: 'docs-frame', type: 'frame', name: 'Sprint ideas', x: 0, y: 0, w: 480, h: 260, rotation: 0, z: z[0], fill: '#FFFFFF' });
      app.store.create({ id: 'docs-frame-note-1', type: 'sticky', parent: 'docs-frame', text: 'Make onboarding simpler', x: 24, y: 40, w: 192, h: 192, rotation: 0, z: z[1], fill: '#FFE16B', fontSize: 18 });
      app.store.create({ id: 'docs-frame-note-2', type: 'sticky', parent: 'docs-frame', text: 'Share a weekly update', x: 248, y: 40, w: 192, h: 192, rotation: 0, z: z[2], fill: '#8FE3CA', fontSize: 18 });
      app.store.create({ id: 'docs-layer-box', type: 'shape', kind: 'rect', name: 'Next steps', text: 'Next steps', x: 80, y: 320, w: 160, h: 64, rotation: 0, z: z[3], fill: '#FFFFFF', stroke: '#18212B', strokeWidth: 2 });
      app.store.create({ id: 'docs-layer-title', type: 'text', text: 'Team workshop', x: 0, y: -64, w: 320, h: 28, rotation: 0, z: z[4], fontSize: 24 });
    });
  },
  kanban: (app) => {
    const z = app.store.topZs(3);
    const base = { x: 0, y: 0, rotation: 0 };
    const card = { ...base, id: 'docs-card', type: 'card', parent: 'docs-lane', rank: 'a0@docs-lane', z: z[2], w: 264,
      text: 'Prepare the launch checklist', desc: 'Review the welcome screen and write a short guide for the team.\n\nShare the draft before Friday’s review.',
      ownerId: 'docs-reviewer', ownerName: 'Ana', due: '2026-01-22', labels: ['docs-label-design', 'docs-label-review'], fill: '#FFE16B' };
    card.h = window.__kanban.cardContentHeight(card, card.w);
    app.store.transact(() => {
      app.store.labels.set('docs-label-design', { id: 'docs-label-design', name: 'Design', color: 'blue', order: 0 });
      app.store.labels.set('docs-label-review', { id: 'docs-label-review', name: 'Review', color: 'violet', order: 1 });
      app.store.create({ ...base, id: 'docs-kanban', type: 'container', layout: 'kanban', name: 'Launch plan', z: z[0], w: 360, h: 500 });
      app.store.create({ ...base, id: 'docs-lane', type: 'lane', parent: 'docs-kanban', rank: 'a0@docs-kanban', name: 'To do', z: z[1], w: 280, h: 300 });
      app.store.create(card);
    });
  },
  chat: (app) => {
    const z = app.store.topZs(2);
    app.store.transact(() => {
      app.store.create({ id: 'docs-chat-plan', type: 'sticky', text: 'Launch plan', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: z[0], fill: '#FFE16B', fontSize: 18 });
      app.store.create({ id: 'docs-chat-checklist', type: 'sticky', text: 'Final checklist', x: 224, y: 0, w: 192, h: 192, rotation: 0, z: z[1], fill: '#8FE3CA', fontSize: 18 });
    });
  },
  // an ellipse with centred text and a plain rectangle next to it (quick actions, text options, lock badge)
  shapes: (app, { lockEllipse = false } = {}) => {
    const z = app.store.topZs(2);
    app.store.transact(() => {
      app.store.create({ id: 'docs-rect', type: 'shape', kind: 'rect', x: 0, y: 20, w: 144, h: 72, rotation: 0, z: z[0], fill: '#FFFFFF', stroke: '#18212B', strokeWidth: 2 });
      app.store.create({ id: 'docs-ellipse', type: 'shape', kind: 'ellipse', x: 216, y: 0, w: 144, h: 96, rotation: 0, z: z[1], fill: '#FFFFFF', stroke: '#18212B', strokeWidth: 2, text: 'Centred while typing', fontSize: 16, locked: lockEllipse || undefined });
    });
  },
  // a sticky, a connector to a white box and a line of text (theme shots)
  theme: (app) => {
    const z = app.store.topZs(4);
    app.store.transact(() => {
      app.store.create({ id: 'docs-note', type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: z[0], fill: '#FFE16B', text: 'Sprint goals', fontSize: 18 });
      app.store.create({ id: 'docs-box', type: 'shape', kind: 'rect', x: 240, y: 224, w: 120, h: 120, rotation: 0, z: z[1], fill: '#FFFFFF', stroke: '#18212B', strokeWidth: 2 });
      app.store.create({ id: 'docs-link', type: 'connector', z: z[2], from: { kind: 'bound', id: 'docs-note', anchor: 'right' }, to: { kind: 'bound', id: 'docs-box', anchor: 'top' }, route: 'elbow', startHead: 'none', endHead: 'arrow' });
      app.store.create({ id: 'docs-text', type: 'text', x: -120, y: 360, w: 320, h: 28, rotation: 0, z: z[3], text: 'Plain text on the canvas', fontSize: 18 });
    });
  },
};

/** Put the top-left of the objects' bounds at screen (sx, sy) at the given zoom, so the crop has room where it needs it. */
const placeAt = (page, ids, zoom, sx, sy) =>
  page.evaluate(({ list, z, x, y }) => {
    const app = window.__board;
    const b = app.r.contentBounds(list);
    app.r.setCamera({ zoom: z, x: b.x - x / z, y: b.y - y / z });
    app.setSelection([]);
  }, { list: ids, z: zoom, x: sx, y: sy });

const union = (...rects) => {
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
};
const pad = (r, n, vw, vh, minY = 0) => {
  const x = Math.max(0, r.x - n), y = Math.max(minY, r.y - n);
  return { x, y, width: Math.min(vw - x, r.width + 2 * n), height: Math.min(vh - y, r.height + 2 * n) };
};
const boxOf = async (locator) => {
  const r = await locator.boundingBox();
  if (!r) throw new Error('an element for the crop is not visible');
  return r;
};
/** The screen rectangle of a board object, from the renderer's own camera. */
const screenRect = (page, id) =>
  page.evaluate((oid) => {
    const app = window.__board;
    const o = app.store.get(oid);
    const s = app.r.size();
    const a = app.r.toScreen({ x: o.x, y: o.y });
    const b = app.r.toScreen({ x: o.x + o.w, y: o.y + o.h });
    return { x: a.x + s.left, y: a.y + s.top, width: b.x - a.x, height: b.y - a.y };
  }, id);

const save = (page, name, clip) => page.screenshot({ path: path.join(outDir, `${name}.png`), clip, animations: 'disabled', caret: 'hide' });

// ---------------------------------------------------------------- the images

/** The ellipse with its quick-action bar open, on an open-mode board. */
async function shapesBoard(browser, base, { width, height, lock = false, zoom = 1.25, at = [120, 200] }) {
  const { context, page } = await newPage(browser, { base, width, height, user: OPEN_USER });
  await openBoard(page, base, `docs-shapes-${Math.random().toString(36).slice(2, 8)}`);
  await page.evaluate(`(${seeds.shapes.toString()})(window.__board, { lockEllipse: ${lock} })`);
  await placeAt(page, ['docs-rect', 'docs-ellipse'], zoom, at[0], at[1]);
  return { context, page };
}

const SHOTS = {
  async 'quick-actions'({ browser, open }) {
    const W = 1100, H = 460;
    const { context, page } = await shapesBoard(browser, open.base, { width: W, height: H, at: [130, 240] });
    await page.evaluate(() => window.__board.setSelection(['docs-ellipse']));
    const bar = page.locator('.quickbar');
    await bar.waitFor();
    await park(page);
    await settle(page);
    await save(page, 'quick-actions', pad(union(await boxOf(bar), await screenRect(page, 'docs-rect')), 60, W, H, 70));
    await context.close();
  },

  async 'text-options'({ browser, open }) {
    const W = 1100, H = 640;
    const { context, page } = await shapesBoard(browser, open.base, { width: W, height: H, at: [120, 400] });
    await page.evaluate(() => window.__board.setSelection(['docs-ellipse']));
    await page.locator('.quickbar').getByRole('button', { name: 'Text', exact: true }).click();
    const pop = page.getByText('Text colour', { exact: true });
    await pop.waitFor();
    const panel = page.locator('.popover, .qb-pop, [role="dialog"]').filter({ has: pop }).last();
    await park(page);
    await settle(page);
    const parts = [await boxOf(page.locator('.quickbar')), await boxOf(panel), await screenRect(page, 'docs-rect')];
    await save(page, 'text-options', pad(union(...parts), 40, W, H, 70));
    await context.close();
  },

  async 'locked-badge'({ browser, open }) {
    const W = 900, H = 560;
    const { context, page } = await shapesBoard(browser, open.base, { width: W, height: H, lock: true, zoom: 1.5, at: [300, 220] });
    const r = await screenRect(page, 'docs-ellipse');
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(300);
    await settle(page);
    const rect = await screenRect(page, 'docs-rect');
    await save(page, 'locked-badge', pad(union(rect, r), 70, W, H));
    await context.close();
  },

  async 'shapes-panel'({ browser, open }) {
    const { context, page } = await newPage(browser, { base: open.base, width: 1300, height: 1500, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-shapes-panel');
    await page.getByRole('button', { name: 'Shapes', exact: true }).click();
    const drawer = page.locator('.drawer.show');
    await drawer.waitFor();
    await park(page);
    await settle(page);
    await drawer.screenshot({ path: path.join(outDir, 'shapes-panel.png'), animations: 'disabled' });
    await context.close();
  },

  async 'themes-menu-matrix'({ browser, open }) {
    const W = 1200, H = 1000;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, theme: 'matrix', user: OPEN_USER });
    await openBoard(page, open.base, 'docs-theme-menu');
    await page.evaluate(`(${seeds.theme.toString()})(window.__board)`);
    await placeAt(page, ['docs-note', 'docs-box', 'docs-text'], 1, 500, 220);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('.theme-item').first().waitFor();
    await park(page);
    await settle(page);
    await save(page, 'themes-menu-matrix', { x: 480, y: 0, width: W - 480, height: 930 });
    await context.close();
  },

  async 'theme-ayu'({ browser, open }) {
    const W = 1000, H = 700;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, theme: 'ayu', user: OPEN_USER });
    await openBoard(page, open.base, 'docs-theme-ayu');
    await page.evaluate(`(${seeds.theme.toString()})(window.__board)`);
    await placeAt(page, ['docs-note', 'docs-box', 'docs-text'], 1, 220, 150);
    await park(page);
    await settle(page);
    await save(page, 'theme-ayu', { x: 0, y: 56, width: 720, height: 520 });
    await context.close();
  },

  async 'business-model-canvas'({ browser, open }) {
    const { context, page } = await newPage(browser, { base: open.base, width: 1280, height: 800, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-template');
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await page.locator('.tpl-name', { hasText: 'Business Model Canvas' }).first().click();
    await page.getByText('Session ready').waitFor();
    await page.evaluate(() => window.__board.store.setMeta({ name: 'Strategy workshop' }));
    await page.waitForFunction(() => !document.querySelector('.toast.show'), null, { timeout: 12_000 });
    await sleep(500);
    await park(page);
    await settle(page);
    await save(page, 'template-business-model-canvas');
    await context.close();
  },

  async signin({ browser, acc }) {
    const { context, page } = await newPage(browser, { base: acc.base, width: 960, height: 560 });
    await page.goto(`${acc.base}/`);
    await page.getByRole('button', { name: 'Email me a link' }).waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await park(page);
    await settle(page);
    await save(page, 'signin');
    await context.close();
  },

  async 'teams-home'({ browser, acc, people }) {
    const { context, page } = await newPage(browser, { base: acc.base, width: 1000, height: 980, session: people.ana, clock: Date.now() + 6 * 60_000 });
    await page.goto(`${acc.base}/#/`);
    await page.getByText('Shared with you').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.board-row').length >= 5);
    await park(page);
    await settle(page);
    await save(page, 'teams-home');
    await context.close();
  },

  async 'access-removed'({ browser, acc, people }) {
    const W = 1000, H = 520;
    const { context, page } = await newPage(browser, {
      base: acc.base, width: W, height: H, session: people.ana,
      user: { id: 'docs-ana', name: ANA_USER.name, color: '#CE2C7D' },
    });
    await openBoard(page, acc.base, 'teamnote');
    await page.evaluate(() => {
      const app = window.__board;
      const [z] = app.store.topZs(1);
      app.store.transact(() => app.store.create({ id: 'docs-team-note', type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z, fill: '#FFE16B', text: 'Team board note', fontSize: 18 }));
      const b = app.r.contentBounds(['docs-team-note']);
      app.r.setCamera({ zoom: 0.8, x: b.x - 176 / 0.8, y: b.y - 140 / 0.8 });
    });
    await settle(page);
    await api(acc.base, people.owner, 'DELETE', `/api/boards/teamnote/shares/user/${people.ana.user.id}`);
    await page.getByText('Your access to this board was removed').waitFor({ timeout: 15_000 });
    await park(page);
    await settle(page);
    await save(page, 'access-removed', { x: 0, y: 0, width: W, height: 310 });
    await context.close();
  },

  async 'share-roles'({ browser, acc, people }) {
    const { context, page } = await newPage(browser, { base: acc.base, width: 900, height: 760, session: people.owner });
    await page.goto(`${acc.base}/#/b/roadmap`);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('People with access').first().waitFor();
    await dialog.locator('.share-people select').first().waitFor();
    const stableOrigin = 'http://127.0.0.1:12345';
    await dialog.getByRole('textbox', { name: 'Board link' }).evaluate((input, origin) => {
      if (!input.value.startsWith(location.origin)) throw new Error('the board link did not use the local screenshot origin');
      input.value = input.value.replace(location.origin, origin);
    }, stableOrigin);
    await dialog.locator('.modal-body .stack > p.muted.small').last().evaluate((line, origin) => {
      if (!line.textContent?.includes(location.origin)) throw new Error('the relay note did not use the local screenshot origin');
      line.textContent = line.textContent.replace(location.origin, origin);
    }, stableOrigin);
    await park(page);
    await settle(page);
    await dialog.screenshot({ path: path.join(outDir, 'share-roles.png'), animations: 'disabled' });
    await context.close();
  },

  async 'admin-backups'({ browser, acc, people }) {
    const W = 1280, H = 1100;
    const { context, page } = await newPage(browser, { base: acc.base, width: W, height: H, session: people.owner });
    await page.route('**/api/admin/backups', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(GUIDE_BACKUPS) }));
    await page.goto(`${acc.base}/#/admin/backups`);
    await page.waitForFunction(() => document.querySelectorAll('.backups-row').length === 3 && document.querySelectorAll('.backups-row.unreadable').length === 2);
    await page.getByText('Protected until 2026-01-22', { exact: true }).waitFor();
    await park(page);
    await settle(page);
    await save(page, 'admin-backups', pad(await boxOf(page.locator('.admin-panel')), 12, W, H));
    await context.close();
  },

  async 'chat-tray'({ browser, chat, chatPeople }) {
    const W = 1100, H = 760;
    const { context, page } = await newPage(browser, { base: chat.base, width: W, height: H, session: chatPeople.owner });
    await openBoard(page, chat.base, 'docs-chat');
    await page.evaluate(`(${seeds.chat.toString()})(window.__board)`);
    await placeAt(page, ['docs-chat-plan', 'docs-chat-checklist'], 0.8, 140, 220);
    await page.locator('.chat-toggle').click();
    const tray = page.locator('.side-tray.show[data-tab="chat"]');
    await tray.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.side-tray.show .chat-msg').length === 4);
    await tray.locator('.chat-quote').first().waitFor();
    await tray.locator('.chat-mention').waitFor();
    await tray.locator('.chat-reaction').waitFor();
    await tray.locator('.chat-object').first().waitFor();
    await park(page);
    await settle(page);
    await save(page, 'chat-tray', pad(await boxOf(tray), 12, W, H));
    await context.close();
  },

  async 'kanban-card-dialog'({ browser, open }) {
    const W = 1100, H = 900;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-kanban');
    await page.waitForFunction(() => window.__kanban);
    await page.evaluate(`(${seeds.kanban.toString()})(window.__board)`);
    await placeAt(page, ['docs-kanban'], 0.8, 320, 140);
    await page.evaluate(() => window.__board.openCardDialog('docs-card'));
    const dialog = page.getByRole('dialog', { name: 'Card in To do' });
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.k-labels .k-chip.on').length === 2);
    await page.evaluate(() => document.activeElement?.blur());
    await park(page);
    await settle(page);
    await save(page, 'kanban-card-dialog', pad(await boxOf(dialog), 20, W, H));
    await context.close();
  },

  async 'layers-panel'({ browser, open }) {
    const W = 1000, H = 560;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-layers');
    await page.evaluate(`(${seeds.layers.toString()})(window.__board)`);
    await placeAt(page, ['docs-frame', 'docs-layer-box', 'docs-layer-title'], 0.65, 440, 140);
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    const drawer = page.locator('.drawer.show');
    await drawer.locator('[data-id="docs-frame"][aria-expanded="true"]').waitFor();
    await drawer.locator('[data-id="docs-frame-note-1"][aria-level="2"]').waitFor();
    await drawer.locator('[data-id="docs-frame-note-2"][aria-level="2"]').waitFor();
    await park(page);
    await settle(page);
    const content = union(await boxOf(drawer.locator('.drawer-head')), await boxOf(drawer.locator('.layer-row').last()));
    await save(page, 'layers-panel', pad(content, 12, W, H));
    await context.close();
  },
};

// ---------------------------------------------------------------- main

async function launchChromium() {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('playwright is not installed. Run npm ci, then once: npx playwright install chromium');
  }
  try {
    return await playwright.chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  } catch (err) {
    if (/Executable doesn't exist/i.test(err.message)) throw new Error('Chromium for Playwright is not installed. Run once: npx playwright install chromium');
    throw err;
  }
}

async function main() {
  const names = Object.keys(SHOTS).filter((n) => !only || only.has(n));
  const unknown = [...(only ?? [])].filter((n) => !SHOTS[n]);
  if (unknown.length) throw new Error(`unknown image: ${unknown.join(', ')} (known: ${Object.keys(SHOTS).join(', ')})`);
  const distDir = path.join(root, 'dist');
  if (!opts['no-build'] || !fs.existsSync(path.join(distDir, 'index.html'))) {
    const { status } = (await import('node:child_process')).spawnSync('npm', ['run', 'build:app'], { cwd: root, stdio: 'inherit' });
    if (status !== 0) throw new Error('npm run build:app failed');
  }
  fs.mkdirSync(outDir, { recursive: true });
  let browser = null, open = null, acc = null, chat = null;
  const cleanup = async () => {
    await browser?.close().catch(() => undefined);
    await stopRelay(open);
    await stopRelay(acc);
    await stopRelay(chat);
  };
  const interrupted = () => cleanup().finally(() => process.exit(130));
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  process.on('SIGHUP', interrupted);
  const failed = [];
  try {
    browser = await launchChromium();
    open = await startRelay('open', distDir);
    const needsAccounts = names.some((n) => ['signin', 'teams-home', 'access-removed', 'share-roles', 'admin-backups'].includes(n));
    let people = null;
    if (needsAccounts) {
      acc = await startRelay('accounts', distDir);
      people = await seedAccounts(acc);
    }
    let chatPeople = null;
    if (names.includes('chat-tray')) {
      chat = await startRelay('chat', distDir);
      chatPeople = await seedGuideChat(chat);
    }
    for (const name of names) {
      try {
        await SHOTS[name]({ browser, open, acc, people, chat, chatPeople });
        console.log(`ok ${name}`);
      } catch (err) {
        failed.push(name);
        console.error(`failed ${name}: ${String(err.message).split('\n')[0]}`);
      }
    }
  } finally {
    await cleanup();
  }
  console.log(`docs-images: ${names.length - failed.length} of ${names.length} in ${path.relative(process.cwd(), outDir) || '.'}`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
