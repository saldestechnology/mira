import type { TrackerEvent } from '../../tracker-types';

export type EventActorKind = 'person' | 'agent' | 'github' | 'import';
export type EventIcon = 'state' | 'assignee' | 'relation' | 'link' | 'update' | 'comment' | 'archive' | 'created';

export interface TicketEventDescription {
  text: string;
  actor: { kind: EventActorKind; name: string };
  icon: EventIcon;
}

export interface TicketEventContext {
  ticketKey?: string;
  members?: readonly { userId: string; name: string }[];
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function label(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  const fields = object(value);
  for (const key of ['name', 'title', 'key', 'state', 'label']) if (typeof fields[key] === 'string') return fields[key] as string;
  return value === null ? 'None' : 'a value';
}

function eventActor(event: TrackerEvent, ctx: TicketEventContext): TicketEventDescription['actor'] {
  const actor = object(event.actor);
  const kind = String(actor.kind ?? actor.type ?? '').toLocaleLowerCase();
  const provider = String(actor.provider ?? '').toLocaleLowerCase();
  const actorId = typeof actor.userId === 'string' ? actor.userId : typeof actor.id === 'string' ? actor.id : '';
  const explicitName = typeof actor.name === 'string' && actor.name.trim() ? actor.name : '';
  const memberName = ctx.members?.find((member) => member.userId === actorId)?.name;
  const name = explicitName || memberName || '';
  const source = String(event.source ?? '').toLocaleLowerCase();
  if (kind === 'agent' || kind === 'mcp_token' || kind === 'token') {
    const token = typeof actor.tokenId === 'string' ? actor.tokenId : explicitName || actorId || 'agent';
    return { kind: 'agent', name: `Agent · ${token}` };
  }
  if (kind === 'import' || provider === 'linear' || source === 'import') return { kind: 'import', name: explicitName ? `Import · ${explicitName}` : 'Import' };
  if (provider === 'github' || kind === 'integration' || source === 'integration') return { kind: 'github', name: explicitName || (provider === 'github' ? 'GitHub' : 'Integration') };
  if (kind === 'system') return { kind: 'import', name: name || 'System' };
  return { kind: 'person', name: name || 'A teammate' };
}

function relationText(value: unknown): string {
  const relation = object(value);
  const kind = String(relation.kind ?? 'relates_to');
  const key = typeof relation.key === 'string' ? ` ${relation.key}` : '';
  const words: Record<string, string> = {
    blocks: 'blocks', blocked_by: 'is blocked by', relates_to: 'is related to', duplicates: 'duplicates', duplicated_by: 'is a duplicate of',
  };
  return `${words[kind] ?? 'is related to'}${key}`;
}

/** Pure one-line copy for a history event. */
export function describeEvent(event: TrackerEvent, ctx: TicketEventContext = {}): TicketEventDescription {
  const actor = eventActor(event, ctx);
  const before = object(event.before);
  const after = object(event.after);
  const changes = Object.keys(after);
  const inferredField = changes.length === 1 ? changes[0] : undefined;
  const fieldName = typeof event.field === 'string' ? event.field : inferredField;
  const from = event.from ?? (fieldName ? before[fieldName] : undefined);
  const to = event.to ?? (fieldName ? after[fieldName] : undefined);
  const field = typeof event.field === 'string' ? event.field.replace(/([A-Z])/g, ' $1').toLocaleLowerCase() : '';
  const name = actor.name;
  switch (event.eventType) {
    case 'ticket.created':
    case 'created': return { text: `${name} created this ticket`, actor, icon: 'created' };
    case 'ticket.state_changed':
    case 'transitioned': return { text: `${name} moved it from ${label(from)} to ${label(to)}`, actor, icon: 'state' };
    case 'ticket.assigned': return { text: `${name} assigned it to ${label(to ?? event.assignee)}`, actor, icon: 'assignee' };
    case 'ticket.updated':
    case 'updated': {
      if (fieldName === 'assignee') return { text: `${name} assigned it to ${label(to)}`, actor, icon: 'assignee' };
      if (fieldName === 'state') return { text: `${name} moved it from ${label(from)} to ${label(to)}`, actor, icon: 'state' };
      if (fieldName && (event.field || inferredField)) return { text: `${name} changed ${fieldName.replace(/([A-Z])/g, ' $1').toLocaleLowerCase()} from ${label(from)} to ${label(to)}`, actor, icon: 'update' };
      if (field) return { text: `${name} changed ${field} from ${label(from)} to ${label(to)}`, actor, icon: 'update' };
      const fields = changes.filter((key) => key !== 'updatedAt' && key !== 'updatedSeq');
      return { text: fields.length ? `${name} updated ${fields.join(', ')}` : `${name} updated this ticket`, actor, icon: 'update' };
    }
    case 'ticket.related':
    case 'related': return { text: `${name} linked a ticket that ${relationText(event.relation)}`, actor, icon: 'relation' };
    case 'ticket.unrelated':
    case 'unrelated': return { text: `${name} removed the relation to a ticket that ${relationText(event.relation)}`, actor, icon: 'relation' };
    case 'ticket.card_linked': return { text: `${name} linked a card to this ticket`, actor, icon: 'link' };
    case 'ticket.card_unlinked': return { text: `${name} unlinked a card from this ticket`, actor, icon: 'link' };
    case 'link.pr_opened': return { text: `${name} opened PR #${label(event.number ?? to)}`, actor, icon: 'link' };
    case 'link.pr_ready': return { text: `${name} marked PR #${label(event.number ?? to)} ready for review`, actor, icon: 'link' };
    case 'link.pr_merged': return { text: `${name} merged PR #${label(event.number ?? to)}`, actor, icon: 'link' };
    case 'link.pr_closed': return { text: `${name} closed PR #${label(event.number ?? to)}`, actor, icon: 'link' };
    case 'link.commit_added': return { text: `${name} added commit ${label(event.sha ?? to)}`, actor, icon: 'link' };
    case 'integration.rule_applied': return { text: `${name} applied a rule and moved it from ${label(from)} to ${label(to)}`, actor, icon: 'state' };
    case 'ticket.commented':
    case 'commented': return { text: `${name} commented`, actor, icon: 'comment' };
    case 'ticket.comment_edited': return { text: `${name} edited a comment`, actor, icon: 'comment' };
    case 'comment_edited': return { text: `${name} edited a comment`, actor, icon: 'comment' };
    case 'ticket.comment_deleted': return { text: `${name} deleted a comment`, actor, icon: 'comment' };
    case 'comment_deleted': return { text: `${name} deleted a comment`, actor, icon: 'comment' };
    case 'ticket.archived':
    case 'archived': return { text: `${name} archived this ticket`, actor, icon: 'archive' };
    case 'ticket.restored':
    case 'restored': return { text: `${name} restored this ticket`, actor, icon: 'archive' };
    default: return { text: `${name} updated this ticket`, actor, icon: 'update' };
  }
}
