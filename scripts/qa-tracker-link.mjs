#!/usr/bin/env node
// Tracker slice 4 integration check (linked kanbans) in a throwaway accounts workspace with TABULA_TRACKER=on.
// Usage: node scripts/qa-tracker-link.mjs [--widths 1280,390] [--out <folder>]. Needs `npm run build:app`.
// (header reused from qa-tracker-dogfood.mjs)
//   node scripts/qa-tracker-dogfood.mjs            API stage only (sign in, create, edit, comment, feed, inbox when it exists)
//   node scripts/qa-tracker-dogfood.mjs --ui       also drives the UI in headless Chromium (needs `npm run build:app`)
//   --out <folder> keeps screenshots; --widths 1280,390 picks the UI widths.
// Exit 0 when every check passes, 1 on a failed check, 2 on bad usage. Selectors for the UI stage live in SEL below.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const options = { ui: false, widths: [1280, 390], out: null, stages: [] };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--ui') options.ui = true;
  else if (arg === '--widths') options.widths = String(process.argv[++i] ?? '').split(',').map(Number);
  else if (arg === '--stages') options.stages = String(process.argv[++i] ?? '').split(',');
  else if (arg === '--out') options.out = path.resolve(process.argv[++i] ?? '');
  else { console.error(`Usage: node scripts/qa-tracker-dogfood.mjs [--ui] [--widths 1280,390] [--stages shell,ticket,inbox] [--out <folder>]  (unknown: ${arg})`); process.exit(2); }
}
if (options.widths.some((w) => !Number.isInteger(w) || w < 320 || w > 7680)) { console.error('--widths needs whole numbers from 320 to 7680'); process.exit(2); }

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), skipped: false });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  return Boolean(ok);
}
function skip(name, why) {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}  -- ${why}`);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-tracker-dogfood-'));
let relay = null;
let relayErr = '';
let base = '';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRelay() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TABULA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(key)));
  Object.assign(env, {
    PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(root, 'dist'), QUIET: '1',
    TABULA_SKIP_DOTENV: '1', TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: 'olive@example.test',
    TABULA_BASE_URL: base, TABULA_TRACKER: 'on', TABULA_CHAT: 'on', TABULA_JOIN_CODES: 'on',
  });
  relay = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], { cwd: dataDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  relay.stderr.on('data', (chunk) => { relayErr = (relayErr + String(chunk)).slice(-4000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (relay.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) })).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error(`relay did not start${relayErr ? `: ${relayErr.slice(-800)}` : ''}`);
}

async function stopRelay() {
  if (relay && relay.exitCode === null) {
    const exited = new Promise((resolve) => relay.once('exit', resolve));
    relay.kill('SIGTERM');
    await Promise.race([exited, sleep(4000)]);
    if (relay.exitCode === null) relay.kill('SIGKILL');
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function call(who, method, route, body) {
  const headers = { accept: 'application/json', 'x-tabula': '1', origin: base, ...(who ? { cookie: who.cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  const init = { method, headers, signal: AbortSignal.timeout(10_000) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, headers: response.headers };
}

async function signIn(email, invite) {
  const outbox = path.join(dataDir, 'outbox.jsonl');
  const seen = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0;
  const asked = await call(null, 'POST', '/api/auth/request', { email, ...(invite ? { invite } : {}) });
  if (asked.status >= 400) throw new Error(`sign-in request for ${email} answered ${asked.status}`);
  let token = null;
  for (let i = 0; i < 100 && !token; i++) {
    const rows = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).slice(seen) : [];
    const row = rows.map((r) => JSON.parse(r)).find((r) => JSON.stringify(r).includes(email));
    token = row && /token=([A-Za-z0-9_-]+)/.exec(row.text)?.[1];
    if (!token) await sleep(100);
  }
  if (!token) throw new Error(`no sign-in mail for ${email}`);
  const verified = await call(null, 'POST', '/api/auth/verify', { token });
  const cookie = verified.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (verified.status !== 200 || !cookie) throw new Error(`sign-in for ${email} answered ${verified.status}`);
  return { cookie, user: verified.json.user, email };
}


/** Runs inside the page: a 3-lane kanban with 6 cards (2 per lane stage), stored as the app stores them. */
function seedLinkKanban({ id, count }) {
  const app = window.__board;
  const store = app.store;
  if (store.get(id)) return false;
  const body = store.getMeta().bodyFont;
  const heading = store.getMeta().headingFont;
  const z = store.topZ();
  const base = { rotation: 0, z, createdBy: 'qa-link', updatedAt: Date.now() };
  const lanes = [
    { id: `${id}-todo`, name: 'To do', stage: 'todo' },
    { id: `${id}-doing`, name: 'Doing', stage: 'doing' },
    { id: `${id}-done`, name: 'Done', stage: 'done' },
  ];
  const keys = ['a0', 'a1', 'a2', 'a3', 'a4'];
  const objs = [{ ...base, id, type: 'container', layout: 'kanban', name: `Board ${id}`, x: 0, y: 0, w: 1000, h: 500, font: heading }];
  lanes.forEach((l, i) => objs.push({ ...base, ...l, type: 'lane', parent: id, rank: `${keys[i]}@${id}`, x: 0, y: 0, w: 280, h: 200, font: body }));
  const per = [Math.ceil(count / 2), Math.floor(count / 4), count - Math.ceil(count / 2) - Math.floor(count / 4)];
  let n = 0;
  lanes.forEach((l, li) => {
    for (let i = 0; i < per[li]; i++) {
      n++;
      const rank = i < keys.length ? keys[i] : `b${String(i).padStart(5, '0')}`;
      const card = { ...base, id: `${id}-c${n}`, type: 'card', text: `Card ${n} of ${id}`, parent: l.id, rank: `${rank}@${l.id}`, x: 0, y: 0, w: 264, h: 0, font: body };
      card.h = window.__kanban.cardContentHeight(card, 264);
      objs.push(card);
    }
  });
  store.transact(() => objs.forEach((o) => store.create(o)));
  return true;
}

async function linkStage() {
  const olive = await signIn('olive@example.test');
  await call(olive, 'PATCH', '/api/me', { name: 'Olive Owner' });
  const team = (await call(olive, 'POST', '/api/teams', { name: 'Delivery' })).json;
  const invite = (await call(olive, 'POST', `/api/teams/${team.id}/invites`, { role: 'member', days: 1 })).json;
  const ana = await signIn('ana@example.test', invite.token);
  await call(ana, 'PATCH', '/api/me', { name: 'Ana Member' });
  const boardId = 'link-board';
  await call(olive, 'POST', '/api/boards', { id: boardId, title: 'Link board', teamId: team.id });
  // Ana is in the board's team, so she is an editor; Vic is in another team and has the board shared as a viewer.
  const team2 = (await call(olive, 'POST', '/api/teams', { name: 'Observers' })).json;
  const invite2 = (await call(olive, 'POST', `/api/teams/${team2.id}/invites`, { role: 'member', days: 1 })).json;
  const vic = await signIn('vic@example.test', invite2.token);
  await call(vic, 'PATCH', '/api/me', { name: 'Vic Viewer' });
  const shared = await call(olive, 'POST', `/api/boards/${boardId}/shares`, { principalType: 'user', principalId: vic.user.id, role: 'viewer' });
  check('the viewer was given view-only access to the board', shared.status < 300, `status ${shared.status}`);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const shot = async (page, name) => { if (options.out) { fs.mkdirSync(options.out, { recursive: true }); await page.screenshot({ path: path.join(options.out, `${name}.png`) }); } };
  const cookieList = (person) => person.cookie.split('; ').map((pair) => { const [name, ...rest] = pair.split('='); return { name, value: rest.join('='), url: base }; });
  try {
    for (const width of options.widths) {
      const tag = `${width}`;
      const kid = `k${width}`;
      const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 } });
      await context.addCookies(cookieList(olive));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${base}/?debug#/b/${boardId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__board && window.__kanban, null, { timeout: 20_000 });
      await page.waitForFunction(() => { const p = window.__board.conn.provider; return !p || p.synced; }, null, { timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(seedLinkKanban, { id: kid, count: 6 });
      await sleep(1500);
      await page.evaluate(() => window.__board.zoomToFit?.());

      // 1. suggestion
      const sug = await call(olive, 'GET', `/api/tracker/links/suggest?boardId=${boardId}&kanbanId=${kid}`);
      const laneMap = sug.json?.mapping ?? {};
      check(`${tag}: suggestion maps To do, Doing and Done lanes to todo, in_progress and done`, sug.status === 200 && laneMap[`${kid}-todo`] === 'todo' && laneMap[`${kid}-doing`] === 'in_progress' && laneMap[`${kid}-done`] === 'done' && sug.json?.cardCount === 6, `status ${sug.status} ${JSON.stringify(sug.json?.mapping)} cards ${sug.json?.cardCount}`);
      check(`${tag}: the suggestion lists the states with no lane`, Array.isArray(sug.json?.stateNotMapped) && sug.json.stateNotMapped.includes('in_review'), JSON.stringify(sug.json?.stateNotMapped));

      // 2. the dialog: mapping step and confirm
      await page.evaluate((id) => { const app = window.__board; app.setSelection([id]); }, kid);
      const hasLinkApi = await page.evaluate(() => typeof window.__board.linkTrackerKanban === 'function');
      check(`${tag}: the board has the link action wired (linkTrackerKanban)`, hasLinkApi);
      if (hasLinkApi) {
        await page.evaluate((id) => window.__board.linkTrackerKanban(id), kid);
        const dialog = page.locator('.trk-link-modal');
        const shown = await dialog.waitFor({ timeout: 10_000 }).then(() => true, () => false);
        check(`${tag}: the Link to tracker dialog opens`, shown);
        if (shown) {
          await shot(page, `link-dialog-step1-${tag}`);
          const lanesText = await page.locator('.trk-link-lanes').first().innerText().catch(() => '');
          check(`${tag}: step 1 lists the three lanes with a state each`, /To do/.test(lanesText) && /Doing/.test(lanesText) && /Done/.test(lanesText), lanesText.replace(/\s+/g, ' ').slice(0, 120));
          await dialog.getByRole('button', { name: 'Next' }).click();
          await sleep(300);
          const stepText = await dialog.innerText();
          check(`${tag}: the confirm step offers to create tickets for the 6 cards`, /6 existing cards|6 tickets/.test(stepText), stepText.replace(/\s+/g, ' ').slice(0, 160));
          await shot(page, `link-dialog-step2-${tag}`);
          await dialog.getByRole('button', { name: /^Link/ }).last().click();
          await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
        }
      }
      await sleep(1500);
      const links = await call(olive, 'GET', `/api/tracker/links?boardId=${boardId}&kanbanId=${kid}`);
      const link = links.json?.links?.[0];
      check(`${tag}: the board is linked with 6 cards carrying tickets`, Boolean(link) && link.cardCount === 6, `status ${links.status}, cardCount ${link?.cardCount}, pending ${link?.pendingProjections}`);
      const listed = (await call(olive, 'GET', '/api/tracker/tickets?limit=50')).json?.tickets ?? [];
      const mine = listed.filter((t) => /^Card \d of /.test(t.title) && t.title.endsWith(kid));
      check(`${tag}: six tickets were created in the mapped states`, mine.length === 6 && mine.every((t) => ['todo', 'in_progress', 'done'].includes(t.state?.key)), mine.map((t) => `${t.key}:${t.state?.key}`).join(' '));
      await shot(page, `board-linked-${tag}`);

      // chip on a linked card
      const chip = await page.evaluate(() => { const svg = document.querySelector('svg'); const text = svg ? svg.textContent : ''; return /TAB-\d+/.test(text); });
      check(`${tag}: a linked card shows its ticket key on the board`, chip, chip ? '' : 'no TAB-n text in the board drawing (markup.ts may not be wired yet)');

      // 3. ticket -> card
      const t0 = mine.find((t) => t.state?.key === 'todo');
      if (t0) {
        const cardId = await page.evaluate((key) => { for (const o of window.__board.store.cache.values()) if (o.type === 'card' && (o.extKey === key || o.ext?.key === key)) return o.id; return null; }, t0.key);
        const laneBefore = cardId ? await page.evaluate((id) => window.__board.store.get(id)?.parent, cardId) : null;
        await call(olive, 'POST', `/api/tracker/tickets/${t0.key}/transition`, { state: 'Done' });
        let laneAfter = laneBefore;
        for (let i = 0; i < 20 && laneAfter === laneBefore; i++) { await sleep(500); laneAfter = cardId ? await page.evaluate((id) => window.__board.store.get(id)?.parent, cardId) : null; }
        check(`${tag}: moving ticket ${t0.key} to Done moves its card to the Done lane`, Boolean(cardId) && laneAfter === `${kid}-done`, `card ${cardId}, lane ${laneBefore} -> ${laneAfter}`);
        // 4. card -> ticket (documented as not built in slice 4)
        const t1 = mine.find((t) => t.state?.key === 'todo' && t.key !== t0.key);
        const card1 = t1 ? await page.evaluate((key) => { for (const o of window.__board.store.cache.values()) if (o.type === 'card' && (o.extKey === key || o.ext?.key === key)) return o.id; return null; }, t1.key) : null;
        if (card1) {
          await page.evaluate(({ id, lane }) => { const app = window.__board; app.store.transact(() => app.store.update(id, { parent: lane, rank: 'z9@' + lane })); }, { id: card1, lane: `${kid}-doing` });
          await sleep(2500);
          const after = (await call(olive, 'GET', `/api/tracker/tickets/${t1.key}`)).json?.ticket?.state?.key;
          console.log(`INFO  ${tag}: moving a card to Doing changed ticket ${t1.key} to "${after}" (slice 4 is one-way: board to ticket sync is documented as not built)`);
          results.push({ name: `${tag}: card move to ticket state (one-way slice, informational)`, ok: true, skipped: true });
        }
      }

      // 8. forged ext fields get repaired
      const forgeId = await page.evaluate((id) => { for (const o of window.__board.store.cache.values()) if (o.type === 'card' && o.parent && String(o.parent).startsWith(id) && o.extKey) return o.id; return null; }, kid);
      if (forgeId) {
        const real = await page.evaluate((id) => window.__board.store.get(id).extKey, forgeId);
        await page.evaluate((id) => { const app = window.__board; app.store.transact(() => app.store.update(id, { extKey: 'TAB-9999', extUrl: 'https://evil.example/x' })); }, forgeId);
        let repaired = false;
        for (let i = 0; i < 12 && !repaired; i++) { await sleep(250); repaired = await page.evaluate(({ id, key }) => window.__board.store.get(id).extKey === key, { id: forgeId, key: real }); }
        check(`${tag}: a forged extKey on a linked card is repaired within 3 s`, repaired, `real ${real}`);
        const url = await page.evaluate((id) => window.__board.store.get(id).extUrl ?? '', forgeId);
        check(`${tag}: a forged extUrl is not left on the card`, !/evil\.example/.test(url), url);
      } else skip(`${tag}: forged ext fields`, 'no linked card found with extKey on the client');

      // 5. unlink: confirm dialog, then 404 on the second delete
      if (link) {
        const hasUnlink = await page.evaluate(() => typeof window.__board.unlinkTrackerKanban === 'function');
        if (hasUnlink) {
          await page.evaluate((id) => window.__board.unlinkTrackerKanban(id), kid);
          const confirmShown = await page.locator('.modal-actions button', { hasText: 'Unlink' }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
          check(`${tag}: Unlink asks for confirmation`, confirmShown);
          await shot(page, `unlink-confirm-${tag}`);
          if (confirmShown) await page.locator('.modal-actions button', { hasText: /^Unlink$/ }).first().click();
          await sleep(2000);
          const second = await call(olive, 'DELETE', `/api/tracker/links/${link.id}`);
          check(`${tag}: a second delete of the link is 404`, second.status === 404, `status ${second.status}`);
          const stripped = await page.evaluate((id) => { let n = 0; for (const o of window.__board.store.cache.values()) if (o.type === 'card' && String(o.parent ?? '').startsWith(id) && (o.extKey || o.extProvider)) n++; return n; }, kid);
          check(`${tag}: unlinking strips the ticket fields from the cards`, stripped === 0, `${stripped} cards still carry ext fields`);
          const keep = (await call(olive, 'GET', '/api/tracker/tickets?limit=50')).json?.tickets?.filter((t) => t.title.endsWith(kid)).length;
          check(`${tag}: the tickets are kept after unlinking`, keep === 6, `${keep} tickets`);
        } else skip(`${tag}: unlink`, 'unlinkTrackerKanban is not wired');
      }

      // 6. 500+ cards: 413
      const big = `big${width}`;
      await page.evaluate(seedLinkKanban, { id: big, count: 520 });
      await sleep(4000);
      const bigSug = await call(olive, 'GET', `/api/tracker/links/suggest?boardId=${boardId}&kanbanId=${big}`);
      const toLane = bigSug.json?.mapping ?? {};
      const bigLink = await call(olive, 'POST', '/api/tracker/links', { boardId, kanbanId: big, mapping: toLane, createTickets: true, idempotencyKey: `big-${tag}-create` });
      // 7. a read-only user cannot link (tested on a kanban that is not linked yet; the same request on a linked kanban shows the 409 first)
      const viewerLink = await call(vic, 'POST', '/api/tracker/links', { boardId, kanbanId: big, mapping: toLane, idempotencyKey: `viewer-${tag}-attempt` });
      check(`${tag}: a board viewer cannot link (API)`, viewerLink.status === 403 || viewerLink.status === 404, `status ${viewerLink.status}`);
      const viewerSuggest = await call(vic, 'GET', `/api/tracker/links/suggest?boardId=${boardId}&kanbanId=${big}`);
      console.log(`INFO  ${tag}: a viewer asking for a link suggestion gets status ${viewerSuggest.status}`);
      const viewerOnLinked = await call(vic, 'POST', '/api/tracker/links', { boardId, kanbanId: kid, mapping: {}, idempotencyKey: `viewer-${tag}-linked` });
      console.log(`INFO  ${tag}: a viewer posting a link on an already linked kanban gets status ${viewerOnLinked.status}`);
      const vctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 } });
      await vctx.addCookies(cookieList(vic));
      const vpage = await vctx.newPage();
      await vpage.goto(`${base}/?debug#/b/${boardId}`, { waitUntil: 'domcontentloaded' });
      await vpage.waitForFunction(() => window.__board && window.__kanban, null, { timeout: 20_000 });
      await sleep(1500);
      const viewerUi = await vpage.evaluate((id) => { const app = window.__board; return { readOnly: app.readOnly === true, hasKanban: Boolean(app.store.get(id)) }; }, big);
      check(`${tag}: the viewer's board is read-only (no kanban menu, so no Link to tracker)`, viewerUi.readOnly, JSON.stringify(viewerUi));
      await vctx.close();
      check(`${tag}: linking a 520 card board with tickets is refused with 413`, bigLink.status === 413 && bigLink.json?.error === 'limit_exceeded', `status ${bigLink.status} ${bigLink.json?.message ?? ''}`);
      const bigNo = await call(olive, 'POST', '/api/tracker/links', { boardId, kanbanId: big, mapping: toLane, createTickets: false, idempotencyKey: `big-${tag}-nocreate` });
      check(`${tag}: the same board links without creating tickets`, bigNo.status === 201, `status ${bigNo.status}`);
      check(`${tag}: no uncaught page errors`, errors.length === 0, errors[0] ?? '');
      await context.close();
    }
  } finally { await browser.close(); }
}

let exit = 1;
try {
  await startRelay();
  await linkStage();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${results.some((r) => r.skipped) ? ` (${results.filter((r) => r.skipped).length} skipped)` : ''}`);
  exit = failed.length ? 1 : 0;
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  exit = 1;
} finally {
  await stopRelay();
}
process.exit(exit);
