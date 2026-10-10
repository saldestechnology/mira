// The chat REST API (docs/chat.md, API), registered by api.mjs in accounts mode when TABULA_CHAT=on. Writes are
// ordinary API calls, so they get the CSRF header, the body limit, the session and the hosted read-only 402 from
// dispatch. Author, time and order come from the session and the server; a request body names only the text and
// what it points at. A channel the caller cannot read is a 404, never a 403.

import { CHAT_KINDS, WORKSPACE_REF } from './chat-access.mjs';
import { CHAT_SETTING_KEYS, REACTIONS, RETENTION_CHOICES, readChatSettings } from './chat.mjs';
import { PREF_EMAIL_MENTIONS, emailsMentions } from './chat-notify.mjs';
import { checkText, isClientId, isObjectId, MAX_TEXT, resolveMentions, textLength } from './chat-text.mjs';

export const CHAT_BODY_LIMIT = 16 * 1024;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const ID_RE = /^[1-9]\d{0,14}$/;
const SETTINGS_FIELDS = ['viewersMayPost', 'retentionDays', 'workspaceChannel'];
/** Boards show in the channel list while their chat has had a message this recently. */
export const RECENT_BOARD_MS = 14 * 24 * 60 * 60 * 1000;
const WORKSPACE_NAME = 'Workspace';
/** Erasing a person with a great many messages tells the people watching about this many; the rest show on the next load. */
const ERASE_FRAMES = 500;
const FORMER_MEMBER = 'Former member';

const TEXT_ERRORS = {
  empty: 'A message needs at least one character that is not a space',
  too_long: 'A message can be at most 2000 characters',
  too_many_mentions: 'A message can mention at most 10 people',
};

/**
 * @param {object} deps
 * @param {any} deps.directory
 * @param {() => ReturnType<typeof import('./chat.mjs').openChat>} deps.store the chat database, opened on first use
 * @param {(user: any, kind: unknown, ref: unknown) => import('./chat-access.mjs').ChatAccess | null} deps.access
 * @param {{ publish: Function, read: Function } | null} deps.hub
 * @param {ReturnType<typeof import('./chat-limits.mjs').createChatLimits>} deps.limits
 * @param {Function} deps.compile
 * @param {Function} deps.audit
 * @param {Function} deps.requireAdmin
 * @param {ReturnType<typeof import('./chat-notify.mjs').createChatNotifier> | null} [deps.notifier] mention notices and emails
 * @param {(name: string, payload?: object) => void} [deps.emit] the API's event emitter (access-changed after a setting)
 * @param {{ HttpError: any, badRequest: Function, forbidden: Function, notFound: Function, conflict: Function }} deps.errors
 */
export function createChatRoutes({ directory, store, access, hub, limits, compile, audit, requireAdmin, notifier = null, emit = () => {}, errors }) {
  const { HttpError, badRequest, forbidden, notFound, conflict } = errors;
  const hidden = () => notFound('Channel not found');

  /** The channel named in a URL, or 404. */
  function channelFor(user, kind, ref) {
    if (!CHAT_KINDS.includes(kind)) throw hidden();
    const can = access(user, kind, ref);
    if (!can?.read) throw hidden();
    return can;
  }

  /** A message by the id in a URL, with the caller's access to its channel; 404 when either is missing. */
  function messageFor(user, rawId) {
    const message = ID_RE.test(rawId) ? store().getMessage(Number(rawId)) : null;
    const can = message ? access(user, message.kind, message.ref) : null;
    if (!message || !can?.read) throw notFound('Message not found');
    return { message, can };
  }

  // dispatch answers 402 before a handler runs; the check here covers a switch that flipped while the body arrived
  const requireWrite = (can) => {
    if (can.write) return;
    if (can.readOnly) throw new HttpError(402, 'read_only', 'This workspace is read-only. Ask the workspace owner to check billing.');
    if (can.role === 'viewer') throw new HttpError(403, 'read_only_viewer', 'Viewers cannot post in this chat');
    throw forbidden('You cannot post in this chat');
  };

  function limited(res, wait) {
    res.setHeader('retry-after', String(wait));
    const err = new HttpError(429, 'rate_limited', 'Slow down a moment');
    err.extra = { retryAfter: wait };
    return err;
  }

  /** Normalised text with its mentions resolved for this channel, or the 400 that says why not. */
  function textFor(value, kind, ref) {
    const checked = checkText(value);
    if ('error' in checked) throw new HttpError(400, checked.error, TEXT_ERRORS[checked.error]);
    const mayRead = (userId) => access(directory.getUser(userId), kind, ref)?.read === true;
    const resolved = resolveMentions(checked.text, mayRead);
    if ('error' in resolved) throw new HttpError(400, resolved.error, TEXT_ERRORS[resolved.error]);
    // `@{a}` becomes the longer `@someone` when that person cannot read the channel; the limit is on what is stored
    if (textLength(resolved.text) > MAX_TEXT) throw new HttpError(400, 'too_long', TEXT_ERRORS.too_long);
    return resolved;
  }

  /** A message as the API and the socket show it: live names, no text once deleted. */
  function viewer() {
    const names = new Map();
    const nameOf = (id) => {
      if (!names.has(id)) names.set(id, directory.getUser(id)?.name ?? null);
      return names.get(id);
    };
    return (m) => {
      const deleted = m.deletedAt !== null;
      const authorName = m.authorId ? (nameOf(m.authorId) ?? m.authorName) : (m.authorName || FORMER_MEMBER);
      return {
        id: m.id,
        kind: m.kind,
        ref: m.ref,
        authorId: m.authorId,
        authorName,
        clientId: m.clientId,
        text: deleted ? '' : m.body,
        replyTo: m.replyTo,
        objectId: m.objectId,
        mentions: deleted ? [] : m.mentions.map((id) => ({ id, name: nameOf(id) })),
        reactions: deleted ? [] : m.reactions.map((r) => ({ emoji: r.emoji, userIds: r.userIds })),
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        deleted,
        deletedBy: deleted ? (m.deletedBy !== null && m.deletedBy === m.authorId ? 'author' : 'moderator') : null,
      };
    };
  }
  const view = (m) => viewer()(m);

  const publish = (kind, ref, frame, options) => {
    try {
      hub?.publish(kind, ref, frame, options);
    } catch (err) {
      console.error('chat: could not deliver an event:', err?.code ?? err?.message ?? 'error');
    }
  };

  /** In-app notices and queued emails for the people a message mentions; a failure never fails the send. */
  function notifyMentions(message, added) {
    if (!notifier || added.length === 0) return;
    try {
      notifier.mentioned({ message, added });
    } catch (err) {
      console.error('chat: could not notify mentioned people:', err?.code ?? err?.message ?? 'error');
    }
  }

  /** One reaction switched on or off on a message the caller can write in; the answer is the message's reactions. */
  function react(res, user, params, on) {
    const { message, can } = messageFor(user, params.id);
    if (!REACTIONS.includes(params.emoji)) throw badRequest('not a reaction');
    if (message.deletedAt !== null) throw conflict('deleted', 'This message was deleted');
    requireWrite(can);
    const wait = limits.react(user.id);
    if (wait) throw limited(res, wait);
    const result = store().setReaction(message.id, user.id, params.emoji, on);
    if (!result) throw conflict('deleted', 'This message was deleted');
    const reactions = result.reactions.map((r) => ({ emoji: r.emoji, userIds: r.userIds }));
    if (result.changed) publish(message.kind, message.ref, { t: 'reaction', kind: message.kind, ref: message.ref, id: message.id, emoji: params.emoji, userId: user.id, on, reactions });
    return reactions;
  }

  function parseLimit(raw) {
    if (raw === null || raw === '') return PAGE_DEFAULT;
    if (!/^\d{1,4}$/.test(raw)) throw badRequest('limit must be a whole number');
    return Math.min(Math.max(Number(raw), 1), PAGE_MAX);
  }

  return [
    // The channel's metadata for the interface (docs/chat.md, Mentions): what the caller may do in it, and the people
    // who can read it (the `@` list). Names only, never email; a hidden channel is the same 404 as everywhere else.
    // Counted before the access check, so asking about channels one cannot read is slowed down the same way; a 429 says
    // nothing about any channel.
    compile('GET', 'chat/:kind/:ref', {}, ({ res, user, params }) => {
      const { kind, ref } = params;
      const wait = limits.channelInfo(user.id);
      if (wait) throw limited(res, wait);
      const can = channelFor(user, kind, ref);
      const people = directory
        .listUsers()
        .filter((u) => !u.disabled && access(u, kind, ref)?.read === true)
        .map((u) => ({ id: u.id, name: u.name }));
      return [200, {
        kind,
        ref,
        access: { write: can.write, moderate: can.moderate, role: can.role, readOnly: can.readOnly },
        people,
      }];
    }),

    compile('GET', 'chat/:kind/:ref/messages', {}, ({ res, user, params, query }) => {
      const wait = limits.history(user.id);
      if (wait) throw limited(res, wait);
      channelFor(user, params.kind, params.ref);
      const before = query.get('before');
      if (before !== null && before !== '' && !ID_RE.test(before)) throw badRequest('before must be a message id');
      const page = store().listMessages(params.kind, params.ref, { before: before ? Number(before) : null, limit: parseLimit(query.get('limit')) });
      const show = viewer();
      return [200, { messages: page.messages.map(show), next: page.next }];
    }),

    compile('POST', 'chat/:kind/:ref/messages', { body: true, maxBody: CHAT_BODY_LIMIT }, ({ res, user, params, body }) => {
      const { kind, ref } = params;
      const can = channelFor(user, kind, ref);
      if (!isClientId(body.clientId)) throw badRequest('clientId must be 8 to 64 letters, digits, - or _');
      // A retried send answers with what was stored the first time, whatever else changed since.
      const stored = store().findByClientId(kind, ref, user.id, body.clientId);
      if (stored) return [200, { message: view(stored) }];
      requireWrite(can);
      const { text, mentions } = textFor(body.text, kind, ref);
      let replyTo = null;
      if (body.replyTo !== undefined && body.replyTo !== null) {
        const target = Number.isSafeInteger(body.replyTo) && body.replyTo > 0 ? store().getMessage(body.replyTo) : null;
        if (!target || target.kind !== kind || target.ref !== ref) throw badRequest('replyTo must be a message in this channel');
        replyTo = target.id;
      }
      let objectId = null;
      if (body.objectId !== undefined && body.objectId !== null) {
        if (kind !== 'board' || !isObjectId(body.objectId)) throw badRequest('objectId must be the id of an object on this board');
        objectId = body.objectId;
      }
      // Counted once the request is known to be good, so a refused one never adds to the wait.
      const wait = limits.post(user.id, `${kind}/${ref}`);
      if (wait) throw limited(res, wait);
      const { message, created } = store().insertMessage({
        kind, ref, authorId: user.id, authorName: user.name, body: text, replyTo, objectId, clientId: body.clientId, mentions,
      });
      const shown = view(message);
      if (created) {
        publish(kind, ref, { t: 'message', kind, ref, message: shown }, { authorId: user.id });
        notifyMentions(message, message.mentions);
      }
      return [created ? 201 : 200, { message: shown }];
    }),

    compile('PATCH', 'chat/messages/:id', { body: true, maxBody: CHAT_BODY_LIMIT }, ({ res, user, params, body }) => {
      const { message, can } = messageFor(user, params.id);
      if (message.authorId !== user.id) throw new HttpError(403, 'not_author', 'Only the author can edit a message');
      if (message.deletedAt !== null) throw conflict('deleted', 'This message was deleted');
      requireWrite(can);
      const { text, mentions } = textFor(body.text, message.kind, message.ref);
      if (text === message.body) return [200, { message: view(message) }];
      const wait = limits.change(user.id);
      if (wait) throw limited(res, wait);
      const edited = store().editMessage(message.id, text, mentions);
      const shown = view(edited);
      // a mention added by the edit notifies; one taken away withdraws a mail still waiting; nothing already sent is sent again
      notifyMentions(edited, edited.mentions.filter((id) => !message.mentions.includes(id)));
      notifier?.withdraw(message.id, message.mentions.filter((id) => !edited.mentions.includes(id)));
      publish(message.kind, message.ref, { t: 'edit', kind: message.kind, ref: message.ref, message: shown }, { authorId: user.id });
      return [200, { message: shown }];
    }),

    compile('DELETE', 'chat/messages/:id', {}, ({ res, user, params }) => {
      const { message, can } = messageFor(user, params.id);
      const own = message.authorId === user.id;
      if (!own && !can.moderate) throw forbidden('Only the author or a moderator can delete a message');
      if (message.deletedAt !== null) return [204];
      const wait = limits.change(user.id);
      if (wait) throw limited(res, wait);
      store().deleteMessage(message.id, user.id);
      notifier?.withdraw(message.id, message.mentions);
      // A moderator's delete is on the record; an author removing their own words is not. Ids only, never text.
      if (!own) audit(user, 'chat.delete', { kind: message.kind, ref: message.ref, messageId: message.id, authorId: message.authorId });
      const by = own ? 'author' : 'moderator';
      publish(message.kind, message.ref, { t: 'delete', kind: message.kind, ref: message.ref, id: message.id, by }, { authorId: message.authorId });
      return [204];
    }),

    compile('PUT', 'chat/messages/:id/reactions/:emoji', {}, ({ res, user, params }) => [200, { id: Number(params.id), reactions: react(res, user, params, true) }]),
    compile('DELETE', 'chat/messages/:id/reactions/:emoji', {}, ({ res, user, params }) => [200, { id: Number(params.id), reactions: react(res, user, params, false) }]),

    // The person's own chat preferences. Their own state, not workspace content, so they work while the workspace is read-only.
    compile('GET', 'me/prefs', {}, ({ user }) => [200, { emailMentions: emailsMentions(directory, user.id) }]),
    compile('PUT', 'me/prefs', { body: true, readOnlyOk: true }, ({ user, body }) => {
      for (const key of Object.keys(body)) if (key !== 'emailMentions') throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
      if (typeof body.emailMentions !== 'boolean') throw badRequest('emailMentions must be a boolean');
      directory.setPref(user.id, PREF_EMAIL_MENTIONS, body.emailMentions ? '1' : '0');
      return [200, { emailMentions: body.emailMentions }];
    }),

    // A read marker is the person's own state, not workspace content, so it works while the workspace is read-only.
    compile('PUT', 'chat/:kind/:ref/read', { body: true, readOnlyOk: true }, ({ res, user, params, body }) => {
      const { kind, ref } = params;
      const wait = limits.read(user.id);
      if (wait) throw limited(res, wait);
      channelFor(user, kind, ref);
      if (!Number.isSafeInteger(body.lastId) || body.lastId < 0) throw badRequest('lastId must be a message id');
      const lastId = store().markRead(user.id, kind, ref, body.lastId);
      try {
        hub?.read(user.id, kind, ref, lastId);
      } catch (err) {
        console.error('chat: could not mirror a read marker:', err?.code ?? err?.message ?? 'error');
      }
      return [200, { kind, ref, lastId }];
    }),

    compile('GET', 'chat/unread', {}, ({ res, user }) => {
      const wait = limits.unread(user.id);
      if (wait) throw limited(res, wait);
      return [200, { channels: unreadSummary({ directory, store, user, access }) }];
    }),

    // The channels this person can talk in, for the Chat page (docs/chat.md, API): the workspace channel, their teams (and,
    // for workspace owners and admins, the others), and boards whose chat has had a message in the last 14 days, each with
    // its unread counts and when it last had a message. Names only; nothing in it the person could not already read.
    compile('GET', 'chat/channels', {}, ({ res, user }) => {
      const wait = limits.unread(user.id);
      if (wait) throw limited(res, wait);
      return [200, { channels: channelList({ directory, store, access, user }) }];
    }),

    // A right-to-erasure request (docs/chat.md, Removing and erasing people): every message the person wrote is wiped, in every
    // channel. People who are subscribed see them turn into tombstones at once. Only counts and ids go in the audit row.
    compile('POST', 'admin/members/:id/chat-erase', {}, ({ user, params }) => {
      requireAdmin(user);
      const target = directory.getUser(params.id);
      if (!target) throw notFound('Member not found');
      if (target.role === 'owner' && user.role !== 'owner') throw forbidden('Only an owner can erase an owner’s messages');
      const { messages, count } = store().eraseAuthor(target.id, user.id);
      audit(user, 'chat.erase', { userId: target.id, count });
      for (const m of messages.slice(0, ERASE_FRAMES)) publish(m.kind, m.ref, { t: 'delete', kind: m.kind, ref: m.ref, id: m.id, by: 'moderator' });
      return [200, { removed: count }];
    }),

    // A copy of what one person wrote, as a file, for the administrator who answers their request. Not their reading, only their words.
    compile('GET', 'admin/members/:id/chat-export', {}, ({ res, user, params }) => {
      requireAdmin(user);
      const target = directory.getUser(params.id);
      if (!target) throw notFound('Member not found');
      const { messages, reactions } = store().exportAuthor(target.id);
      audit(user, 'chat.export', { userId: target.id, count: messages.length });
      res.setHeader('content-disposition', 'attachment; filename="chat-messages.json"');
      return [200, {
        format: 'tabula-chat-export', exportedAt: new Date().toISOString(), person: { id: target.id, name: target.name, email: target.email },
        note: 'Everything this person wrote in chat. Deleted messages are listed without text. Backups may still hold earlier copies until they expire.',
        messages, reactions,
      }];
    }),

    compile('GET', 'admin/chat', {}, ({ user }) => {
      requireAdmin(user);
      return [200, readChatSettings(directory)];
    }),
    compile('PUT', 'admin/chat', { body: true }, ({ user, body }) => {
      requireAdmin(user);
      for (const key of Object.keys(body)) {
        if (!SETTINGS_FIELDS.includes(key)) throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
      }
      const patch = {};
      if (body.viewersMayPost !== undefined) {
        if (typeof body.viewersMayPost !== 'boolean') throw badRequest('viewersMayPost must be a boolean');
        patch.viewersMayPost = body.viewersMayPost;
      }
      if (body.retentionDays !== undefined) {
        if (!RETENTION_CHOICES.includes(body.retentionDays)) throw badRequest('retentionDays must be 365, 90, 30 or null (forever)');
        patch.retentionDays = body.retentionDays;
      }
      if (body.workspaceChannel !== undefined) {
        if (typeof body.workspaceChannel !== 'boolean') throw badRequest('workspaceChannel must be a boolean');
        patch.workspaceChannel = body.workspaceChannel;
      }
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      directory.transaction(() => {
        if (patch.viewersMayPost !== undefined) directory.setSetting(CHAT_SETTING_KEYS.viewersMayPost, patch.viewersMayPost ? '1' : '0');
        if (patch.retentionDays !== undefined) directory.setSetting(CHAT_SETTING_KEYS.retentionDays, patch.retentionDays ?? 'forever');
        if (patch.workspaceChannel !== undefined) directory.setSetting(CHAT_SETTING_KEYS.workspaceChannel, patch.workspaceChannel ? '1' : '0');
        audit(user, 'chat.settings', patch);
      });
      // switching the workspace channel off or on changes who may read it: sockets look again
      if (patch.workspaceChannel !== undefined) emit('access-changed', {});
      return [200, readChatSettings(directory)];
    }),
  ];
}

/** The channels of a person that can have unread messages: board chats they can read, their teams, the workspace channel. */
function readableChannels({ directory, access, user }) {
  const out = directory.listBoardsFor(user).map((b) => ({ kind: 'board', ref: b.id }));
  for (const team of directory.listTeamsFor(user.id)) out.push({ kind: 'team', ref: team.id });
  if (access?.(user, 'workspace', WORKSPACE_REF)?.read) out.push({ kind: 'workspace', ref: WORKSPACE_REF });
  return out;
}

/** The unread summary of a person: channels they can read with something unread. Shared with the hub. */
export function unreadSummary({ directory, store, user, access = null }) {
  const byKind = new Map();
  for (const { kind, ref } of readableChannels({ directory, access, user })) {
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(ref);
  }
  const out = [];
  for (const [kind, refs] of byKind) out.push(...store().unreadSummary(user.id, kind, refs));
  return out;
}

/**
 * What the Chat page lists (GET /api/chat/channels). `member` is false for a team a workspace owner or admin may read
 * without belonging to it. Boards appear only while their chat is recent, so the list stays short.
 */
export function channelList({ directory, store, access, user, now = Date.now() }) {
  const s = store();
  const channels = [];
  const add = (kind, ref, extra) => {
    const can = access(user, kind, ref);
    if (!can?.read) return;
    const state = s.channelUnread(user.id, kind, ref);
    channels.push({ kind, ref, ...extra, write: can.write, unread: state.unread, mentions: state.mentions, lastId: state.lastId });
  };
  const teamActivity = s.activity('team');
  const workspaceActivity = s.activity('workspace');
  if (access(user, 'workspace', WORKSPACE_REF)?.read) {
    add('workspace', WORKSPACE_REF, { name: WORKSPACE_NAME, lastAt: workspaceActivity.get(WORKSPACE_REF)?.lastAt ?? null });
  }
  const mine = new Set();
  for (const team of directory.listTeamsFor(user.id)) {
    mine.add(team.id);
    add('team', team.id, { name: team.name, archived: team.archived, member: true, lastAt: teamActivity.get(team.id)?.lastAt ?? null });
  }
  if (user.role === 'owner' || user.role === 'admin') {
    for (const team of directory.listAllTeams(user.id)) {
      if (mine.has(team.id)) continue;
      add('team', team.id, { name: team.name, archived: team.archived, member: false, lastAt: teamActivity.get(team.id)?.lastAt ?? null });
    }
  }
  const recent = s.activity('board', now - RECENT_BOARD_MS);
  for (const board of directory.listBoardsFor(user)) {
    const a = recent.get(board.id);
    if (a) add('board', board.id, { name: board.title || 'Untitled board', lastAt: a.lastAt });
  }
  return channels;
}
