import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError, createApi, type AdminOverview, type AuditEntry } from '../src/api';
import { errorReason } from '../src/ui/backups-logic';
import {
  activeOwnerCount,
  auditActor,
  auditSentence,
  countLabel,
  deviceLabel,
  disableVerdict,
  focusTarget,
  isKnownAuditAction,
  KNOWN_AUDIT_ACTIONS,
  matchesQuery,
  overviewTiles,
  removeVerdict,
  revokeVerdict,
  roleLock,
  roleOptions,
  roleVerdict,
  type Actor,
  type Lookup,
  type Target,
  type Verdict,
  visibleAdminTabs,
} from '../src/ui/admin-logic';
import { ADMIN_TABS } from '../src/route';

const entry = (action: string, detail: Record<string, unknown> = {}, actor: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  ts: 0,
  actorId: 'u1',
  actorName: 'Ana',
  actorEmail: 'ana@example.com',
  action,
  detail,
  ...actor,
});

const known = (names: { user?: Record<string, string>; team?: Record<string, string>; board?: Record<string, string> }): Lookup =>
  (kind, id) => names[kind]?.[id];

const NAMES = known({
  user: { u2: 'bo@example.com' },
  team: { t1: 'Design' },
  board: { b1: 'Roadmap' },
});

describe('auditSentence', () => {
  it.each<[string, AuditEntry, string]>([
    ['auth.login', entry('auth.login'), 'ana@example.com signed in'],
    ['auth.logout', entry('auth.logout'), 'ana@example.com signed out'],
    ['auth.logout_all', entry('auth.logout_all'), 'ana@example.com signed out everywhere'],
    ['me.update without a name', entry('me.update'), 'ana@example.com updated their profile'],
    ['me.update with a name', entry('me.update', { name: 'Anna' }), 'ana@example.com changed their name to “Anna”'],
    ['team.create', entry('team.create', { teamId: 't1', name: 'Design' }), 'ana@example.com created team “Design”'],
    ['team.create without a name', entry('team.create', { teamId: 't1' }), 'ana@example.com created a team'],
    ['team.update archived', entry('team.update', { teamId: 't1', archived: true }), 'ana@example.com archived “Design”'],
    ['team.update unarchived', entry('team.update', { teamId: 't1', archived: false }), 'ana@example.com unarchived “Design”'],
    ['team.update renamed', entry('team.update', { teamId: 't1', name: 'Platform' }), 'ana@example.com renamed “Design” to “Platform”'],
    ['team.member.role', entry('team.member.role', { teamId: 't1', userId: 'u2', role: 'admin' }), 'ana@example.com changed bo@example.com’s role in “Design” to admin'],
    ['team.leave', entry('team.leave', { teamId: 't1', userId: 'u1' }), 'ana@example.com left “Design”'],
    ['team.member.remove', entry('team.member.remove', { teamId: 't1', userId: 'u2' }), 'ana@example.com removed bo@example.com from “Design”'],
    ['invite.create', entry('invite.create', { teamId: 't1', inviteId: 'i1', role: 'member', days: 7 }), 'ana@example.com created an invite link for “Design” as member'],
    ['invite.revoke', entry('invite.revoke', { teamId: 't1', inviteId: 'i1' }), 'ana@example.com revoked an invite link for “Design”'],
    ['invite.accept', entry('invite.accept', { teamId: 't1', inviteId: 'i1', role: 'admin' }), 'ana@example.com joined “Design” as admin'],
    ['board.create', entry('board.create', { boardId: 'b1', teamId: null, adopted: false }), 'ana@example.com created “Roadmap”'],
    ['board.create in a team', entry('board.create', { boardId: 'b1', teamId: 't1', adopted: false }), 'ana@example.com created “Roadmap” in “Design”'],
    ['board.create adopted', entry('board.create', { boardId: 'b1', teamId: null, adopted: true }), 'ana@example.com added “Roadmap” to the workspace'],
    ['board.update renamed', entry('board.update', { boardId: 'b1', title: 'Plan' }), 'ana@example.com renamed “Roadmap” to “Plan”'],
    ['board.update moved to personal', entry('board.update', { boardId: 'b1', teamId: null }), 'ana@example.com moved “Roadmap” to personal'],
    ['board.update moved to a team', entry('board.update', { boardId: 'b1', teamId: 't1' }), 'ana@example.com moved “Roadmap” to “Design”'],
    ['board.delete', entry('board.delete', { boardId: 'b1' }), 'ana@example.com deleted “Roadmap”'],
    ['board.restore', entry('board.restore', { boardId: 'b1' }), 'ana@example.com restored “Roadmap”'],
    ['board.share to a person', entry('board.share', { boardId: 'b1', principalType: 'user', principalId: 'u2', role: 'commenter' }), 'ana@example.com shared “Roadmap” with bo@example.com as commenter'],
    ['board.share to a team', entry('board.share', { boardId: 'b1', principalType: 'team', principalId: 't1', role: 'editor' }), 'ana@example.com shared “Roadmap” with “Design” as editor'],
    ['board.unshare from a team', entry('board.unshare', { boardId: 'b1', principalType: 'team', principalId: 't1' }), 'ana@example.com removed “Design” from “Roadmap”'],
    ['board.unshare from a person', entry('board.unshare', { boardId: 'b1', principalType: 'user', principalId: 'u2' }), 'ana@example.com removed bo@example.com from “Roadmap”'],
    ['board.version.create', entry('board.version.create', { boardId: 'b1', versionId: 'v1', label: 'Before the workshop' }), 'ana@example.com saved the version “Before the workshop” of “Roadmap”'],
    ['board.version.rename', entry('board.version.rename', { boardId: 'b1', versionId: 'v1', label: 'Final' }), 'ana@example.com named a version of “Roadmap” “Final”'],
    ['board.version.delete', entry('board.version.delete', { boardId: 'b1', versionId: 'v1', kind: 'named' }), 'ana@example.com deleted a version of “Roadmap”'],
    ['board.version.restore', entry('board.version.restore', { boardId: 'b1', versionId: 'v1', preRestoreId: 'v2' }), 'ana@example.com restored a version of “Roadmap”'],
    ['template.create for me', entry('template.create', { templateId: 'x1', name: 'Retro', scope: 'personal' }), 'ana@example.com saved the template “Retro”'],
    ['template.create for a team', entry('template.create', { templateId: 'x1', name: 'Retro', scope: 'team', teamId: 't1' }), 'ana@example.com saved the template “Retro” shared with “Design”'],
    ['template.update for the workspace', entry('template.update', { templateId: 'x1', name: 'Retro', scope: 'workspace' }), 'ana@example.com changed the template “Retro” shared with the workspace'],
    ['template.delete', entry('template.delete', { templateId: 'x1', name: 'Retro', scope: 'personal' }), 'ana@example.com deleted the template “Retro”'],
    ['member.update role', entry('member.update', { userId: 'u2', role: 'admin' }), 'ana@example.com changed bo@example.com to admin'],
    ['member.update disabled', entry('member.update', { userId: 'u2', disabled: true }), 'ana@example.com disabled bo@example.com'],
    ['member.update enabled', entry('member.update', { userId: 'u2', disabled: false }), 'ana@example.com enabled bo@example.com'],
    ['member.remove uses the email in the detail', entry('member.remove', { userId: 'u2', email: 'bo@example.com' }), 'ana@example.com removed bo@example.com'],
    ['admin.sessions.revoke', entry('admin.sessions.revoke', { userId: 'u2' }), 'ana@example.com revoked all sessions of bo@example.com'],
    ['admin.session.revoke', entry('admin.session.revoke', { sessionId: 's1', userId: 'u2' }), 'ana@example.com revoked a session of bo@example.com'],
    ['cloud.limits from the control plane', entry('cloud.limits', { seatLimit: 5, readOnly: true, banner: null }, { actorId: null, actorName: null, actorEmail: null }), 'System updated the workspace limits (5 seats, read-only)'],
    ['cloud.limits with one seat', entry('cloud.limits', { seatLimit: 1, readOnly: false }), 'ana@example.com updated the workspace limits (1 seat)'],
    ['cloud.notify trial-ending', entry('cloud.notify', { template: 'trial-ending', count: 2 }, { actorId: null, actorName: null, actorEmail: null }), 'System sent the trial-ending notice to 2 workspace owners'],
    ['cloud.notify to one owner', entry('cloud.notify', { template: 'trial-ending', count: 1 }, { actorId: null, actorName: null, actorEmail: null }), 'System sent the trial-ending notice to 1 workspace owner'],
    ['cloud.notify without details', entry('cloud.notify', {}, { actorId: null, actorName: null, actorEmail: null }), 'System sent a notice to the workspace owners'],
    ['updates.auto off', entry('updates.auto', { from: true, to: false }), 'ana@example.com turned automatic updates off'],
    ['updates.auto on', entry('updates.auto', { from: false, to: true }), 'ana@example.com turned automatic updates on'],
    ['updates.auto with a name', entry('updates.auto', { from: true, to: false }, { actorEmail: null }), 'Ana turned automatic updates off'],
    ['cloud.limits without limits', entry('cloud.limits', { seatLimit: null, readOnly: false, banner: 'Hi' }), 'ana@example.com updated the workspace limits'],
    ['ai.settings turned on with a model', entry('ai.settings', { enabled: true, model: 'claude-sonnet-5-5' }), 'ana@example.com changed the AI settings (turned on, model claude-sonnet-5-5)'],
    ['ai.settings turned off', entry('ai.settings', { enabled: false }), 'ana@example.com changed the AI settings (turned off)'],
    ['ai.settings with the rest', entry('ai.settings', { features: ['generate'], personalKeys: false, membersOnly: true, limits: { perPersonHour: 3 } }), 'ana@example.com changed the AI settings (1 feature, personal keys off, members only, limits)'],
    ['ai.settings with personal keys on and guests allowed', entry('ai.settings', { features: [], personalKeys: true, membersOnly: false }), 'ana@example.com changed the AI settings (0 features, personal keys allowed, guests allowed)'],
    ['ai.key.set for the workspace', entry('ai.key.set', { scope: 'workspace', provider: 'anthropic' }), 'ana@example.com set the workspace AI key'],
    ['ai.key.set for a person', entry('ai.key.set', { scope: 'user', provider: 'anthropic' }), 'ana@example.com added their own AI key'],
    ['ai.key.delete for the workspace', entry('ai.key.delete', { scope: 'workspace' }), 'ana@example.com removed the workspace AI key'],
    ['ai.key.delete for a person', entry('ai.key.delete', { scope: 'user' }), 'ana@example.com removed their own AI key'],
    ['ai.key.test for the workspace', entry('ai.key.test', { scope: 'workspace', provider: 'anthropic', ok: true }), 'ana@example.com tested the workspace AI key'],
    ['ai.key.test for a person that failed', entry('ai.key.test', { scope: 'user', provider: 'anthropic', ok: false }), 'ana@example.com tested their own AI key (did not work)'],
    ['ai.generate', entry('ai.generate', { boardId: 'b1', outcome: 'ok' }), 'ana@example.com generated stickies on “Roadmap”'],
    ['ai.generate on a board that is gone', entry('ai.generate', { boardId: 'gone', outcome: 'ok' }), 'ana@example.com generated stickies on a board'],
    ['ai.summarise', entry('ai.summarise', { boardId: 'b1', outcome: 'ok' }), 'ana@example.com summarised “Roadmap”'],
    ['ai.cluster', entry('ai.cluster', { boardId: 'b1', outcome: 'ok' }), 'ana@example.com grouped stickies on “Roadmap”'],
    ['ai.cluster cancelled', entry('ai.cluster', { boardId: 'b1', outcome: 'ai_aborted' }), 'ana@example.com grouped stickies on “Roadmap” (cancelled)'],
    ['ai.summarise timed out', entry('ai.summarise', { boardId: 'b1', outcome: 'ai_timeout' }), 'ana@example.com summarised “Roadmap” (timed out)'],
    ['ai.generate declined', entry('ai.generate', { boardId: 'b1', outcome: 'ai_refused' }), 'ana@example.com generated stickies on “Roadmap” (declined by the AI)'],
    ['ai.generate failed', entry('ai.generate', { boardId: 'b1', outcome: 'ai_invalid_proposal' }), 'ana@example.com generated stickies on “Roadmap” (failed)'],
    ['ai.generate with no outcome', entry('ai.generate', { boardId: 'b1' }), 'ana@example.com generated stickies on “Roadmap”'],
    ['ai.run.accept', entry('ai.run.accept', { boardId: 'b1', feature: 'generate' }), 'ana@example.com added an AI proposal to “Roadmap”'],
    ['ai.run.discard', entry('ai.run.discard', { boardId: 'b1', feature: 'cluster' }), 'ana@example.com discarded an AI proposal on “Roadmap”'],
    ['chat.delete', entry('chat.delete', { kind: 'board', ref: 'b1', messageId: 7, authorId: 'u2' }), 'ana@example.com removed a message by bo@example.com in “Roadmap”'],
    ['chat.delete by a removed author on a board that is gone', entry('chat.delete', { kind: 'board', ref: 'gone', messageId: 7, authorId: null }), 'ana@example.com removed a message by a former member in a board chat'],
    ['chat.settings', entry('chat.settings', { viewersMayPost: true, retentionDays: 90 }), 'ana@example.com changed the chat settings (viewers may post, keep messages 90 days)'],
    ['chat.erase', entry('chat.erase', { userId: 'u2', count: 14 }), 'ana@example.com erased the chat messages of bo@example.com (14 messages)'],
    ['chat.export', entry('chat.export', { userId: 'u2', count: 3 }), 'ana@example.com exported the chat messages of bo@example.com'],
    ['chat.retention', entry('chat.retention', { days: 365, removed: 120 }), '120 chat messages older than 365 days were removed by the retention setting'],
    ['chat.settings channel', entry('chat.settings', { workspaceChannel: false }), 'ana@example.com changed the chat settings (workspace channel off)'],
    ['chat.settings forever', entry('chat.settings', { viewersMayPost: false, retentionDays: null }), 'ana@example.com changed the chat settings (viewers read only, keep messages forever)'],
    ['backup.run', entry('backup.run', { changed: true, files: 14, uploaded: 3 }, { actorId: null, actorName: null, actorEmail: null }), 'System backed up the workspace (14 files, 3 new)'],
    ['backup.run that repaired objects', entry('backup.run', { changed: false, files: 14, uploaded: 2, repaired: 2 }, { actorId: null, actorName: null, actorEmail: null }), 'System backed up the workspace (14 files, 2 new, 2 repaired)'],
    ['mcp.token.create', entry('mcp.token.create', { tokenId: 't1', name: 'Claude Desktop', scope: 'write', boardIds: null, days: 30 }), 'ana@example.com created an AI tool access token “Claude Desktop” (read and edit)'],
    ['mcp.token.create read only with a long name', entry('mcp.token.create', { name: 'n'.repeat(90), scope: 'read' }), `ana@example.com created an AI tool access token “${'n'.repeat(59)}…” (read only)`],
    ['mcp.token.revoke of their own', entry('mcp.token.revoke', { tokenId: 't1', name: 'Claude Desktop', by: 'self' }), 'ana@example.com revoked their AI tool access token “Claude Desktop”'],
    ['mcp.token.revoke by an admin', entry('mcp.token.revoke', { tokenId: 't1', name: 'Cursor', userId: 'u2', by: 'admin' }), 'ana@example.com revoked the AI tool access token “Cursor” of bo@example.com'],
    ['mcp.token.revoke_all', entry('mcp.token.revoke_all', { count: 3 }), 'ana@example.com revoked all of their AI tool access tokens (3)'],
    ['backup.run with nothing known', entry('backup.run', {}, { actorId: null, actorName: null, actorEmail: null }), 'System backed up the workspace'],
    ['backup.failed', entry('backup.failed', { error: 'S3 PUT failed (status 403, AccessDenied)' }, { actorId: null, actorName: null, actorEmail: null }), 'A backup failed: S3 PUT failed (status 403, AccessDenied)'],
    ['backup.failed with a long reason', entry('backup.failed', { error: 'x'.repeat(300) }), `A backup failed: ${'x'.repeat(119)}…`],
    ['backup.list', entry('backup.list'), 'ana@example.com looked at the list of backups'],
    ['backup.preview', entry('backup.preview', { manifest: '20260115T093000Z.json.enc' }), 'ana@example.com looked at the backup of 2026-01-15 09:30 UTC'],
    ['backup.preview with a bad name', entry('backup.preview', { manifest: '../x' }), 'ana@example.com looked at a backup'],
    ['backup.boards', entry('backup.boards', { manifest: '20260115T093000Z.json.enc', count: 12 }), 'ana@example.com listed the boards of the backup of 2026-01-15 09:30 UTC (12 boards)'],
    ['restore.started whole', entry('restore.started', { kind: 'workspace', manifest: '20260115T093000Z.json.enc' }), 'ana@example.com started restoring the whole workspace from the backup of 2026-01-15 09:30 UTC'],
    ['restore.started board', entry('restore.started', { kind: 'board', manifest: '20260115T093000Z.json.enc' }), 'ana@example.com started restoring a board as a copy from the backup of 2026-01-15 09:30 UTC'],
    ['restore.done whole', entry('restore.done', { kind: 'workspace', manifest: '20260115T093000Z.json.enc', boards: 9, users: 4, sessionsRemoved: 6 }), 'ana@example.com restored the whole workspace from the backup of 2026-01-15 09:30 UTC (9 boards, 4 people, 6 sessions ended)'],
    ['restore.done board', entry('restore.done', { kind: 'board', manifest: '20260115T093000Z.json.enc', boardId: 'b1', fallback: 'team' }), 'ana@example.com restored “Roadmap” as a copy from the backup of 2026-01-15 09:30 UTC'],
    ['restore.done board in the personal space', entry('restore.done', { kind: 'board', manifest: '20260115T093000Z.json.enc', boardId: 'b1', fallback: 'personal' }), 'ana@example.com restored “Roadmap” as a copy from the backup of 2026-01-15 09:30 UTC in their personal space'],
    ['restore.failed whole', entry('restore.failed', { kind: 'workspace', manifest: '20260115T093000Z.json.enc', error: 'not_enough_space' }), 'Restoring the whole workspace from the backup of 2026-01-15 09:30 UTC failed: ' + errorReason('not_enough_space')],
    ['restore.failed board without a reason', entry('restore.failed', { kind: 'board', manifest: '20260115T093000Z.json.enc' }), 'Restoring a board copy from the backup of 2026-01-15 09:30 UTC failed'],
    ['restore.old_data_removed', entry('restore.old_data_removed', { ageDays: 7, mode: 'days' }, { actorId: null, actorName: null, actorEmail: null }), 'The old data of a restore was removed (7 days old)'],
    ['volume.adopt operator', entry('volume.adopt', { from: { workspaceId: 'ws_a', flyVolumeId: 'vol_1' }, to: { workspaceId: 'ws_b', flyVolumeId: 'vol_2' }, reason: 'operator' }, { actorId: null, actorName: null, actorEmail: null }), 'An operator adopted the data volume of workspace ws_a into this workspace; everyone was signed out, and every AI tool access token and invite link was revoked'],
    ['volume.adopt restored copy', entry('volume.adopt', { from: { workspaceId: 'ws_a', flyVolumeId: 'vol_1' }, to: { workspaceId: 'ws_a', flyVolumeId: 'vol_2' }, reason: 'restored-copy' }, { actorId: null, actorName: null, actorEmail: null }), 'The server adopted a restored copy of its data volume (Fly volume vol_1 → vol_2); everyone was signed out'],
    ['volume.adopt without ids', entry('volume.adopt', { from: { workspaceId: null, flyVolumeId: null }, reason: 'restored-copy' }), 'The server adopted a restored copy of its data volume; everyone was signed out'],
  ])('%s', (_name, e, sentence) => {
    expect(auditSentence(e, NAMES)).toBe(sentence);
  });

  it.each<[string, AuditEntry, string]>([
    ['member.update without a lookup', entry('member.update', { userId: 'u9', role: 'admin' }), 'ana@example.com changed a member to admin'],
    ['board.update without a lookup', entry('board.update', { boardId: 'b9', title: 'Plan' }), 'ana@example.com renamed a board to “Plan”'],
    ['board.delete with an empty detail', entry('board.delete'), 'ana@example.com deleted a board'],
    ['admin.sessions.revoke with an empty detail', entry('admin.sessions.revoke'), 'ana@example.com revoked all sessions of a member'],
    ['admin.session.revoke with an empty detail', entry('admin.session.revoke'), 'ana@example.com revoked a session of a member'],
    ['board.restore with an empty detail', entry('board.restore'), 'ana@example.com restored a board'],
    ['board.version.create with an empty detail', entry('board.version.create'), 'ana@example.com saved a version of a board'],
    ['board.version.rename with an empty detail', entry('board.version.rename'), 'ana@example.com renamed a version of a board'],
    ['template.delete with an empty detail', entry('template.delete'), 'ana@example.com deleted the template'],
    ['template.create for a team without a lookup', entry('template.create', { scope: 'team', teamId: 't9' }), 'ana@example.com saved the template shared with a team'],
    ['member.remove with an empty detail', entry('member.remove'), 'ana@example.com removed a member'],
    ['team.member.role without a role', entry('team.member.role', { teamId: 't1', userId: 'u2' }), 'ana@example.com changed bo@example.com’s role in “Design” to a new role'],
  ])('tolerates a sparse detail: %s', (_name, e, sentence) => {
    expect(auditSentence(e, NAMES)).toBe(sentence);
  });

  it('names a team neutrally when the caller has no lookup', () => {
    expect(auditSentence(entry('team.update', { teamId: 't1', name: 'Platform' }))).toBe('ana@example.com renamed a team to “Platform”');
  });

  it('falls back to the raw action for an unknown action', () => {
    expect(auditSentence(entry('billing.invoice.paid'), NAMES)).toBe('billing.invoice.paid');
  });

  it.each<[string, Partial<AuditEntry>, string]>([
    ['an email wins over a name', { actorEmail: 'ana@example.com', actorName: 'Ana' }, 'ana@example.com'],
    ['a name stands in for a missing email', { actorEmail: null, actorName: 'Ana' }, 'Ana'],
    ['a system row has no actor', { actorId: null, actorName: null, actorEmail: null }, 'System'],
    ['a deleted user has no name', { actorId: 'gone', actorName: null, actorEmail: null }, 'A deleted user'],
  ])('actor: %s', (_name, actor, label) => {
    expect(auditActor(entry('auth.login', {}, actor))).toBe(label);
  });

  it('gives every action the server writes a sentence of its own', () => {
    const expected = [
      'auth.login', 'auth.logout', 'auth.logout_all', 'me.update',
      'team.create', 'team.update', 'team.member.role', 'team.leave', 'team.member.remove',
      'invite.create', 'invite.revoke', 'invite.accept',
      'board.create', 'board.update', 'board.delete', 'board.share', 'board.unshare',
      'board.version.create', 'board.version.rename', 'board.version.delete', 'board.version.restore',
      'template.create', 'template.update', 'template.delete',
      'member.update', 'member.remove',
      'admin.sessions.revoke', 'admin.session.revoke', 'board.restore', 'cloud.limits', 'cloud.notify', 'updates.auto',
      'ai.settings', 'ai.key.set', 'ai.key.delete', 'ai.key.test', 'ai.generate', 'ai.summarise', 'ai.cluster', 'ai.run.accept', 'ai.run.discard',
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
    ];
    expect([...KNOWN_AUDIT_ACTIONS].sort()).toEqual([...expected].sort());
  });

  it('knows every audit action written by name anywhere in the server (TAB-199)', () => {
    // Every `audit(...)`, `auditRow(...)` and `directory.audit(...)` call whose action is a literal; actions built from a
    // variable (ai.<feature>, ai.run.<action>, team.leave and team.member.remove) are in the list above by hand.
    const root = fileURLToPath(new URL('../server', import.meta.url));
    const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
    const written = new Set<string>();
    for (const src of files) {
      for (const m of src.matchAll(/\baudit(?:Row)?\(\s*[^,()]*(?:\([^()]*\))?[^,()]*,\s*'([a-z_]+(?:\.[a-z_]+)+)'/g)) written.add(m[1]);
      // and an action kept in a constant, such as volume.mjs's AUDIT_ACTION
      for (const m of src.matchAll(/\bconst [A-Z_]*AUDIT[A-Z_]*\s*=\s*'([a-z_]+(?:\.[a-z_]+)+)'/g)) written.add(m[1]);
    }
    expect(written.size).toBeGreaterThan(40);
    expect([...written].filter((a) => !isKnownAuditAction(a)).sort()).toEqual([]);
  });

  it.each(KNOWN_AUDIT_ACTIONS.map((a) => [a]))('%s is known and reads as a sentence', (action) => {
    expect(isKnownAuditAction(action)).toBe(true);
    expect(auditSentence(entry(action), NAMES)).not.toBe(action);
  });

  it('does not treat an unknown action as known', () => {
    expect(isKnownAuditAction('member.destroy')).toBe(false);
  });
});

const owner: Actor = { id: 'o1', role: 'owner' };
const admin: Actor = { id: 'a1', role: 'admin' };
const member = (over: Partial<Target> = {}): Target => ({ id: 'm1', role: 'member', disabled: false, ...over });
const ownerTarget = (over: Partial<Target> = {}): Target => ({ id: 'o2', role: 'owner', disabled: false, ...over });

describe('activeOwnerCount', () => {
  it('counts owners who are not disabled', () => {
    const list = [
      { role: 'owner' as const, disabled: false },
      { role: 'owner' as const, disabled: true },
      { role: 'admin' as const, disabled: false },
    ];
    expect(activeOwnerCount(list)).toBe(1);
  });
});

describe('roleOptions', () => {
  it.each<[string, Actor, Target, string[]]>([
    ['an owner picks any role for a member', owner, member(), ['owner', 'admin', 'member', 'guest']],
    ['an admin never offers owner', admin, member(), ['admin', 'member', 'guest']],
    ['an admin sees an owner row as owner only', admin, ownerTarget(), ['owner']],
    ['an owner sees every role for an owner row', owner, ownerTarget(), ['owner', 'admin', 'member', 'guest']],
  ])('%s', (_name, actor, target, options) => {
    expect(roleOptions(actor, target)).toEqual(options);
  });
});

describe('role rules', () => {
  it.each<[string, Verdict, boolean]>([
    ['an owner can change a member', roleLock(owner, member(), 1), true],
    ['an admin can change a member', roleLock(admin, member(), 1), true],
    ['nobody changes their own role', roleLock(owner, member({ id: 'o1' }), 1), false],
    ['an admin cannot change an owner', roleLock(admin, ownerTarget(), 2), false],
    ['the last active owner cannot be demoted', roleLock(owner, ownerTarget(), 1), false],
    ['an owner can change an owner when another active owner exists', roleLock(owner, ownerTarget(), 2), true],
    ['a disabled owner does not count as the last owner', roleLock(owner, ownerTarget({ disabled: true }), 1), true],
  ])('lock: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });

  it.each<[string, Verdict, boolean]>([
    ['keeping the current role is always fine', roleVerdict(admin, member({ role: 'admin' }), 'admin', 1), true],
    ['an admin cannot make someone an owner', roleVerdict(admin, member(), 'owner', 1), false],
    ['an owner can make someone an owner', roleVerdict(owner, member(), 'owner', 1), true],
    ['an admin can set a member to guest', roleVerdict(admin, member(), 'guest', 1), true],
    ['the last active owner cannot step down', roleVerdict(owner, ownerTarget(), 'admin', 1), false],
    ['an owner can step down when another owner exists', roleVerdict(owner, ownerTarget(), 'admin', 2), true],
  ])('verdict: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });

  it.each<[string, Verdict, boolean]>([
    ['an owner can disable a member', disableVerdict(owner, member(), true, 1), true],
    ['nobody disables themselves', disableVerdict(owner, member({ id: 'o1' }), true, 2), false],
    ['an admin cannot disable an owner', disableVerdict(admin, ownerTarget(), true, 2), false],
    ['the last active owner cannot be disabled', disableVerdict(owner, ownerTarget(), true, 1), false],
    ['an owner can disable one of two owners', disableVerdict(owner, ownerTarget(), true, 2), true],
    ['an owner can enable a disabled owner', disableVerdict(owner, ownerTarget({ disabled: true }), false, 0), true],
    ['an admin cannot enable an owner', disableVerdict(admin, ownerTarget({ disabled: true }), false, 1), false],
    ['an admin can enable a member', disableVerdict(admin, member({ disabled: true }), false, 1), true],
  ])('disable: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });

  it.each<[string, Verdict, boolean]>([
    ['nobody removes themselves', removeVerdict(owner, member({ id: 'o1' }), 2), false],
    ['an admin cannot remove an owner', removeVerdict(admin, ownerTarget(), 2), false],
    ['the sole active owner cannot be removed', removeVerdict(owner, ownerTarget(), 1), false],
    ['a disabled owner can go when another active owner exists', removeVerdict(owner, ownerTarget({ disabled: true }), 1), true],
    ['a disabled owner cannot go when none is active', removeVerdict(owner, ownerTarget({ disabled: true }), 0), false],
    ['an owner can remove an owner while another stays active', removeVerdict(owner, ownerTarget(), 2), true],
    ['an admin can remove a member', removeVerdict(admin, member(), 1), true],
  ])('remove: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });

  it.each<[string, Verdict, boolean]>([
    ['anyone signs themselves out everywhere', revokeVerdict(admin, { id: 'a1', role: 'admin', disabled: false }), true],
    ['an owner signs themselves out everywhere', revokeVerdict(owner, { id: 'o1', role: 'owner', disabled: false }), true],
    ['an admin cannot sign an owner out everywhere', revokeVerdict(admin, ownerTarget()), false],
    ['an admin can sign a member out everywhere', revokeVerdict(admin, member()), true],
  ])('revoke: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });
});

describe('countLabel', () => {
  it.each<[number, string]>([
    [0, '0 owners'],
    [1, '1 owner'],
    [2, '2 owners'],
    [12, '12 owners'],
  ])('%i', (n, label) => {
    expect(countLabel(n, 'owner', 'owners')).toBe(label);
  });
});

describe('matchesQuery', () => {
  it.each<[string, string, (string | null | undefined)[], boolean]>([
    ['an empty query matches everything', '', [null], true],
    ['a blank query matches everything', '   ', ['x'], true],
    ['matching ignores case', 'ANA', ['ana@example.com'], true],
    ['any field can match', 'bo', ['Ana', 'bo@example.com'], true],
    ['null fields never match', 'bo', [null, undefined], false],
    ['no field matches', 'zed', ['Ana', 'ana@example.com'], false],
  ])('%s', (_name, query, fields, matched) => {
    expect(matchesQuery(query, fields)).toBe(matched);
  });
});

const headersOf = (c: { init: RequestInit }) => c.init.headers as Record<string, string>;

/** A fetch that answers every call with the same body, and records what was asked. */
function recorder(body: unknown = {}, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('admin API client', () => {
  it.each<[string, (api: ReturnType<typeof createApi>) => Promise<unknown>, string, string]>([
    ['overview', (a) => a.adminOverview(), 'GET', '/api/admin/overview'],
    ['members', (a) => a.adminMembers(), 'GET', '/api/admin/members'],
    ['revoke a member’s sessions', (a) => a.revokeMemberSessions('u 1/x'), 'POST', '/api/admin/members/u%201%2Fx/revoke-sessions'],
    ['sessions', (a) => a.adminSessions(), 'GET', '/api/admin/sessions'],
    ['revoke one session', (a) => a.revokeSession('s1'), 'DELETE', '/api/admin/sessions/s1'],
    ['boards', (a) => a.adminBoards(), 'GET', '/api/admin/boards'],
    ['boards including deleted', (a) => a.adminBoards(true), 'GET', '/api/admin/boards?deleted=1'],
    ['restore a board', (a) => a.restoreBoard('b1'), 'POST', '/api/admin/boards/b1/restore'],
    ['automatic updates', (a) => a.adminUpdates(), 'GET', '/api/admin/updates'],
    ['save automatic updates', (a) => a.setAdminUpdates(false), 'PUT', '/api/admin/updates'],
    ['audit first page', (a) => a.adminAudit(), 'GET', '/api/admin/audit'],
    ['audit with every option', (a) => a.adminAudit({ limit: 50, before: 7, action: 'board.' }), 'GET', '/api/admin/audit?limit=50&before=7&action=board.'],
    ['teams go through the existing route', (a) => a.teams(), 'GET', '/api/teams'],
  ])('%s', async (_name, call, method, url) => {
    const { fetchFn, calls } = recorder({});
    await call(createApi(fetchFn));
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([[method, url]]);
  });

  it('sends only the automatic update choice', async () => {
    const { fetchFn, calls } = recorder({ auto: false, synced: true, securityAlwaysApplied: true });
    await createApi(fetchFn).setAdminUpdates(false);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ auto: false });
  });

  it.each<[string, (api: ReturnType<typeof createApi>) => Promise<unknown>]>([
    ['restore', (a) => a.restoreBoard('b1')],
    ['revoke a member’s sessions', (a) => a.revokeMemberSessions('m1')],
    ['revoke one session', (a) => a.revokeSession('s1')],
  ])('%s carries the CSRF header', async (_name, call) => {
    const { fetchFn, calls } = recorder(undefined, 204);
    await call(createApi(fetchFn));
    expect(calls.map((c) => headersOf(c)['x-tabula'])).toEqual(['1']);
  });

  it('reads send no CSRF header', async () => {
    const { fetchFn, calls } = recorder({});
    await createApi(fetchFn).adminAudit();
    expect(calls.map((c) => headersOf(c)['x-tabula'])).toEqual([undefined]);
  });

  it('turns a forbidden answer into an ApiError', async () => {
    const { fetchFn } = recorder({ error: 'forbidden', message: 'Admins only' }, 403);
    await expect(createApi(fetchFn).adminOverview()).rejects.toBeInstanceOf(ApiError);
  });

  it('keeps the status and code of a forbidden answer', async () => {
    const { fetchFn } = recorder({ error: 'forbidden' }, 403);
    await expect(createApi(fetchFn).adminOverview()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('focusTarget', () => {
  const rows = (...ids: string[]) => ids.flatMap((id) => [`${id}:role`, `${id}:signout`, `${id}:toggle`, `${id}:remove`]);

  it('keeps focus on the same control when it is still there', () => {
    expect(focusTarget(rows('a', 'b'), 'b:toggle', rows('a', 'b'))).toBe('b:toggle');
  });

  it('moves to the same control of the next row when the row is gone', () => {
    expect(focusTarget(rows('a', 'b', 'c'), 'b:remove', rows('a', 'c'))).toBe('c:remove');
  });

  it('moves to the new last row when the last row is gone', () => {
    expect(focusTarget(rows('a', 'b'), 'b:remove', rows('a'))).toBe('a:remove');
  });

  it('finds nothing when no row has that control any more', () => {
    expect(focusTarget(rows('a'), 'a:remove', [])).toBeUndefined();
    expect(focusTarget(['a:remove'], 'a:remove', ['b:role'])).toBeUndefined();
  });

  it('skips a row whose control is not focusable', () => {
    // b's Remove is disabled, so it is not in the list: focus moves past it to c
    expect(focusTarget(['a:remove', 'c:remove'], 'a:remove', ['c:remove'])).toBe('c:remove');
  });
});

describe('deviceLabel', () => {
  const ua = {
    chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
    safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
    edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    operaWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0',
  };

  it('names the browser and the system', () => {
    expect(deviceLabel(ua.chromeMac)).toBe('Chrome on macOS');
    expect(deviceLabel(ua.safariMac)).toBe('Safari on macOS');
    expect(deviceLabel(ua.safariIphone)).toBe('Safari on iOS');
    expect(deviceLabel(ua.chromeIphone)).toBe('Chrome on iOS');
    expect(deviceLabel(ua.edgeWindows)).toBe('Edge on Windows');
    expect(deviceLabel(ua.operaWindows)).toBe('Opera on Windows');
    expect(deviceLabel(ua.firefoxLinux)).toBe('Firefox on Linux');
    expect(deviceLabel(ua.chromeAndroid)).toBe('Chrome on Android');
  });

  it('falls back for sessions without one, and for clients that are not browsers', () => {
    expect(deviceLabel(null)).toBe('Unknown device');
    expect(deviceLabel('   ')).toBe('Unknown device');
    expect(deviceLabel('node')).toBe('node');
    expect(deviceLabel('curl/8.9.1')).toBe('curl');
  });
});

describe('overviewTiles', () => {
  const overview: AdminOverview = {
    members: { total: 10, active: 8, disabled: 2, byRole: { owner: 1, admin: 1, member: 8, guest: 0 } },
    teams: { total: 2, archived: 1 },
    boards: { total: 61, deleted: 3 },
    sessions: { active: 9 },
    signIns7d: 14,
    live: { rooms: 1, connections: 3 },
    instance: { authEnabled: true, baseUrl: 'http://localhost', mail: 'log', version: '0.1.0' },
  };
  const tile = (label: string) => overviewTiles(overview).find((t) => t.label === label)!;

  it('counts every member, so the role breakdown adds up to the number', () => {
    expect(tile('Members')).toEqual({ label: 'Members', value: 10, sub: '1 owner · 1 admin · 8 members · 0 guests' });
    expect(tile('Disabled members')).toEqual({ label: 'Disabled members', value: 2, sub: '8 active' });
  });

  it('counts teams and boards the same way, with the archived and deleted ones under the number', () => {
    expect(tile('Teams')).toMatchObject({ value: 2, sub: '1 archived' });
    expect(tile('Boards')).toMatchObject({ value: 61, sub: '3 deleted' });
  });

  it('keeps the activity tiles', () => {
    expect(overviewTiles(overview).map((t) => t.label)).toEqual(
      ['Members', 'Disabled members', 'Teams', 'Boards', 'Active sessions', 'Sign-ins, last 7 days', 'Live connections']);
    expect(tile('Live connections')).toMatchObject({ value: 3, sub: '1 room open' });
  });
});

describe('visibleAdminTabs', () => {
  it('shows Chat only where the server has chat', () => {
    expect(visibleAdminTabs(ADMIN_TABS, true, 'owner', true)).toContain('chat');
    expect(visibleAdminTabs(ADMIN_TABS, true, 'owner', false)).not.toContain('chat');
    expect(visibleAdminTabs(ADMIN_TABS, true, 'admin')).not.toContain('chat');
    expect(visibleAdminTabs(ADMIN_TABS, true, 'admin', true)).toContain('chat');
  });

  it('shows Access tokens only when AI tool access is on', () => {
    expect(visibleAdminTabs(ADMIN_TABS, true, 'owner', true, true)).toEqual([...ADMIN_TABS]);
    expect(visibleAdminTabs(ADMIN_TABS, undefined, 'owner', true)).not.toContain('tokens');
    expect(visibleAdminTabs(ADMIN_TABS, false, 'owner', true, true)).toEqual(ADMIN_TABS.filter((t) => t !== 'tokens'));
  });

  it('shows Backups to owners only', () => {
    expect(visibleAdminTabs(ADMIN_TABS, true, 'owner', true, true)).toContain('backups');
    for (const role of ['admin', 'member', 'guest', undefined] as const) {
      expect(visibleAdminTabs(ADMIN_TABS, true, role, true, true), `${role}`).not.toContain('backups');
      expect(visibleAdminTabs(ADMIN_TABS, true, role, true, true)).toEqual(ADMIN_TABS.filter((t) => t !== 'backups'));
    }
  });

  it('shows Settings only on hosted workspaces, to owners and admins', () => {
    expect(visibleAdminTabs(ADMIN_TABS, undefined, 'owner', false)).not.toContain('settings');
    for (const role of ['owner', 'admin'] as const) {
      expect(visibleAdminTabs(ADMIN_TABS, undefined, role, false, true)).toContain('settings');
    }
  });
});
