// Mention notices (docs/chat.md, Mentions). A person who is mentioned gets, in this order of preference:
//   - an in-app notice, when they have the app open but are not looking at that channel (the hub sends it to their tabs);
//   - nothing more, when a tab already shows the channel (the message is in front of them);
//   - an email, when they have no tab open at all and nobody has looked for ten minutes: once per channel per person, and
//     only if the mention is still there and unread then, they have not turned it off, and the limits allow it.
// Never the text of anything but the first 140 characters of the mentioning message, which is what the notice shows.

import { createWindow } from './chat-limits.mjs';

export const PREF_EMAIL_MENTIONS = 'chat.emailMentions';
export const SNIPPET_CHARS = 140;
export const MAIL_AFTER_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const WORKSPACE_NAME = 'Workspace';

/**
 * The relay tests shorten the ten minutes nobody must have looked before a mention email goes, with
 * TABULA_CHAT_MENTION_MAIL_AFTER_MS. Only under NODE_ENV=test: in production the setting would send mail to people who are
 * still reading, so it is ignored there.
 * @param {Record<string, string | undefined>} [env]
 */
export function mailAfterMsFromEnv(env = process.env) {
  return env.NODE_ENV === 'test' ? Number(env.TABULA_CHAT_MENTION_MAIL_AFTER_MS) || undefined : undefined;
}

/** Whether a person wants mention emails: on unless they turned it off. */
export const emailsMentions = (directory, userId) => directory.getPref(userId, PREF_EMAIL_MENTIONS) !== '0';

/**
 * The text of a message as a notice shows it: mention tokens as `@Name`, one line, cut at 140 characters.
 * @param {string} body
 * @param {(id: string) => string | null | undefined} nameOf
 */
export function snippetOf(body, nameOf) {
  const plain = String(body)
    .replace(/@\{([A-Za-z0-9_-]{1,64})\}/g, (_all, id) => `@${nameOf(id) ?? 'someone'}`)
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > SNIPPET_CHARS ? `${plain.slice(0, SNIPPET_CHARS - 1)}…` : plain;
}

/**
 * Where a notice or an email sends the person: the board, or the channel on the Chat page.
 * @param {string} baseUrl
 * @param {string} kind
 * @param {string} ref
 */
export const linkFor = (baseUrl, kind, ref) =>
  `${String(baseUrl).replace(/\/+$/, '')}/#/${kind === 'board' ? `b/${ref}` : `chat/${kind}/${ref}`}`;

/**
 * @param {object} deps
 * @param {any} deps.directory
 * @param {() => ReturnType<typeof import('./chat.mjs').openChat>} deps.store
 * @param {{ notice: Function, activeSince: Function } | null} deps.hub
 * @param {{ send(message: object): Promise<void> | void }} deps.mailer
 * @param {(user: any, kind: string, ref: string) => ({ read: boolean } | null)} deps.access
 * @param {string} deps.baseUrl the app's public address, for the link in the email
 * @param {(...args: unknown[]) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {number} [deps.mailAfterMs] how long nobody must have looked before the email goes (ten minutes)
 * @param {boolean} [deps.timers] false in tests: nothing is scheduled; call `flush()` to run what is due
 */
export function createChatNotifier({ directory, store, hub, mailer, access, baseUrl, log = () => {}, now = Date.now, mailAfterMs = MAIL_AFTER_MS, timers = true }) {
  /** @type {Map<string, { userId: string, kind: string, ref: string, messageId: number, at: number, due: number, timer: ReturnType<typeof setTimeout> | null }>} */
  const pending = new Map();
  /** Mails already sent for a message and person, so an edit never sends again. */
  const mailed = new Set();
  const perChannel = createWindow({ max: 1, windowMs: 10 * 60_000 }, now);
  const perDay = createWindow({ max: 20, windowMs: DAY_MS }, now);

  function channelName(kind, ref) {
    if (kind === 'board') return directory.getBoard(ref)?.title || 'an untitled board';
    if (kind === 'team') return directory.getTeam(ref)?.name ?? 'a team';
    return WORKSPACE_NAME;
  }

  const nameOf = (id) => directory.getUser(id)?.name ?? null;

  /**
   * People newly mentioned by a message: tell the ones with the app open, and queue an email for the ones without. `added`
   * are the ids this save introduced (all of them for a new message, the new ones for an edit).
   * @param {{ message: { id: number, kind: string, ref: string, authorId: string | null, authorName: string, body: string }, added: string[] }} event
   * @returns {{ notified: string[], queued: string[] }}
   */
  function mentioned({ message, added }) {
    const notified = [];
    const queued = [];
    const name = channelName(message.kind, message.ref);
    const from = { id: message.authorId, name: message.authorName };
    for (const userId of added) {
      if (userId === message.authorId) continue;
      const user = directory.getUser(userId);
      if (!user || user.disabled || !access(user, message.kind, message.ref)?.read) continue;
      const frame = {
        t: 'mention', kind: message.kind, ref: message.ref, id: message.id, from, channel: name, text: snippetOf(message.body, nameOf),
      };
      const state = hub ? hub.notice(userId, message.kind, message.ref, frame) : 'offline';
      if (state !== 'offline') {
        if (state === 'sent') notified.push(userId);
        continue;
      }
      if (queue(userId, message)) queued.push(userId);
    }
    return { notified, queued };
  }

  function queue(userId, message) {
    const key = `${userId}/${message.kind}/${message.ref}`;
    if (pending.has(key) || mailed.has(`${message.id}/${userId}`)) return false;
    if (!emailsMentions(directory, userId)) return false;
    const at = now();
    const entry = { userId, kind: message.kind, ref: message.ref, messageId: message.id, at, due: at + mailAfterMs, timer: null };
    if (timers) {
      entry.timer = setTimeout(() => void deliver(key), mailAfterMs);
      entry.timer.unref?.();
    }
    pending.set(key, entry);
    return true;
  }

  /** Sends the email for one queued mention if it still should go. Resolves to what happened, for tests and the log. */
  async function deliver(key) {
    const entry = pending.get(key);
    if (!entry) return 'gone';
    pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    const { userId, kind, ref, messageId } = entry;
    try {
      const user = directory.getUser(userId);
      if (!user || user.disabled || !user.email) return 'no-person';
      if (!emailsMentions(directory, userId)) return 'opted-out';
      if (hub?.activeSince(userId, entry.at)) return 'seen';
      if (!access(user, kind, ref)?.read) return 'no-access';
      const s = store();
      const message = s.getMessage(messageId);
      if (!message || message.deletedAt !== null || !message.mentions.includes(userId)) return 'withdrawn';
      if ((s.readMarker(userId, kind, ref) ?? 0) >= messageId) return 'read';
      if (perChannel.wait(key) || perDay.wait(userId)) return 'limited';
      perChannel.record(key);
      perDay.record(userId);
      mailed.add(`${messageId}/${userId}`);
      const channel = channelName(kind, ref);
      const sender = message.authorName || 'Someone';
      const text = snippetOf(message.body, nameOf);
      const link = linkFor(baseUrl, kind, ref);
      await mailer.send({
        to: user.email,
        template: 'chat-mention',
        params: { link, channel, sender, text },
        subject: `You were mentioned in ${channel}`,
        text: `${sender} mentioned you in ${channel}:\n\n${text}\n\nOpen the conversation: ${link}\n\nYou get this email because chat mentions are turned on for your account. You can turn them off under Notifications in the Tabula menu.\n`,
      });
      return 'sent';
    } catch (err) {
      log('chat: could not send a mention email:', err?.message ?? 'error');
      return 'failed';
    }
  }

  /** Runs every queued email whose time has come (all of them with `all`). For tests, which schedule nothing. */
  async function flush({ all = false } = {}) {
    const results = [];
    for (const [key, entry] of Array.from(pending)) {
      if (all || entry.due <= now()) results.push(await deliver(key));
    }
    return results;
  }

  /** Forgets a queued email (the mention was edited away or the message deleted). */
  function withdraw(messageId, userIds) {
    for (const [key, entry] of pending) {
      if (entry.messageId === messageId && userIds.includes(entry.userId)) {
        if (entry.timer) clearTimeout(entry.timer);
        pending.delete(key);
      }
    }
  }

  function stop() {
    for (const entry of pending.values()) if (entry.timer) clearTimeout(entry.timer);
    pending.clear();
  }

  return { mentioned, flush, withdraw, stop, size: () => pending.size };
}
