import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { OpsError } from '../server/tracker/shared.mjs';
import { createTrackerRoutes } from '../server/tracker/api-routes.mjs';

const opened: ReturnType<typeof openDirectory>[] = [];

function fixture() {
  const directory = openDirectory(':memory:');
  opened.push(directory);
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner Person', role: 'owner' })!;
  const member = directory.createUser({ email: 'member@example.com', name: 'Member Person', role: 'member' })!;
  const audit = (user: { id: string }, action: string, detail: any) => directory.audit(user.id, action, detail);
  const routes = createTrackerRoutes({
    directory,
    audit,
    now: () => 100,
    compile: (method: string, pattern: string, options: Record<string, unknown>, handler: (...args: any[]) => unknown) => ({
      method, parts: pattern.split('/'), handler, ...options,
    }),
  });
  const call = (method: string, pathname: string, user = owner, body: Record<string, unknown> = {}, query = new URLSearchParams()) => {
    const segments = pathname.split('/');
    const route = routes.find((candidate: any) => candidate.method === method
      && candidate.parts.length === segments.length
      && candidate.parts.every((part: string, index: number) => part.startsWith(':') || part === segments[index])) as any;
    if (!route) throw new Error(`route not found: ${method} ${pathname}`);
    const params: Record<string, string> = {};
    route.parts.forEach((part: string, index: number) => {
      if (part.startsWith(':')) params[part.slice(1)] = segments[index];
    });
    return route.handler({ user, params, body, query });
  };
  return { directory, owner, member, call };
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker REST route handlers', () => {
  it('returns ticket commands through the session route shapes and resolves aliases', () => {
    const { directory, owner, member, call } = fixture();
    const [metaStatus, meta] = call('GET', 'tracker/meta') as [number, any];
    expect(metaStatus).toBe(200);
    expect(meta.me).toEqual({ userId: owner.id, canWrite: true, canCreate: true });
    expect(meta.members.every((row: any) => !Object.hasOwn(row, 'email'))).toBe(true);

    const [createdStatus, createdPayload] = call('POST', 'tracker/tickets', owner, {
      title: 'Route handler ticket', assigneeId: member.id, idempotencyKey: 'route-handler-create-1',
    }) as [number, any];
    expect(createdStatus).toBe(201);
    const ticket = createdPayload.ticket;
    expect(ticket.assignee).toEqual({ userId: member.id, name: member.name });

    const [listStatus, listed] = call('GET', 'tracker/tickets', owner, {}, new URLSearchParams('filter=state%3Atodo')) as [number, any];
    expect(listStatus).toBe(200);
    expect(listed.tickets.map((row: any) => row.id)).toContain(ticket.id);
    const [searchStatus, searched] = call('GET', 'tracker/tickets', owner, {}, new URLSearchParams('q=handler')) as [number, any];
    expect(searchStatus).toBe(200);
    expect(searched.tickets[0].snippet).toContain('<mark>handler</mark>');

    const alias = 'legacy-import-11';
    directory.db.prepare(
      `INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, display_key, created_at)
       VALUES ('route-handler-alias', ?, 'legacy', ?, 'LEGACY-11', 101)`,
    ).run(ticket.id, alias);
    const [detailStatus, detail] = call('GET', `tracker/tickets/${alias}`) as [number, any];
    expect(detailStatus).toBe(200);
    expect(detail).toMatchObject({ ticket: { key: ticket.key }, resolvedKey: ticket.key, comments: [], events: [{ eventType: 'created' }], subscribed: true });

    const [commentStatus, commentPayload] = call('POST', `tracker/tickets/${ticket.key}/comments`, owner, { body: 'Route comment', clientId: 'route-comment-1' }) as [number, any];
    expect(commentStatus).toBe(201);
    expect(commentPayload.comment).toMatchObject({ author: owner.name, body: 'Route comment' });
    const [subscriptionStatus, subscription] = call('PUT', `tracker/tickets/${ticket.key}/subscription`) as [number, any];
    expect(subscriptionStatus).toBe(200);
    expect(subscription).toEqual({ subscribed: true });
    expect(call('GET', `tracker/tickets/${ticket.key}`)).toMatchObject([200, { subscribed: true }]);
    expect(call('DELETE', `tracker/tickets/${ticket.key}/subscription`)).toMatchObject([200, { subscribed: false }]);
    expect(call('POST', `tracker/tickets/${ticket.key}/transition`, owner, { state: 'Done' })).toMatchObject([200, { ticket: { state: { key: 'done' } } }]);

    const [feedStatus, feed] = call('GET', 'tracker/feed', owner, {}, new URLSearchParams('since=1')) as [number, any];
    expect(feedStatus).toBe(200);
    expect(feed.events.map((event: any) => event.eventType)).toContain('commented');
    expect(feed.events).toHaveLength(2);
    expect(feed.events[0].id).toBeLessThan(feed.events[1].id);

    const auditRows = directory.listAudit(100).filter((row: any) => row.action.startsWith('tracker.ticket.'));
    expect(auditRows.map((row: any) => row.action)).toEqual(expect.arrayContaining([
      'tracker.ticket.create', 'tracker.ticket.comment', 'tracker.ticket.unsubscribe', 'tracker.ticket.transition',
    ]));
    expect(auditRows.every((row: any) => Object.keys(row.detail).every((key) => ['ticketId', 'commentId'].includes(key)))).toBe(true);
    expect(JSON.stringify(auditRows)).not.toContain('Route handler ticket');
    expect(JSON.stringify(auditRows)).not.toContain('Route comment');
  });

  it('returns the current ticket on stale update conflicts and maps command errors to typed OpsErrors', () => {
    const { owner, call } = fixture();
    const [, made] = call('POST', 'tracker/tickets', owner, { title: 'Conflict ticket', idempotencyKey: 'route-conflict-create' }) as [number, any];
    const ticket = made.ticket;
    call('PATCH', `tracker/tickets/${ticket.key}`, owner, { title: 'Current title', ifUpdatedSeq: ticket.updatedSeq });
    let stale: any;
    try {
      call('PATCH', `tracker/tickets/${ticket.key}`, owner, { title: 'Stale title', ifUpdatedSeq: ticket.updatedSeq });
    } catch (error) { stale = error; }
    expect(stale).toBeInstanceOf(OpsError);
    expect(stale).toMatchObject({ code: 'conflict', ticket: { id: ticket.id, title: 'Current title' } });

    let invalidFilter: any;
    try { call('GET', 'tracker/tickets', owner, {}, new URLSearchParams('filter=bogus%3Ax')); } catch (error) { invalidFilter = error; }
    expect(invalidFilter).toMatchObject({ code: 'invalid_filter', path: 'bogus:x' });
  });

  it('serves slice 3b resources, comment lifecycle, relations, bulk updates and row extras', () => {
    const { directory, owner, member, call } = fixture();
    const [labelStatus, labelPayload] = call('POST', 'tracker/labels', owner, { name: 'Route 3b label', color: '#123456' }) as [number, any];
    expect(labelStatus).toBe(201);
    expect(call('GET', 'tracker/labels', owner)).toMatchObject([200, { labels: [expect.objectContaining({ id: labelPayload.label.id })] }]);

    const [projectStatus, projectPayload] = call('POST', 'tracker/projects', owner, { name: 'Route 3b project', ownerId: member.id }) as [number, any];
    expect(projectStatus).toBe(201);
    expect(projectPayload.project).toMatchObject({ owner: { userId: member.id, name: member.name }, ticketCount: 0, doneCount: 0 });
    const [milestoneStatus, milestonePayload] = call('POST', `tracker/projects/${projectPayload.project.id}/milestones`, owner, {
      name: 'Route 3b milestone', due: '2026-11-01',
    }) as [number, any];
    expect(milestoneStatus).toBe(201);

    const [, firstPayload] = call('POST', 'tracker/tickets', owner, { title: 'Route 3b first', idempotencyKey: 'route-3b-first-key' }) as [number, any];
    const [, secondPayload] = call('POST', 'tracker/tickets', owner, { title: 'Route 3b second', idempotencyKey: 'route-3b-second-key' }) as [number, any];
    const first = firstPayload.ticket;
    const second = secondPayload.ticket;
    call('PATCH', `tracker/tickets/${first.key}`, owner, {
      project: projectPayload.project.name, milestone: milestonePayload.milestone.name,
    });
    call('PATCH', `tracker/tickets/${first.key}`, owner, { state: 'done' });
    const [relationStatus, relationPayload] = call('POST', `tracker/tickets/${first.key}/relations`, owner, {
      relation: 'blocks', otherKey: second.key,
    }) as [number, any];
    expect(relationStatus).toBe(200);
    expect(relationPayload.ticket.relations).toContainEqual({ kind: 'blocks', key: second.key });
    const cycle = (() => {
      try { call('POST', `tracker/tickets/${second.key}/relations`, owner, { relation: 'blocks', otherKey: first.key }); }
      catch (error) { return error as OpsError; }
      throw new Error('expected relation cycle conflict');
    })();
    expect(cycle).toMatchObject({ code: 'conflict', ticket: { id: second.id } });
    expect(call('DELETE', `tracker/tickets/${first.key}/relations`, owner, {}, new URLSearchParams(`relation=blocks&otherKey=${second.key}`)))
      .toMatchObject([200, { ticket: { relations: [] } }]);

    const [viewStatus, viewPayload] = call('POST', 'tracker/views', owner, { name: 'Route 3b view', filter: [], shared: true }) as [number, any];
    expect(viewStatus).toBe(201);
    expect(viewPayload.view).toMatchObject({ owner: { name: owner.name }, ownerName: owner.name, mine: true, shared: true });
    expect(call('GET', `tracker/views/${viewPayload.view.id}/tickets`, member)).toMatchObject([200, { view: { mine: false }, tickets: expect.any(Array) }]);
    let ownerOnly: any;
    try { call('PATCH', `tracker/views/${viewPayload.view.id}`, member, { name: 'Forbidden update' }); }
    catch (error) { ownerOnly = error; }
    expect(ownerOnly).toMatchObject({ code: 'forbidden' });

    const [commentStatus, commentPayload] = call('POST', `tracker/tickets/${first.key}/comments`, member, { body: 'route comment text' }) as [number, any];
    expect(commentStatus).toBe(201);
    const [editStatus, editedPayload] = call('PATCH', `tracker/tickets/${first.key}/comments/${commentPayload.comment.id}`, member, { body: 'route comment updated' }) as [number, any];
    expect(editStatus).toBe(200);
    expect(editedPayload.comment).toMatchObject({ body: 'route comment updated', edited: true, deleted: false, actorType: 'user' });
    const [deleteStatus, deletedPayload] = call('DELETE', `tracker/tickets/${first.key}/comments/${commentPayload.comment.id}`, owner) as [number, any];
    expect(deleteStatus).toBe(200);
    expect(deletedPayload.comment).toMatchObject({ deleted: true });
    expect(deletedPayload.comment).not.toHaveProperty('body');

    const [bulkStatus, bulkPayload] = call('POST', 'tracker/tickets/bulk', owner, {
      keys: [second.key, 'TAB-404'], patch: { priority: 'high', labelsAdd: ['Route 3b label'] },
    }) as [number, any];
    expect(bulkStatus).toBe(200);
    expect(bulkPayload.results).toMatchObject([
      { key: second.key, ok: true, before: { priority: 'none', labels: [] }, ticket: { priority: 'high', commentCount: 0, prs: null } },
      { key: 'TAB-404', ok: false, error: { error: 'not_found' } },
    ]);
    const batchEvent = directory.db.prepare("SELECT details_json FROM ticket_events WHERE ticket_id = ? AND json_extract(details_json, '$.batchId') = ?")
      .get(second.id, bulkPayload.batchId) as { details_json: string } | undefined;
    expect(batchEvent).toBeDefined();
    expect(JSON.parse(batchEvent!.details_json)).toEqual({ batchId: bulkPayload.batchId });

    expect(call('GET', `tracker/tickets/${first.key}`, owner)).toMatchObject([200, {
      ticket: { project: { id: projectPayload.project.id }, milestone: { id: milestonePayload.milestone.id }, commentCount: 0, prs: null },
      comments: [expect.objectContaining({ id: commentPayload.comment.id, edited: true, deleted: true })],
    }]);
    expect(call('GET', 'tracker/projects', owner)).toMatchObject([200, {
      projects: [expect.objectContaining({ id: projectPayload.project.id, ticketCount: 1, doneCount: 1 })],
    }]);
    expect(call('GET', `tracker/projects/${projectPayload.project.id}/milestones`, owner)).toMatchObject([200, {
      milestones: [expect.objectContaining({ id: milestonePayload.milestone.id, ticketCount: 1, doneCount: 1 })],
    }]);
    expect(call('POST', `tracker/tickets/${second.key}/archive`, owner)).toMatchObject([200, { ticket: { archivedAt: 100 } }]);
    expect(call('POST', `tracker/tickets/${second.key}/restore`, owner)).toMatchObject([200, { ticket: { archivedAt: null } }]);
    expect(call('DELETE', `tracker/views/${viewPayload.view.id}`, owner)).toMatchObject([204]);

    const [metaStatus, meta] = call('GET', 'tracker/meta', owner) as [number, any];
    expect(metaStatus).toBe(200);
    expect(meta).toMatchObject({
      projects: [expect.objectContaining({ id: projectPayload.project.id })],
      milestones: [expect.objectContaining({ id: milestonePayload.milestone.id, projectId: projectPayload.project.id })],
      views: [], me: { canWrite: true, canCreate: true },
    });
  });
});
