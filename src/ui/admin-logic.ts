import type { AdminOverview, AuditEntry, UserRole } from '../api';
import { errorReason, formatUtc, manifestTime } from './backups-logic';

/** Pure rules and text for the admin dashboard: no DOM, so they can be unit tested. */

export interface Verdict {
  allowed: boolean;
  reason?: string;
}

export interface Actor {
  id: string;
  role: UserRole;
}

export interface Target {
  id: string;
  role: UserRole;
  disabled: boolean;
}

export type Lookup = (kind: 'user' | 'team' | 'board', id: string) => string | undefined;

const ALLOWED: Verdict = { allowed: true };
const deny = (reason: string): Verdict => ({ allowed: false, reason });

const ROLES: UserRole[] = ['owner', 'admin', 'member', 'guest'];
const NOT_OWNER = 'Only an owner can act on an owner.';
const SELF_ROLE = 'You cannot change your own role.';
const SELF_DISABLE = 'You cannot disable your own account.';
const SELF_REMOVE = 'You cannot remove yourself.';
const GRANT_OWNER = 'Only an owner can make someone an owner.';
const LAST_ROLE = 'The last active owner cannot be demoted.';
const LAST_DISABLE = 'The last active owner cannot be disabled.';
const LAST_REMOVE = 'The last active owner cannot be removed.';

/** Active owners: a disabled owner does not count, as on the server. */
export function activeOwnerCount(members: { role: UserRole; disabled: boolean }[]): number {
  return members.filter((m) => m.role === 'owner' && !m.disabled).length;
}

/** The roles the select offers. Only an owner sees or grants owner, and an owner row shows only owner to anyone else. */
export function roleOptions(actor: Actor, target: Target): UserRole[] {
  if (target.role === 'owner' && actor.role !== 'owner') return ['owner'];
  return actor.role === 'owner' ? ROLES : ROLES.filter((r) => r !== 'owner');
}

/** Whether the role select can change this row at all. */
export function roleLock(actor: Actor, target: Target, activeOwners: number): Verdict {
  if (actor.id === target.id) return deny(SELF_ROLE);
  if (target.role === 'owner' && actor.role !== 'owner') return deny(NOT_OWNER);
  if (target.role === 'owner' && !target.disabled && activeOwners <= 1) return deny(LAST_ROLE);
  return ALLOWED;
}

export function roleVerdict(actor: Actor, target: Target, next: UserRole, activeOwners: number): Verdict {
  if (next === target.role) return ALLOWED;
  const lock = roleLock(actor, target, activeOwners);
  if (!lock.allowed) return lock;
  return next === 'owner' && actor.role !== 'owner' ? deny(GRANT_OWNER) : ALLOWED;
}

/** Disabling (`disabled: true`) or enabling (`false`). Enabling is never the last-owner problem. */
export function disableVerdict(actor: Actor, target: Target, disabled: boolean, activeOwners: number): Verdict {
  if (actor.id === target.id && disabled) return deny(SELF_DISABLE);
  if (target.role === 'owner' && actor.role !== 'owner') return deny(NOT_OWNER);
  if (disabled && target.role === 'owner' && !target.disabled && activeOwners <= 1) return deny(LAST_DISABLE);
  return ALLOWED;
}

export function removeVerdict(actor: Actor, target: Target, activeOwners: number): Verdict {
  if (actor.id === target.id) return deny(SELF_REMOVE);
  if (target.role !== 'owner') return ALLOWED;
  if (actor.role !== 'owner') return deny(NOT_OWNER);
  const othersActive = activeOwners - (target.disabled ? 0 : 1);
  return othersActive < 1 ? deny(LAST_REMOVE) : ALLOWED;
}

/** Sign out everywhere. Allowed on yourself; on another person it follows the owner rule. */
export function revokeVerdict(actor: Actor, target: Target): Verdict {
  if (actor.id === target.id) return ALLOWED;
  return target.role === 'owner' && actor.role !== 'owner' ? deny(NOT_OWNER) : ALLOWED;
}

export const KNOWN_AUDIT_ACTIONS = [
  'auth.login', 'auth.logout', 'auth.logout_all', 'me.update',
  'team.create', 'team.update', 'team.member.role', 'team.leave', 'team.member.remove',
  'invite.create', 'invite.revoke', 'invite.accept',
  'board.create', 'board.update', 'board.delete', 'board.restore', 'board.share', 'board.unshare',
  'board.version.create', 'board.version.rename', 'board.version.delete', 'board.version.restore',
  'template.create', 'template.update', 'template.delete',
  'member.update', 'member.remove',
  'admin.sessions.revoke', 'admin.session.revoke',
  'cloud.limits', 'cloud.notify',
  'updates.auto',
  'ai.settings', 'ai.key.set', 'ai.key.delete', 'ai.key.test',
  'ai.generate', 'ai.summarise', 'ai.cluster', 'ai.run.accept', 'ai.run.discard',
  'asset.upload', 'assets.gc',
  'chat.delete', 'chat.settings', 'chat.retention', 'chat.erase', 'chat.export',
  'backup.run', 'backup.failed', 'backup.list', 'backup.preview', 'backup.boards',
  'restore.started', 'restore.done', 'restore.failed', 'restore.old_data_removed',
  'volume.adopt',
  'mcp.token.create', 'mcp.token.revoke', 'mcp.token.revoke_all',
  'tracker.ticket.create', 'tracker.ticket.update', 'tracker.ticket.transition', 'tracker.ticket.comment',
  'tracker.ticket.subscribe', 'tracker.ticket.unsubscribe',
  'tracker.link.create', 'tracker.link.delete', 'tracker.link.card',
  'tracker.label.create', 'tracker.milestone.create', 'tracker.milestone.update', 'tracker.project.create', 'tracker.project.update', 'tracker.ticket.archive', 'tracker.ticket.bulk', 'tracker.ticket.comment.delete', 'tracker.ticket.comment.edit', 'tracker.ticket.relate', 'tracker.ticket.restore', 'tracker.ticket.unrelate', 'tracker.view.create', 'tracker.view.delete', 'tracker.view.update',
] as const;

export function isKnownAuditAction(action: string): boolean {
  return (KNOWN_AUDIT_ACTIONS as readonly string[]).includes(action);
}

/** Who did it. Audit rows carry no name for system rows or for deleted users. */
export function auditActor(entry: AuditEntry): string {
  return entry.actorEmail || entry.actorName || (entry.actorId === null ? 'System' : 'A deleted user');
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const quote = (s: string) => `“${s}”`;
const clip = (s: string, max: number) => ([...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s);

/**
 * One audit row as a sentence. Details hold ids, so names come from `lookup` when the caller has them.
 * Unknown actions read as their raw action string.
 */
export function auditSentence(entry: AuditEntry, lookup: Lookup = () => undefined): string {
  const d = entry.detail ?? {};
  const who = auditActor(entry);
  const named = (kind: 'user' | 'team' | 'board', id: unknown): string | undefined => {
    const key = text(id);
    return key ? lookup(kind, key) : undefined;
  };
  const teamLabelFor = (id: unknown) => {
    const name = named('team', id);
    return name ? quote(name) : 'a team';
  };
  const member = named('user', d.userId) ?? 'a member';
  const teamLabel = teamLabelFor(d.teamId);
  const boardName = named('board', d.boardId);
  const boardLabel = boardName ? quote(boardName) : 'a board';
  const role = text(d.role);

  switch (entry.action) {
    case 'auth.login':
      return `${who} signed in`;
    case 'auth.logout':
      return `${who} signed out`;
    case 'auth.logout_all':
      return `${who} signed out everywhere`;
    case 'me.update': {
      const name = text(d.name);
      return name ? `${who} changed their name to ${quote(name)}` : `${who} updated their profile`;
    }
    case 'team.create': {
      const name = text(d.name);
      return name ? `${who} created team ${quote(name)}` : `${who} created a team`;
    }
    case 'team.update': {
      if (flag(d.archived) === true) return `${who} archived ${teamLabel}`;
      if (flag(d.archived) === false) return `${who} unarchived ${teamLabel}`;
      const name = text(d.name);
      return name ? `${who} renamed ${teamLabel} to ${quote(name)}` : `${who} updated ${teamLabel}`;
    }
    case 'team.member.role':
      return `${who} changed ${member}’s role in ${teamLabel} to ${role ?? 'a new role'}`;
    case 'team.leave':
      return `${who} left ${teamLabel}`;
    case 'team.member.remove':
      return `${who} removed ${member} from ${teamLabel}`;
    case 'invite.create':
      return `${who} created an invite link for ${teamLabel} as ${role ?? 'a member'}`;
    case 'invite.revoke':
      return `${who} revoked an invite link for ${teamLabel}`;
    case 'invite.accept':
      return `${who} joined ${teamLabel} as ${role ?? 'a member'}`;
    case 'board.create': {
      const where = text(d.teamId) ? ` in ${teamLabel}` : '';
      return flag(d.adopted) === true
        ? `${who} added ${boardLabel} to the workspace${where}`
        : `${who} created ${boardLabel}${where}`;
    }
    case 'board.update': {
      const title = text(d.title);
      if (title) return `${who} renamed ${boardLabel} to ${quote(title)}`;
      if (d.teamId === null) return `${who} moved ${boardLabel} to personal`;
      if (text(d.teamId)) return `${who} moved ${boardLabel} to ${teamLabel}`;
      return `${who} updated ${boardLabel}`;
    }
    case 'board.delete':
      return `${who} deleted ${boardLabel}`;
    case 'board.restore':
      return `${who} restored ${boardLabel}`;
    case 'board.share': {
      const principal = d.principalType === 'team' ? teamLabelFor(d.principalId) : (named('user', d.principalId) ?? 'someone');
      return `${who} shared ${boardLabel} with ${principal} as ${role ?? 'a role'}`;
    }
    case 'board.unshare': {
      const principal = d.principalType === 'team' ? teamLabelFor(d.principalId) : (named('user', d.principalId) ?? 'someone');
      return `${who} removed ${principal} from ${boardLabel}`;
    }
    case 'board.version.create': {
      const label = text(d.label);
      return label ? `${who} saved the version ${quote(label)} of ${boardLabel}` : `${who} saved a version of ${boardLabel}`;
    }
    case 'board.version.rename': {
      const label = text(d.label);
      return label ? `${who} named a version of ${boardLabel} ${quote(label)}` : `${who} renamed a version of ${boardLabel}`;
    }
    case 'board.version.delete':
      return `${who} deleted a version of ${boardLabel}`;
    case 'board.version.restore':
      return `${who} restored a version of ${boardLabel}`;
    case 'template.create':
    case 'template.update':
    case 'template.delete': {
      const verb = { 'template.create': 'saved', 'template.update': 'changed', 'template.delete': 'deleted' }[entry.action];
      const name = text(d.name);
      const scope = d.scope === 'team' ? ` shared with ${teamLabel}` : d.scope === 'workspace' ? ' shared with the workspace' : '';
      return `${who} ${verb} the template${name ? ` ${quote(name)}` : ''}${scope}`;
    }
    case 'member.update': {
      if (role) return `${who} changed ${member} to ${role}`;
      if (flag(d.disabled) === true) return `${who} disabled ${member}`;
      if (flag(d.disabled) === false) return `${who} enabled ${member}`;
      return `${who} updated ${member}`;
    }
    case 'member.remove':
      return `${who} removed ${text(d.email) ?? member}`;
    case 'admin.sessions.revoke':
      return `${who} revoked all sessions of ${member}`;
    case 'admin.session.revoke':
      return `${who} revoked a session of ${member}`;
    case 'cloud.limits': {
      const limits: string[] = [];
      if (typeof d.seatLimit === 'number') limits.push(countLabel(d.seatLimit, 'seat', 'seats'));
      if (flag(d.readOnly) === true) limits.push('read-only');
      return `${who} updated the workspace limits${limits.length ? ` (${limits.join(', ')})` : ''}`;
    }
    case 'cloud.notify': {
      const count = typeof d.count === 'number' ? d.count : null;
      const notice = d.template === 'trial-ending' ? 'the trial-ending notice' : 'a notice';
      return `${who} sent ${notice} to ${count === null ? 'the workspace owners' : countLabel(count, 'workspace owner', 'workspace owners')}`;
    }
    case 'updates.auto':
      return `${who} turned automatic updates ${flag(d.to) === false ? 'off' : 'on'}`;
    case 'ai.settings': {
      const changes: string[] = [];
      if (flag(d.enabled) !== undefined) changes.push(d.enabled ? 'turned on' : 'turned off');
      if (text(d.model)) changes.push(`model ${text(d.model)}`);
      if (Array.isArray(d.features)) changes.push(countLabel(d.features.length, 'feature', 'features'));
      if (flag(d.personalKeys) !== undefined) changes.push(d.personalKeys ? 'personal keys allowed' : 'personal keys off');
      if (flag(d.membersOnly) !== undefined) changes.push(d.membersOnly ? 'members only' : 'guests allowed');
      if (d.limits !== undefined) changes.push('limits');
      return `${who} changed the AI settings${changes.length ? ` (${changes.join(', ')})` : ''}`;
    }
    case 'ai.key.set':
      return d.scope === 'user' ? `${who} added their own AI key` : `${who} set the workspace AI key`;
    case 'ai.key.delete':
      return d.scope === 'user' ? `${who} removed their own AI key` : `${who} removed the workspace AI key`;
    case 'ai.key.test': {
      const key = d.scope === 'user' ? 'their own AI key' : 'the workspace AI key';
      return `${who} tested ${key}${flag(d.ok) === false ? ' (did not work)' : ''}`;
    }
    case 'ai.generate':
    case 'ai.summarise':
    case 'ai.cluster': {
      const what = { 'ai.generate': 'generated stickies on', 'ai.summarise': 'summarised', 'ai.cluster': 'grouped stickies on' }[entry.action];
      const outcome = text(d.outcome);
      const notes: Record<string, string> = { ai_aborted: ' (cancelled)', ai_timeout: ' (timed out)', ai_refused: ' (declined by the AI)' };
      return `${who} ${what} ${boardLabel}${!outcome || outcome === 'ok' ? '' : (notes[outcome] ?? ' (failed)')}`;
    }
    case 'ai.run.accept':
      return `${who} added an AI proposal to ${boardLabel}`;
    case 'ai.run.discard':
      return `${who} discarded an AI proposal on ${boardLabel}`;
    // AI tool access (docs/mcp.md): the token's name is the person's own text, cut short; never its secret, which is not in the row
    case 'mcp.token.create': {
      const name = text(d.name);
      const scope = ({ read: ' (read only)', comment: ' (read and comment)', write: ' (read and edit)' } as Record<string, string>)[text(d.scope) ?? ''] ?? '';
      return `${who} created an AI tool access token${name ? ` ${quote(clip(name, 60))}` : ''}${scope}`;
    }
    // Tracker (docs/tracker-api.md): ids only in the row, never ticket text
    case 'tracker.ticket.create':
      return `${who} created a ticket`;
    case 'tracker.ticket.update':
      return `${who} changed a ticket`;
    case 'tracker.ticket.transition':
      return `${who} moved a ticket to another state`;
    case 'tracker.ticket.comment':
      return `${who} commented on a ticket`;
    case 'tracker.ticket.subscribe':
      return `${who} subscribed to a ticket`;
    case 'tracker.ticket.unsubscribe':
      return `${who} unsubscribed from a ticket`;
    case 'tracker.link.create':
      return `${who} linked a kanban to the tracker`;
    case 'tracker.link.delete':
      return `${who} unlinked a kanban from the tracker`;
    case 'tracker.link.card':
      return `${who} created a ticket from a kanban card`;
    case 'tracker.label.create':
      return `${who} created a ticket label`;
    case 'tracker.milestone.create':
      return `${who} created a milestone`;
    case 'tracker.milestone.update':
      return `${who} changed a milestone`;
    case 'tracker.project.create':
      return `${who} created a project`;
    case 'tracker.project.update':
      return `${who} changed a project`;
    case 'tracker.ticket.archive':
      return `${who} archived a ticket`;
    case 'tracker.ticket.bulk':
      return `${who} changed several tickets at once`;
    case 'tracker.ticket.comment.delete':
      return `${who} deleted a ticket comment`;
    case 'tracker.ticket.comment.edit':
      return `${who} edited a ticket comment`;
    case 'tracker.ticket.relate':
      return `${who} linked two tickets`;
    case 'tracker.ticket.restore':
      return `${who} restored a ticket`;
    case 'tracker.ticket.unrelate':
      return `${who} removed a link between two tickets`;
    case 'tracker.view.create':
      return `${who} saved a ticket view`;
    case 'tracker.view.delete':
      return `${who} deleted a saved ticket view`;
    case 'tracker.view.update':
      return `${who} changed a saved ticket view`;
    case 'mcp.token.revoke': {
      const name = text(d.name);
      const label = name ? ` ${quote(clip(name, 60))}` : '';
      return d.by === 'admin' ? `${who} revoked the AI tool access token${label} of ${member}` : `${who} revoked their AI tool access token${label}`;
    }
    case 'mcp.token.revoke_all': {
      const count = typeof d.count === 'number' ? d.count : null;
      return `${who} revoked all of their AI tool access tokens${count === null ? '' : ` (${count})`}`;
    }
    case 'asset.upload':
      return `${who} added an image to ${boardLabel}`;
    case 'assets.gc': {
      const rows = typeof d.rows === 'number' ? d.rows : 0;
      return `${who} removed ${rows} unused image${rows === 1 ? '' : 's'}`;
    }
    case 'chat.delete': {
      const author = named('user', d.authorId) ?? 'a former member';
      const chatBoard = d.kind === 'board' ? named('board', d.ref) : undefined;
      const where = d.kind === 'board' ? (chatBoard ? ` in ${quote(chatBoard)}` : ' in a board chat') : '';
      return `${who} removed a message by ${author}${where}`;
    }
    case 'chat.settings': {
      const changes: string[] = [];
      if (flag(d.viewersMayPost) !== undefined) changes.push(d.viewersMayPost ? 'viewers may post' : 'viewers read only');
      if (flag(d.workspaceChannel) !== undefined) changes.push(d.workspaceChannel ? 'workspace channel on' : 'workspace channel off');
      if (d.retentionDays === null) changes.push('keep messages forever');
      else if (typeof d.retentionDays === 'number') changes.push(`keep messages ${countLabel(d.retentionDays, 'day', 'days')}`);
      return `${who} changed the chat settings${changes.length ? ` (${changes.join(', ')})` : ''}`;
    }
    case 'chat.erase': {
      const count = typeof d.count === 'number' ? d.count : 0;
      return `${who} erased the chat messages of ${member} (${count === 1 ? '1 message' : `${count} messages`})`;
    }
    case 'chat.export':
      return `${who} exported the chat messages of ${member}`;
    case 'chat.retention': {
      const removed = typeof d.removed === 'number' ? d.removed : 0;
      const days = typeof d.days === 'number' ? ` older than ${countLabel(d.days, 'day', 'days')}` : '';
      return `${removed === 1 ? '1 chat message' : `${removed} chat messages`}${days} ${removed === 1 ? 'was' : 'were'} removed by the retention setting`;
    }
    case 'backup.run': {
      const files = typeof d.files === 'number' ? d.files : null;
      const uploaded = typeof d.uploaded === 'number' ? d.uploaded : null;
      const repaired = typeof d.repaired === 'number' && d.repaired > 0 ? d.repaired : null;
      const detail = [files === null ? null : countLabel(files, 'file', 'files'), uploaded === null ? null : `${uploaded} new`, repaired === null ? null : `${repaired} repaired`].filter(Boolean).join(', ');
      return `${who} backed up the workspace${detail ? ` (${detail})` : ''}`;
    }
    case 'backup.failed': {
      const reason = text(d.error);
      return `A backup failed${reason ? `: ${reason.length > 120 ? `${reason.slice(0, 119)}…` : reason}` : ''}`;
    }
    case 'backup.list':
      return `${who} looked at the list of backups`;
    case 'backup.preview':
      return `${who} looked at ${backupLabel(d.manifest)}`;
    case 'backup.boards': {
      const count = typeof d.count === 'number' ? ` (${countLabel(d.count, 'board', 'boards')})` : '';
      return `${who} listed the boards of ${backupLabel(d.manifest)}${count}`;
    }
    case 'restore.started':
      return d.kind === 'board'
        ? `${who} started restoring a board as a copy from ${backupLabel(d.manifest)}`
        : `${who} started restoring the whole workspace from ${backupLabel(d.manifest)}`;
    case 'restore.done': {
      if (d.kind === 'board') {
        const where = d.fallback === 'personal' ? ' in their personal space' : '';
        return `${who} restored ${boardLabel} as a copy from ${backupLabel(d.manifest)}${where}`;
      }
      const facts = [
        typeof d.boards === 'number' ? countLabel(d.boards, 'board', 'boards') : null,
        typeof d.users === 'number' ? countLabel(d.users, 'person', 'people') : null,
        typeof d.sessionsRemoved === 'number' ? `${countLabel(d.sessionsRemoved, 'session', 'sessions')} ended` : null,
      ].filter(Boolean);
      return `${who} restored the whole workspace from ${backupLabel(d.manifest)}${facts.length ? ` (${facts.join(', ')})` : ''}`;
    }
    case 'restore.failed': {
      const what = d.kind === 'board' ? 'a board copy' : 'the whole workspace';
      const reason = text(d.error);
      return `Restoring ${what} from ${backupLabel(d.manifest)} failed${reason ? `: ${errorReason(reason)}` : ''}`;
    }
    case 'restore.old_data_removed': {
      const age = typeof d.ageDays === 'number' ? ` (${countLabel(d.ageDays, 'day', 'days')} old)` : '';
      return `The old data of a restore was removed${age}`;
    }
    case 'volume.adopt': {
      const from = idsOf(d.from);
      const to = idsOf(d.to);
      if (d.reason === 'operator') {
        const ws = from.workspaceId ? ` of workspace ${from.workspaceId}` : '';
        return `An operator adopted the data volume${ws} into this workspace; everyone was signed out, and every AI tool access token and invite link was revoked`;
      }
      if (d.reason === 'restored-copy') {
        const vols = from.flyVolumeId && to.flyVolumeId ? ` (Fly volume ${from.flyVolumeId} → ${to.flyVolumeId})` : '';
        return `The server adopted a restored copy of its data volume${vols}; everyone was signed out`;
      }
      return 'The server adopted its data volume; everyone was signed out';
    }
    default:
      return entry.action;
  }
}

/** The ids in the `from` or `to` of a volume.adopt row; a missing or odd one is null. */
function idsOf(value: unknown): { workspaceId: string | null; flyVolumeId: string | null } {
  const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const id = (x: unknown) => (typeof x === 'string' && x ? x : null);
  return { workspaceId: id(v.workspaceId), flyVolumeId: id(v.flyVolumeId) };
}

/** "the backup of 2026-01-15 09:30 UTC": a manifest's name carries the time it was taken. */
function backupLabel(manifest: unknown): string {
  const at = manifestTime(typeof manifest === 'string' ? manifest : null);
  return at === null ? 'a backup' : `the backup of ${formatUtc(at)}`;
}

/** A count with its noun: "1 owner", "2 owners", "0 owners". */
export function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Case-insensitive substring match over the given fields; an empty query matches everything. */
export function matchesQuery(query: string, fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

/**
 * Where focus goes after a list re-renders. Keys name focusable controls as `<row id>:<control>`, in
 * document order. Focus goes back to the same control, or, when its row is gone, to the same control
 * of the row that took its place (the next row, or the new last one). Undefined when there is none.
 */
export function focusTarget(before: string[], key: string, after: string[]): string | undefined {
  if (after.includes(key)) return key;
  const control = key.slice(key.lastIndexOf(':'));
  const was = before.filter((k) => k.endsWith(control)).indexOf(key);
  const now = after.filter((k) => k.endsWith(control));
  if (was < 0 || !now.length) return undefined;
  return now[Math.min(was, now.length - 1)];
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/\biPhone|\biPad|\biPod/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
];

/**
 * A short name for the browser a session signed in from, such as "Chrome on macOS". Enough to tell one person's
 * sessions apart; not a fingerprint. Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent?.trim()) return 'Unknown device';
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  if (browser || system) return (browser ?? system)!;
  return userAgent.trim().split(/[\s/;(]/)[0].slice(0, 40) || 'Unknown device';
}

/** A stat tile on the Overview: its label, its number and the line under it. */
export interface OverviewTile { label: string; value: number; sub?: string }

/**
 * The Overview's stat tiles. Members, teams and boards each count everything, with the part that is out of use
 * (disabled, archived, deleted) on the line under the number, so the role breakdown adds up to the number above it.
 */
export function overviewTiles(o: AdminOverview): OverviewTile[] {
  const r = o.members.byRole;
  return [
    {
      label: 'Members',
      value: o.members.total,
      sub: [countLabel(r.owner, 'owner', 'owners'), countLabel(r.admin, 'admin', 'admins'), countLabel(r.member, 'member', 'members'), countLabel(r.guest, 'guest', 'guests')].join(' · '),
    },
    { label: 'Disabled members', value: o.members.disabled, sub: `${o.members.active} active` },
    { label: 'Teams', value: o.teams.total, sub: `${o.teams.archived} archived` },
    { label: 'Boards', value: o.boards.total, sub: `${o.boards.deleted} deleted` },
    { label: 'Active sessions', value: o.sessions.active },
    { label: 'Sign-ins, last 7 days', value: o.signIns7d },
    { label: 'Live connections', value: o.live.connections, sub: `${countLabel(o.live.rooms, 'room', 'rooms')} open` },
  ];
}

/**
 * Admin sections to show: Access tokens only when AI tool access is on for this server, Backups only to owners, and
 * Settings only on a hosted workspace.
 */
export function visibleAdminTabs<T extends string>(tabs: readonly T[], mcp: boolean | undefined, role: UserRole | undefined, chat?: boolean, hosted = false): T[] {
  return tabs.filter((t) => (t !== 'tokens' || mcp === true) && (t !== 'backups' || role === 'owner') && (t !== 'chat' || chat === true) && (t !== 'settings' || hosted));
}
