import { actorInfo, forbidden, notFound } from './shared.mjs';

/** Return read/write for an authorized actor; conceal missing and inaccessible tickets alike. */
export function ticketAccess(actor, ticket, options = {}) {
  if (!ticket) throw notFound();
  let info;
  try {
    info = actorInfo(actor);
  } catch {
    throw notFound();
  }
  if (!actor || info.disabled || !info.id && info.type !== 'system') throw notFound();

  if (info.type === 'mcp_token') {
    if (!['read', 'write'].includes(info.trackerScope)) throw notFound();
    if (!info.userId || !['owner', 'admin', 'member', 'viewer'].includes(info.role)) {
      throw notFound();
    }
    if (info.role === 'viewer' || info.trackerScope === 'read') return 'read';
    return 'write';
  }

  if (info.type === 'system') {
    if (actor?.ticketAccess === 'write') return 'write';
    if (actor?.ticketAccess === 'read') return 'read';
    throw notFound();
  }

  if (['owner', 'admin', 'member'].includes(info.role)) return 'write';
  if (info.role === 'viewer') return 'read';
  if (info.role === 'guest' || info.role === null) {
    const boardRole = typeof options.boardAccess === 'function'
      ? options.boardAccess(ticket.id, info.id)
      : null;
    if (boardRole === 'read' || boardRole === 'write') return 'read';
  }
  throw notFound();
}

export function requireTicketRead(actor, ticket, options = {}) {
  ticketAccess(actor, ticket, options);
}

export function requireTicketWrite(actor, ticket, options = {}) {
  if (ticketAccess(actor, ticket, options) !== 'write') throw forbidden('This ticket is read-only for this actor.');
}

export function recipientActor(userRow) {
  return {
    type: 'user',
    id: userRow.id,
    role: userRow.role,
    workspaceRole: userRow.role,
    disabled: Boolean(userRow.disabled),
  };
}

/** Resolve ticket board links when the linked-kanban migration is present. */
export function boardAccessForDirectory(directory) {
  const db = directory?.db ?? directory;
  if (!db || typeof db.prepare !== 'function') return null;
  const linked = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ticket_links'").get();
  if (!linked) return null;
  return (ticketId, userId) => {
    const links = db.prepare(
      'SELECT board_id FROM ticket_links WHERE ticket_id = ? AND removed_at IS NULL ORDER BY board_id',
    ).all(ticketId);
    for (const link of links) {
      const role = directory.boardRole(link.board_id, userId);
      if (role === 'owner' || role === 'editor') return 'write';
      if (role === 'viewer' || role === 'commenter') return 'read';
    }
    return null;
  };
}
