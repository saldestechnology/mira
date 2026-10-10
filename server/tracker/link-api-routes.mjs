import { OpsError } from './shared.mjs';
import {
  createTicketForCard, linkKanban, listLinks, storeLinkIdempotencyResult, suggestMapping, unlinkKanban,
} from './links.mjs';
import {
  drainTicketProjection, writeTrackerContainerLink, writeTrackerContainerUnlink,
} from './projection.mjs';

const actorFor = (user) => ({ type: 'user', userId: user.id, user });

function querySingle(query, name) {
  const values = query.getAll(name);
  if (values.length > 1) throw new OpsError('invalid_input', 'Must be supplied once', name);
  return values[0];
}

function allowFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new OpsError('invalid_input', 'Unsupported field', key);
  }
}

function withoutReplay(value) {
  const { replayed: _replayed, ...result } = value;
  return result;
}

/** Tracker link routes use the same auth, CSRF, cloud read-only and mutation limiter as ticket routes. */
export function createTrackerLinkRoutes({
  directory, compile, audit, now = Date.now, roomAccess, baseUrl = 'http://localhost',
} = {}) {
  const routes = [];

  routes.push(compile('GET', 'tracker/links', { trackerLink: true }, ({ user, query }) => {
    const boardId = querySingle(query, 'boardId');
    const kanbanId = querySingle(query, 'kanbanId');
    return [200, listLinks({ directory, actor: actorFor(user), boardId, ...(kanbanId === undefined ? {} : { kanbanId }) })];
  }));

  routes.push(compile('GET', 'tracker/links/suggest', { trackerLink: true }, ({ user, query }) => {
    const boardId = querySingle(query, 'boardId');
    const kanbanId = querySingle(query, 'kanbanId');
    return [200, suggestMapping({ directory, actor: actorFor(user), boardId, kanbanId, roomAccess })];
  }));

  routes.push(compile('POST', 'tracker/links', {
    trackerLink: true, trackerMutation: true, body: true,
  }, ({ user, body }) => {
    allowFields(body, new Set(['boardId', 'kanbanId', 'mapping', 'createTickets', 'project', 'labels', 'idempotencyKey']));
    const actor = actorFor(user);
    const created = linkKanban({
      directory, actor, boardId: body.boardId, kanbanId: body.kanbanId, mapping: body.mapping,
      createTickets: Object.hasOwn(body, 'createTickets') ? body.createTickets : false, project: body.project, labels: body.labels,
      idempotencyKey: body.idempotencyKey, roomAccess, now: now(),
    });
    if (created.replayed) return [201, withoutReplay(created)];

    const linkId = created.link.id;
    let projectionPending = false;
    try {
      const trackerId = directory.db.prepare('SELECT id FROM trackers ORDER BY created_at, id LIMIT 1').get()?.id;
      if (!trackerId) throw new Error('Default tracker seed is missing');
      writeTrackerContainerLink({
        roomAccess, boardId: created.link.boardId, kanbanId: created.link.kanbanId,
        trackerId, map: Object.fromEntries(created.link.mapping.map((pair) => [pair.laneId, pair.stateKey])), now: now(),
      });
    } catch {
      projectionPending = true;
    }
    const drained = drainTicketProjection({ directory, roomAccess, boardId: created.link.boardId, baseUrl, now: now() });
    projectionPending ||= drained.projectionPending;
    const result = { ...created, projectionPending };
    storeLinkIdempotencyResult({ directory, linkId, result });
    audit(user, 'tracker.link.create', {
      linkId, boardId: created.link.boardId, kanbanId: created.link.kanbanId, created: created.created.length,
    });
    return [201, result];
  }));

  routes.push(compile('DELETE', 'tracker/links/:id', {
    trackerLink: true, trackerMutation: true,
  }, ({ user, params }) => {
    const removed = unlinkKanban({ directory, actor: actorFor(user), linkId: params.id, now: now() });
    let projectionPending = false;
    try {
      writeTrackerContainerUnlink({ roomAccess, boardId: removed.link.boardId, kanbanId: removed.link.kanbanId, now: now() });
    } catch {
      projectionPending = true;
    }
    const drained = drainTicketProjection({ directory, roomAccess, boardId: removed.link.boardId, baseUrl, now: now() });
    projectionPending ||= drained.projectionPending;
    audit(user, 'tracker.link.delete', { linkId: removed.link.id, boardId: removed.link.boardId, kanbanId: removed.link.kanbanId });
    const { actorId: _actorId, ...linkResult } = removed;
    return [200, { ...linkResult, projectionPending }];
  }));

  routes.push(compile('POST', 'tracker/links/:id/cards', {
    trackerLink: true, trackerMutation: true, body: true,
  }, ({ user, params, body }) => {
    allowFields(body, new Set(['cardId', 'idempotencyKey']));
    const actor = actorFor(user);
    const result = createTicketForCard({
      directory, actor, linkId: params.id, cardId: body.cardId,
      idempotencyKey: body.idempotencyKey, roomAccess, now: now(),
    });
    const boardId = result.ticket.links?.find((link) => link.kind === 'card' && link.cardId === result.cardId)?.boardId;
    const drained = drainTicketProjection({ directory, roomAccess, ...(boardId ? { boardId } : {}), ticketId: result.ticket.id, baseUrl, now: now() });
    if (!result.replayed) audit(user, 'tracker.link.card', { ticketId: result.ticket.id, cardId: result.cardId });
    return [201, { ticket: result.ticket, cardId: result.cardId, projectionPending: drained.projectionPending }];
  }));

  return routes;
}
