import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { markRead } from '../server/tracker/inbox.mjs';
import { setNotifyPrefs } from '../server/tracker/notify.mjs';
import { createTrackerNotifier, drainEmailOutbox, scanDueSoon, trackerTickMsFromTestEnv } from '../server/tracker/outbox.mjs';
import { noticeMail } from '../server/tracker/notice-mail.mjs';
import { createTicket, updateTicket } from '../server/tracker/tickets.mjs';

const opened: any[] = [];
const open = (): any => {
  const directory: any = openDirectory(':memory:');
  opened.push(directory);
  return directory;
};

function fixture() {
  const directory = open();
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
  const actor = { id: owner.id, role: owner.role, name: owner.name };
  return { directory, owner, actor };
}

function person(directory: any, name: string, role = 'member') {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  return directory.createUser({ email: `${slug}@example.com`, name, role });
}

function ticket(directory: any, actor: any, fields: Record<string, unknown> = {}) {
  return createTicket({ directory, actor, title: 'A ticket title', now: 100, ...fields });
}

function queued(directory: any, userId: string, ticketId: string, id: string, now = 1_000, kind = 'assigned') {
  directory.db.prepare(
    `INSERT INTO notifications
      (id, user_id, ticket_id, event_id, kind, dedupe_key, created_at, next_email_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(id, userId, ticketId, kind, `dedupe-${id}`, now, now);
}

function captureMailer() {
  const sent: any[] = [];
  return { sent, mailer: { send: async (message: any) => { sent.push(message); } } };
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker notification email outbox', () => {
  it('allows only a test environment to shorten the notifier interval', () => {
    expect(trackerTickMsFromTestEnv({ NODE_ENV: 'test', TABULA_TRACKER_TICK_MS: '1000' })).toBe(1000);
    expect(trackerTickMsFromTestEnv({ NODE_ENV: 'test' })).toBe(60_000);
    expect(() => trackerTickMsFromTestEnv({ NODE_ENV: 'production', TABULA_TRACKER_TICK_MS: '1000' })).toThrow(/only available/u);
    expect(() => trackerTickMsFromTestEnv({ NODE_ENV: 'test', TABULA_TRACKER_TICK_MS: '60001' })).toThrow(/integer between/u);
  });

  it('uses the frozen subject lines and bounds flattened email text', () => {
    const expected = new Map([
      ['assigned', 'TAB-12 was assigned to you'],
      ['mentioned', 'You were mentioned on TAB-12'],
      ['commented', 'New comment on TAB-12'],
      ['status_changed', 'TAB-12 changed status'],
      ['due_soon', 'TAB-12 is due soon'],
      ['relation_changed', 'TAB-12 has a new relation'],
      ['integration_activity', 'New activity on TAB-12'],
    ]);
    for (const [kind, subject] of expected) {
      expect(noticeMail({ kind, key: 'TAB-12', title: 'Ticket', actor: null, preview: null, link: 'https://tabula.example/t/TAB-12' }).subject).toBe(subject);
    }
    const mail = noticeMail({
      kind: 'mentioned', key: 'TAB-12', title: `Title\n${'x'.repeat(205)}`, actor: 'A'.repeat(100),
      preview: `Preview\n${'p'.repeat(150)}`, link: 'https://tabula.example/t/TAB-12',
    });
    expect(mail.text).toContain(`${'A'.repeat(80)} mentioned you on TAB-12:`);
    expect(mail.text).toContain(`"${'Preview '}${'p'.repeat(132)}"`);
    expect(mail.text).not.toContain('\r');
  });

  it('sends only due, unread both-preference rows with the ticket-notice template', async () => {
    const { directory, owner, actor } = fixture();
    const recipient = person(directory, 'Rita Recipient');
    const appOnly = person(directory, 'App Only');
    const future = person(directory, 'Future Notice');
    setNotifyPrefs(directory, appOnly.id, { assigned: 'app' });
    const assigned = ticket(directory, actor, { assignee: recipient.name });
    const readTicket = ticket(directory, actor, { assignee: recipient.name });
    const appTicket = ticket(directory, actor, { assignee: appOnly.name });
    const futureTicket = ticket(directory, actor, { assignee: future.name });
    const readRow = directory.db.prepare('SELECT id FROM notifications WHERE ticket_id = ? AND user_id = ?').get(readTicket.id, recipient.id);
    directory.db.prepare('UPDATE notifications SET read_at = 1 WHERE id = ?').run(readRow.id);
    const appRow = directory.db.prepare('SELECT id FROM notifications WHERE ticket_id = ? AND user_id = ?').get(appTicket.id, appOnly.id);
    directory.db.prepare('UPDATE notifications SET next_email_at = 120100 WHERE id = ?').run(appRow.id);
    const futureRow = directory.db.prepare('SELECT id FROM notifications WHERE ticket_id = ? AND user_id = ?').get(futureTicket.id, future.id);
    directory.db.prepare('UPDATE notifications SET next_email_at = 200000 WHERE id = ?').run(futureRow.id);
    const { mailer, sent } = captureMailer();

    const result = await drainEmailOutbox({ directory, mailer, baseUrl: 'https://tabula.example///', now: () => 120100 });
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: recipient.email,
      subject: `${assigned.key} was assigned to you`,
      template: 'ticket-notice',
      params: {
        link: `https://tabula.example/t/${assigned.key}`,
        kind: 'assigned',
        key: assigned.key,
        title: 'A ticket title',
        actor: owner.name,
        preview: null,
      },
    });
    expect(sent[0].text).toContain(`${owner.name} assigned ${assigned.key} to you: A ticket title.`);
    expect(sent[0].text).toContain('You get this email because ticket notifications are turned on for your account.');
    expect(directory.db.prepare('SELECT emailed_at, next_email_at FROM notifications WHERE ticket_id = ? AND user_id = ?').get(assigned.id, recipient.id))
      .toEqual({ emailed_at: 120100, next_email_at: null });
    expect(directory.db.prepare('SELECT next_email_at FROM notifications WHERE id = ?').get(appRow.id).next_email_at).toBeNull();
    expect(directory.db.prepare('SELECT next_email_at FROM notifications WHERE id = ?').get(futureRow.id).next_email_at).toBe(200000);
  });

  it('clears queued work after a preference changes from both to app', async () => {
    const { directory, actor } = fixture();
    const recipient = person(directory, 'Preference Change');
    const assigned = ticket(directory, actor, { assignee: recipient.name });
    setNotifyPrefs(directory, recipient.id, { assigned: 'app' });
    const row = directory.db.prepare('SELECT id FROM notifications WHERE ticket_id = ? AND user_id = ?').get(assigned.id, recipient.id);
    const { mailer, sent } = captureMailer();
    expect(await drainEmailOutbox({ directory, mailer, baseUrl: 'https://tabula.example', now: () => 120100 })).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(sent).toEqual([]);
    expect(directory.db.prepare('SELECT next_email_at FROM notifications WHERE id = ?').get(row.id).next_email_at).toBeNull();
  });

  it('suppresses queued mail when the recipient loses ticket access', async () => {
    const { directory, actor } = fixture();
    const guest = person(directory, 'Board Guest', 'guest');
    const target = ticket(directory, actor);
    queued(directory, guest.id, target.id, 'lost-access', 1000);
    const { mailer, sent } = captureMailer();
    const result = await drainEmailOutbox({ directory, mailer, baseUrl: 'https://tabula.example', now: () => 1000, boardAccess: () => null });
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(sent).toEqual([]);
    expect(directory.db.prepare('SELECT suppressed_at, next_email_at FROM notifications WHERE id = ?').get('lost-access'))
      .toEqual({ suppressed_at: 1000, next_email_at: null });
  });

  it('caps delivery at 20 emails per person in a rolling 24-hour window', async () => {
    const { directory, owner, actor } = fixture();
    const recipient = person(directory, 'Daily Limit');
    setNotifyPrefs(directory, recipient.id, { commented: 'both' });
    const target = ticket(directory, actor);
    for (let i = 0; i < 21; i++) queued(directory, recipient.id, target.id, `daily-${i}`, 10, 'commented');
    const { mailer, sent } = captureMailer();
    const result = await drainEmailOutbox({ directory, mailer, baseUrl: 'https://tabula.example', now: () => 1000, limit: 50 });
    expect(result).toEqual({ sent: 20, failed: 0, skipped: 1 });
    expect(sent).toHaveLength(20);
    expect(directory.db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND next_email_at IS NULL AND emailed_at IS NULL').get(recipient.id).count).toBe(1);
    expect(owner.id).not.toBe(recipient.id);
  });

  it('backs off failed mail with a code only and gives up after five failed attempts', async () => {
    const { directory, actor } = fixture();
    const recipient = person(directory, 'Retry Person');
    setNotifyPrefs(directory, recipient.id, { assigned: 'both' });
    const target = ticket(directory, actor);
    queued(directory, recipient.id, target.id, 'retry-row', 1_000);
    const mailer = { send: async () => { const error: any = new Error('smtp secret message'); error.code = 'ECONNRESET'; throw error; } };
    const now = [1_000, 61_000, 361_000, 2_161_000, 9_361_000];
    const next = [61_000, 361_000, 2_161_000, 9_361_000, null];
    for (let i = 0; i < now.length; i++) {
      const result = await drainEmailOutbox({ directory, mailer, baseUrl: 'https://tabula.example', now: () => now[i] });
      expect(result).toMatchObject({ sent: 0, failed: 1 });
      expect(directory.db.prepare('SELECT email_attempts, next_email_at, last_email_error_code FROM notifications WHERE id = ?').get('retry-row'))
        .toEqual({ email_attempts: i + 1, next_email_at: next[i], last_email_error_code: 'ECONNRESET' });
    }
    expect((await drainEmailOutbox({ directory, mailer, baseUrl: 'https://tabula.example', now: () => 99_999_999 })))
      .toEqual({ sent: 0, failed: 0, skipped: 0 });
  });

  it('guards concurrent drains for the same directory', async () => {
    const { directory, actor } = fixture();
    const recipient = person(directory, 'Concurrent Person');
    const target = ticket(directory, actor, { assignee: recipient.name });
    let startSend!: () => void;
    let releaseSend!: () => void;
    const started = new Promise<void>((resolve) => { startSend = resolve; });
    const wait = new Promise<void>((resolve) => { releaseSend = resolve; });
    let sends = 0;
    const mailer = { send: async () => { sends++; startSend(); await wait; } };
    const first = drainEmailOutbox({ directory, mailer, baseUrl: 'https://tabula.example', now: () => 120_100 });
    await started;
    const concurrent = await drainEmailOutbox({ directory, mailer, baseUrl: 'https://tabula.example', now: () => 120_100 });
    expect(concurrent).toEqual({ sent: 0, failed: 0, skipped: 1 });
    releaseSend();
    expect(await first).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(sends).toBe(1);
    expect(target.key).toBe('TAB-1');
  });

  it('scans the seven-day-to-tomorrow UTC due window once and honors status and preferences', () => {
    const { directory, actor } = fixture();
    const now = Date.parse('2026-10-10T12:00:00.000Z');
    const both = person(directory, 'Both Due');
    const app = person(directory, 'App Due');
    const off = person(directory, 'Off Due');
    setNotifyPrefs(directory, app.id, { due_soon: 'app' });
    setNotifyPrefs(directory, off.id, { due_soon: 'off' });
    const dates = [
      ticket(directory, actor, { title: 'Lower bound', assignee: both.name, due: '2026-10-03' }),
      ticket(directory, actor, { title: 'Tomorrow', assignee: app.name, due: '2026-10-11' }),
      ticket(directory, actor, { title: 'Off preference', assignee: off.name, due: '2026-10-10' }),
      ticket(directory, actor, { title: 'Too late', assignee: both.name, due: '2026-10-12' }),
      ticket(directory, actor, { title: 'Too old', assignee: both.name, due: '2026-10-02' }),
      ticket(directory, actor, { title: 'Completed', assignee: both.name, due: '2026-10-10', state: 'Done' }),
      ticket(directory, actor, { title: 'Canceled', assignee: both.name, due: '2026-10-10', state: 'Cancelled' }),
      ticket(directory, actor, { title: 'Archived', assignee: both.name, due: '2026-10-10' }),
    ];
    updateTicket({ directory, actor, key: dates[7].key, patch: { archived: true }, now: 200 });

    expect(scanDueSoon({ directory, now })).toBe(2);
    expect(scanDueSoon({ directory, now })).toBe(0);
    const bothNotice = directory.db.prepare('SELECT next_email_at FROM notifications WHERE ticket_id = ? AND kind = ?').get(dates[0].id, 'due_soon');
    const appNotice = directory.db.prepare('SELECT next_email_at FROM notifications WHERE ticket_id = ? AND kind = ?').get(dates[1].id, 'due_soon');
    expect(bothNotice).toEqual({ next_email_at: now });
    expect(appNotice).toEqual({ next_email_at: null });
    expect(dates.slice(3).every((item: any) => !directory.db.prepare('SELECT 1 FROM notifications WHERE ticket_id = ? AND kind = ?').get(item.id, 'due_soon'))).toBe(true);
  });

  it('limits each due scan to 500 tickets and reaches the rest on the next scan', () => {
    const { directory, owner } = fixture();
    const now = Date.parse('2026-10-10T12:00:00.000Z');
    const assignee = person(directory, 'Large Due Scan');
    const insert = directory.db.prepare(
      `INSERT INTO tickets
        (id, prefix, number, key, title, state_id, tracker_id, priority, assignee_user_id, due_date, created_at, updated_at, created_by_type, created_by_id, updated_seq, source)
       VALUES (?, 'TAB', ?, ?, 'Due ticket', 'st_todo', 'trk_default', 0, ?, '2026-10-10', 1, 1, 'user', ?, 0, 'test')`,
    );
    for (let i = 1; i <= 501; i++) insert.run(`due-bound-${i}`, i, `TAB-${i}`, assignee.id, owner.id);
    expect(scanDueSoon({ directory, now })).toBe(500);
    expect(scanDueSoon({ directory, now })).toBe(1);
    expect(directory.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE kind = 'due_soon'").get().count).toBe(501);
  });

  it('runs the due-soon scan and outbox through tick with timers disabled, and respects a read before send', async () => {
    const { directory, actor } = fixture();
    const recipient = person(directory, 'Wake Person');
    const now = Date.parse('2026-10-10T12:00:00.000Z');
    setNotifyPrefs(directory, recipient.id, { assigned: 'app' });
    const due = ticket(directory, actor, { assignee: recipient.name, due: '2026-10-10' });
    const { mailer, sent } = captureMailer();
    const notifier = createTrackerNotifier({ directory, mailer, baseUrl: 'https://tabula.example', now: () => now, timers: false });
    notifier.start();
    const result = await notifier.tick();
    expect(result).toEqual({ created: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sent[0].params).toMatchObject({ kind: 'due_soon', key: due.key, link: `https://tabula.example/t/${due.key}` });
    notifier.stop();

    const other = person(directory, 'Read Before Send');
    const otherTicket = ticket(directory, actor, { assignee: other.name });
    const row = directory.db.prepare('SELECT id FROM notifications WHERE ticket_id = ? AND user_id = ?').get(otherTicket.id, other.id);
    markRead({ directory, user: other, ids: [row.id as string], now });
    const before = sent.length;
    expect(await drainEmailOutbox({ directory, mailer, baseUrl: 'https://tabula.example', now: () => now + 120_000 })).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(sent).toHaveLength(before);
  });
});
