import './tracker.css';
import './ticket-page.css';
import {
  TrackerError, isValidDueDate,
  type TrackerComment, type TrackerEvent, type TrackerMeta, type TrackerRelationKind,
  type TrackerStore, type TrackerStoreSnapshot, type TrackerTicket, type TrackerTicketCache,
} from '../../tracker-data';
import { announce } from '../../ui/announce';
import { h } from '../../ui/dom';
import { actorBadgeGlyph, priorityLabel, stateGlyph } from './glyphs';
import { PLATFORM_MODIFIER, resolveKey, type PickerField } from './keys';
import { openPicker, type PickerOption, type PickerResult } from './picker';
import { avatar, dueChip, keyChip, labelChip, relativeTime } from './primitives';
import { ticketPath } from './keys-util';
import { buildMarkdownDom, renderMarkdownSafe } from './ticket-markdown';
import { describeEvent, type EventActorKind, type EventIcon } from './ticket-events';

export interface TicketPageOptions {
  store: TrackerStore;
  key: string;
  mode: 'page' | 'peek';
  onClose(): void;
  onNavigate(key: string): void;
  me: { userId: string; canWrite: boolean };
}

type ConflictField = keyof Pick<TrackerTicket, 'title' | 'description' | 'priority' | 'assignee' | 'labels' | 'due' | 'parent' | 'project' | 'milestone' | 'state'>;
type PatchConflictField = Exclude<ConflictField, 'state'>;
type PagePickerField = PickerField | 'milestone';
type ConflictValues = Partial<Record<ConflictField, unknown>>;
type FailedUpdate = { patch: Parameters<TrackerStore['updateTicket']>[1]; field?: PatchConflictField; mine?: unknown };
type ActivityItem = { kind: 'comment'; at: number; comment: TrackerComment } | { kind: 'event'; at: number; event: TrackerEvent };
type RelationSearch = { kind: TrackerRelationKind; query: string; results: TrackerTicket[]; loading: boolean; error?: string };

const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const;
const RELATION_LABELS: Record<TrackerRelationKind, string> = {
  blocks: 'Blocks', blocked_by: 'Blocked by', relates_to: 'Related to', duplicates: 'Duplicate of', duplicated_by: 'Duplicates',
};
const FIELD_NAMES: Record<ConflictField, string> = {
  title: 'Title', description: 'Description', state: 'State', priority: 'Priority', assignee: 'Assignee', labels: 'Labels', due: 'Due date',
  parent: 'Parent', project: 'Project', milestone: 'Milestone',
};
let localCommentSerial = 0;

function button(label: string, className: string, disabled: boolean, onClick: (event: MouseEvent) => void, focusId?: string): HTMLButtonElement {
  const el = h('button', {
    type: 'button', class: className, 'aria-label': label, disabled,
    ...(focusId ? { 'data-focus-id': focusId } : {}),
  });
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function actorVisual(kind: EventActorKind, name: string): HTMLElement {
  if (kind === 'person') return avatar({ kind: 'person', name });
  if (kind === 'agent' || kind === 'github' || kind === 'import') return avatar({ kind, name });
  return h('span', { class: 'trk-actor-badge', 'aria-label': name }, actorBadgeGlyph('import'), h('span', null, name));
}

function origin(ticket: TrackerTicket): { text: string; actor?: { kind: EventActorKind; name: string } } {
  if (ticket.source === 'import') return { text: 'Imported from Linear', actor: { kind: 'import', name: 'Import' } };
  if (ticket.source === 'integration' || ticket.creator.type === 'integration') {
    const provider = ticket.creator.name.toLocaleLowerCase().includes('github') ? 'GitHub' : ticket.creator.name || 'Integration';
    return { text: `Created from ${provider}`, actor: { kind: provider === 'GitHub' ? 'github' : 'import', name: provider } };
  }
  if (ticket.source === 'mcp' || ticket.creator.type === 'mcp_token') {
    return { text: `Created by agent ${ticket.creator.name}`, actor: { kind: 'agent', name: `Agent · ${ticket.creator.name}` } };
  }
  return { text: `Created by ${ticket.creator.name}`, actor: { kind: 'person', name: ticket.creator.name } };
}

function valueText(ticket: TrackerTicket, field: ConflictField): string {
  switch (field) {
    case 'title': return ticket.title;
    case 'description': return ticket.description || 'No description';
    case 'state': return ticket.state.name;
    case 'priority': return priorityLabel(ticket.priority);
    case 'assignee': return ticket.assignee?.name ?? 'No one';
    case 'labels': return ticket.labels.map((label) => label.name).join(', ') || 'No labels';
    case 'due': return ticket.due ?? 'No due date';
    case 'parent': return ticket.parent ?? 'No parent';
    case 'project': return ticket.project?.name ?? 'No project';
    case 'milestone': return ticket.milestone?.name ?? 'No milestone';
  }
}

function conflictText(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'None';
  if (Array.isArray(value)) return value.map((item) => typeof item === 'object' && item !== null && 'name' in item ? String(item.name) : String(item)).join(', ') || 'None';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.name ?? record.title ?? record.key ?? 'Updated value');
  }
  return String(value);
}

function timeAt(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toISOString();
}

function safeExternalUrl(value: string): string | null {
  try {
    const base = typeof location === 'undefined' || !location.origin ? 'https://tabula.invalid' : location.origin;
    const url = new URL(value, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function fieldPatch(field: PatchConflictField, value: unknown): Parameters<TrackerStore['updateTicket']>[1] {
  if (field === 'title' || field === 'description' || field === 'priority' || field === 'due' || field === 'parent' || field === 'project' || field === 'milestone') {
    return { [field]: value } as Parameters<TrackerStore['updateTicket']>[1];
  }
  if (field === 'assignee') {
    const assignee = typeof value === 'object' && value !== null && 'userId' in value ? String((value as { userId: unknown }).userId) : value === null ? null : String(value);
    return { assignee };
  }
  const labels = Array.isArray(value) ? value.map((label) => typeof label === 'object' && label !== null && 'name' in label ? String((label as { name: unknown }).name) : String(label)) : [];
  return { labels };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el !== 'object') return false;
  const tag = el.tagName?.toLocaleLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true ||
    Boolean(el.closest?.('[contenteditable="true"], [role="combobox"], [role="listbox"], .popover'));
}

function displayEventIcon(kind: EventIcon): string {
  const icons: Record<EventIcon, string> = {
    state: '◐', assignee: '◎', relation: '↔', link: '↗', update: '·', comment: '▤', archive: '□', created: '＋',
  };
  return icons[kind];
}

function eventActorKey(event: TrackerEvent): string {
  const actor = event.actor as (NonNullable<TrackerEvent['actor']> & { id?: string | null }) | null;
  return actor?.userId ?? actor?.id ?? actor?.name ?? actor?.type ?? '';
}

function eventChangedFields(event: TrackerEvent): string[] {
  if (typeof event.field === 'string') return [event.field];
  const after = event.after;
  return typeof after === 'object' && after !== null && !Array.isArray(after) ? Object.keys(after) : [];
}

function bellIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tk-bell-icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'square');
  svg.setAttribute('stroke-linejoin', 'miter');
  svg.setAttribute('aria-hidden', 'true');
  const bell = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  bell.setAttribute('d', 'M8 2.5a3 3 0 00-3 3v2.2c0 1.5-.5 2.5-1.5 3.3-.5.4-.2 1 .4 1h8.2c.6 0 .9-.6.4-1-1-.8-1.5-1.8-1.5-3.3V5.5a3 3 0 00-3-3zM6.5 14h3');
  svg.appendChild(bell);
  return svg;
}

/** Mounts a ticket page or in-frame peek. The store owns remote state; local editor values only live while an edit is open. */
export function mountTicketPage(host: HTMLElement, opts: TicketPageOptions): { destroy(): void; focus(): void } {
  const root = h('main', { class: `trk tk-page tk-page--${opts.mode}`, 'data-mode': opts.mode, 'aria-label': `Ticket ${opts.key}` });
  host.replaceChildren(root);
  let cache: TrackerTicketCache = opts.store.ticket(opts.key);
  let snapshot: TrackerStoreSnapshot = opts.store.snapshot();
  let destroyed = false;
  let refetchedSeq = -1;
  let titleEditing = false;
  let titleDraft = '';
  let descriptionEditing = false;
  let descriptionPreview = false;
  let descriptionDraft = '';
  let commentDraft = readCommentDraft(opts.key);
  let commentRetry: { body: string; clientId: string } | null = null;
  let commentError = '';
  let commentSending = false;
  let editingCommentId: string | null = null;
  let commentEditDraft = '';
  let commentActionError = '';
  let failedUpdate: FailedUpdate | null = null;
  let failedTransition: TrackerTicket['state'] | null = null;
  let selectedActivity: 'all' | 'comments' | 'history' = 'all';
  let loadingOlderPage = false;
  let menuOpen = false;
  let dueEditing = false;
  let parentEditing = false;
  let creatingLabel = false;
  let labelDraft = '';
  let labelCreateError = '';
  let relationSearch: RelationSearch | null = null;
  let localError = '';
  let descriptionError = '';
  let newComments = 0;
  let showLoadingSkeleton = false;
  const loadingTimer = window.setTimeout(() => {
    if (!destroyed) { showLoadingSkeleton = true; render(); }
  }, 200);
  let knownComments = new Set(cache.detail?.comments.map((comment) => comment.id) ?? []);
  const pendingMine: ConflictValues = {};
  const readonlyId = `tk-readonly-${Math.random().toString(36).slice(2)}`;
  const unsubscribeTicket = opts.store.watchTicket(opts.key, (next) => {
    if (next.detail || next.error) { window.clearTimeout(loadingTimer); showLoadingSkeleton = false; }
    const hadDetail = Boolean(cache.detail);
    const nextComments = new Set(next.detail?.comments.map((comment) => comment.id) ?? []);
    const activity = root.querySelector<HTMLElement>('.tk-activity-list');
    const wasAtBottom = !activity || activity.scrollHeight <= activity.clientHeight || activity.scrollHeight - activity.clientHeight - activity.scrollTop < 32;
    const arrived = [...nextComments].filter((id) => !knownComments.has(id) && !id.startsWith('pending:'));
    if (hadDetail && !loadingOlderPage && arrived.length) {
      if (!wasAtBottom) newComments += arrived.length;
      announce(`${arrived.length} new ${arrived.length === 1 ? 'comment' : 'comments'} on ${opts.key}.`);
    }
    knownComments = nextComments;
    cache = next;
    render();
  });
  const unsubscribeStore = opts.store.subscribe((next) => { snapshot = next; render(); });
  const onOnline = () => render();
  const onOffline = () => render();
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  void opts.store.loadTicket(opts.key).catch(() => undefined);
  void opts.store.loadMeta().then(() => { if (!destroyed) { snapshot = opts.store.snapshot(); render(); } }).catch(() => undefined);

  // List and poll rows are slim (no creator, labels, relations). The page needs the full ticket, so a slim copy is completed from the detail
  // and defaults, and the full ticket is fetched once for that updatedSeq. Without this a conflict plus a poll crashed the page.
  function ticket(): TrackerTicket | undefined {
    const raw = cache.ticket ?? cache.detail?.ticket;
    const detail = cache.detail?.ticket;
    if (!raw) return detail;
    const merged = !detail ? raw : raw.updatedSeq >= detail.updatedSeq ? { ...detail, ...raw } : detail;
    if (merged.creator && merged.labels && merged.relations && merged.links && merged.aliases) return merged;
    if (!destroyed && refetchedSeq !== merged.updatedSeq) {
      refetchedSeq = merged.updatedSeq;
      void opts.store.loadTicket(opts.key, true).catch(() => undefined);
    }
    return {
      ...merged,
      creator: merged.creator ?? { type: 'user', id: null, name: 'Unknown' },
      labels: merged.labels ?? [],
      relations: merged.relations ?? [],
      links: merged.links ?? [],
      aliases: merged.aliases ?? [],
      description: merged.description ?? '',
    };
  }
  function meta(): TrackerMeta | undefined { return snapshot.meta; }
  function archived(): boolean { return Boolean(ticket()?.archivedAt); }
  function canRestore(): boolean { return opts.me.canWrite && !snapshot.readOnly; }
  function canWrite(): boolean { return opts.me.canWrite && !snapshot.readOnly && !archived(); }
  function disabledReason(): string {
    if (archived()) return 'Restore this ticket before editing it.';
    if (snapshot.readOnly) return 'The tracker is read-only.';
    return 'You can read this tracker.';
  }
  function permissionReason(): string {
    return snapshot.readOnly ? 'The tracker is read-only.' : 'You can read this tracker.';
  }
  function describeDisabled<T extends HTMLElement>(control: T, disabled = true, reason = disabledReason()): T {
    if (disabled) {
      control.setAttribute('aria-description', reason);
      control.setAttribute('aria-describedby', readonlyId);
    }
    return control;
  }
  function fieldButton(label: string, name: string, onClick: (event: MouseEvent) => void, focusId?: string): HTMLButtonElement {
    const enabled = canWrite();
    const el = button(label, `tk-field-button${enabled ? '' : ' tk-disabled-value'}`, !enabled, onClick, focusId);
    if (!enabled) el.setAttribute('aria-description', disabledReason());
    if (!enabled) el.setAttribute('aria-describedby', readonlyId);
    el.dataset.field = name;
    return el;
  }
  function callUpdate(patch: Parameters<TrackerStore['updateTicket']>[1], field?: PatchConflictField, mine?: unknown, onSuccess?: () => void): void {
    localError = '';
    failedUpdate = null;
    failedTransition = null;
    if (field) pendingMine[field] = mine;
    void opts.store.updateTicket(opts.key, patch).then(() => {
      if (field) delete pendingMine[field];
      localError = '';
      failedUpdate = null;
      onSuccess?.();
      render();
    }).catch((error: unknown) => {
      if (error instanceof TrackerError && error.code === 'conflict') {
        if (field) pendingMine[field] = mine;
        announce('This ticket changed. Review the fields below.');
      } else {
        if (field) delete pendingMine[field];
        failedUpdate = { patch, field, mine };
        if (field === 'title') titleEditing = true;
        else if (field === 'description') descriptionEditing = true;
        else if (field === 'due') dueEditing = true;
        else if (field === 'parent') parentEditing = true;
        localError = error instanceof Error ? error.message : 'Could not save this change.';
      }
      render();
    });
  }
  function retryFailedSave(): void {
    if (failedUpdate) {
      const retry = failedUpdate;
      failedUpdate = null;
      if (retry.field === 'title') titleEditing = false;
      else if (retry.field === 'description') descriptionEditing = false;
      else if (retry.field === 'due') dueEditing = false;
      else if (retry.field === 'parent') parentEditing = false;
      let onSuccess: (() => void) | undefined;
      if (retry.patch.archived !== undefined) onSuccess = () => announce(retry.patch.archived ? 'Ticket archived.' : 'Ticket restored.');
      else if (retry.field === 'title') onSuccess = () => root.querySelector<HTMLElement>('[data-focus-id="ticket-title"]')?.focus();
      callUpdate(retry.patch, retry.field, retry.mine, onSuccess);
      return;
    }
    if (failedTransition) {
      const retry = failedTransition;
      failedTransition = null;
      saveField('state', retry);
    }
  }
  function editTitle(): void {
    const current = ticket();
    if (!current || !canWrite()) return;
    titleDraft = current.title;
    titleEditing = true;
    render();
    root.querySelector<HTMLInputElement>('[data-focus-id="title-input"]')?.focus();
  }
  function cancelTitle(): void {
    if (failedUpdate?.field === 'title') failedUpdate = null;
    localError = '';
    titleEditing = false;
    titleDraft = '';
    render();
    root.querySelector<HTMLElement>('[data-focus-id="ticket-title"]')?.focus();
  }
  function commitTitle(): void {
    const current = ticket();
    const value = Array.from(titleDraft.replace(/[\r\n]+/g, ' ')).slice(0, 200).join('').trim();
    if (!current || !value) { localError = 'Title is required.'; render(); return; }
    titleEditing = false;
    titleDraft = value;
    callUpdate({ title: value }, 'title', value, () => root.querySelector<HTMLElement>('[data-focus-id="ticket-title"]')?.focus());
  }
  function editDescription(): void {
    const current = ticket();
    if (!current || !canWrite()) return;
    descriptionDraft = current.description;
    descriptionEditing = true;
    descriptionPreview = false;
    descriptionError = '';
    render();
    root.querySelector<HTMLTextAreaElement>('[data-focus-id="description-input"]')?.focus();
  }
  function cancelDescription(): void {
    if (failedUpdate?.field === 'description') failedUpdate = null;
    localError = '';
    descriptionEditing = false;
    descriptionPreview = false;
    descriptionDraft = '';
    descriptionError = '';
    render();
  }
  function commitDescription(): void {
    const current = ticket();
    if (!current) return;
    const value = descriptionDraft;
    descriptionEditing = false;
    descriptionPreview = false;
    descriptionError = '';
    callUpdate({ description: value }, 'description', value);
  }
  function createTicketLabel(): void {
    const name = labelDraft.trim();
    if (!name) { labelCreateError = 'Enter a label name.'; render(); return; }
    void opts.store.createLabel(name).then((label) => {
      const current = ticket();
      creatingLabel = false;
      labelDraft = '';
      labelCreateError = '';
      if (current) saveField('labels', [...current.labels.map((item) => item.name), label.name]);
      else render();
      announce(`Created label ${label.name}.`);
    }).catch((error: unknown) => {
      labelCreateError = error instanceof Error ? error.message : 'Could not create the label.';
      render();
    });
  }
  function toggleSubscribe(): void {
    const current = ticket();
    if (!current || !canWrite()) return;
    void opts.store.setSubscription(opts.key, !(cache.subscribed ?? cache.detail?.subscribed ?? false)).then((subscribed) => {
      announce(subscribed ? 'Subscribed to this ticket.' : 'Unsubscribed from this ticket.');
    }).catch((error: unknown) => { localError = error instanceof Error ? error.message : 'Could not update subscription.'; render(); });
  }
  function copyText(text: string): void {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard?.writeText) void clipboard.writeText(text).then(() => announce('Copied to clipboard.')).catch(() => announce(text));
    else {
      const temp = h('textarea', { class: 'tk-sr-only', readonly: true, tabindex: '-1', 'aria-hidden': 'true' });
      temp.value = text;
      document.body.appendChild(temp);
      temp.select?.();
      const doc = document as Document & { execCommand?: (command: string) => boolean };
      const copied = doc.execCommand?.('copy') ?? false;
      temp.remove();
      announce(copied ? 'Copied to clipboard.' : text);
    }
  }
  function copyLink(): void {
    const current = ticket();
    if (current) copyText(ticketPath(current.key) ?? `/t/${current.key}`);
  }
  function archive(value: boolean): void {
    menuOpen = false;
    callUpdate({ archived: value }, undefined, undefined, () => announce(value ? 'Ticket archived.' : 'Ticket restored.'));
  }
  function saveField(field: ConflictField, value: unknown): void {
    if (field === 'state') {
      if (typeof value !== 'object' || value === null || !('key' in value)) return;
      failedUpdate = null;
      failedTransition = null;
      localError = '';
      pendingMine.state = value;
      void opts.store.transitionTicket(opts.key, String((value as { key: unknown }).key)).then(() => {
        delete pendingMine.state;
        failedTransition = null;
        localError = '';
        const selected = value as { name?: unknown };
        announce(`${ticket()?.key ?? opts.key} moved to ${typeof selected.name === 'string' ? selected.name : 'the selected state'}.`);
        render();
      }).catch((error: unknown) => {
        if (error instanceof TrackerError && error.code === 'conflict') {
          pendingMine.state = value;
          announce('This ticket changed. Review the fields below.');
        } else {
          delete pendingMine.state;
          failedTransition = value as TrackerTicket['state'];
          localError = error instanceof Error ? error.message : 'Could not change state.';
        }
        render();
      });
      return;
    }
    callUpdate(fieldPatch(field, value), field, value);
  }
  function pickerOptions(field: PagePickerField, current: TrackerTicket): { label: string; options: PickerOption<string>[]; value?: string | null; selected?: string[]; multi?: boolean; emptyLabel?: 'No one' | 'None' } | null {
    const data = meta();
    if (!data) return null;
    if (field === 'state') return {
      label: 'State', value: current.state.id, emptyLabel: 'None',
      options: [{ value: null, label: 'None', disabled: true }, ...data.states.map((state) => ({ value: state.id, label: state.name }))],
    };
    if (field === 'assignee') return { label: 'Assignee', emptyLabel: 'No one', value: current.assignee?.userId ?? null, options: data.members.map((member) => ({ value: member.userId, label: member.name })) };
    if (field === 'priority') return { label: 'Priority', value: current.priority, options: PRIORITIES.map((priority) => ({ value: priority, label: priorityLabel(priority) })) };
    if (field === 'labels') return { label: 'Labels', multi: true, emptyLabel: 'None', selected: current.labels.map((label) => label.id), options: data.labels.map((label) => ({ value: label.id, label: label.name })) };
    if (field === 'project' && data.projects) return { label: 'Project', value: current.project?.id ?? null, options: data.projects.filter((project) => !project.archivedAt).map((project) => ({ value: project.id, label: project.name })) };
    if (field === 'milestone' && data.milestones) {
      return { label: 'Milestone', value: current.milestone?.id ?? null, options: data.milestones.filter((milestone) => !current.project || !milestone.projectId || milestone.projectId === current.project.id).map((milestone) => ({ value: milestone.id, label: milestone.name })) };
    }
    return null;
  }
  async function openFieldPicker(field: PagePickerField, anchor?: HTMLElement): Promise<void> {
    const current = ticket();
    if (!current || !canWrite()) return;
    if (field === 'due') { dueEditing = true; render(); root.querySelector<HTMLInputElement>('[data-focus-id="due-input"]')?.focus(); return; }
    const buttonEl = anchor ?? root.querySelector<HTMLButtonElement>(`[data-field="${field}"]`);
    const config = pickerOptions(field, current);
    if (!buttonEl || !config) return;
    const picked: PickerResult<string> = await openPicker(buttonEl, config);
    if (picked === undefined) return;
    if (field === 'state' && typeof picked === 'string') {
      const state = meta()?.states.find((item) => item.id === picked);
      if (state) saveField('state', state);
    } else if (field === 'assignee') {
      const member = typeof picked === 'string' ? meta()?.members.find((item) => item.userId === picked) : undefined;
      saveField('assignee', member?.name ?? null);
    }
    else if (field === 'priority' && typeof picked === 'string') saveField('priority', picked);
    else if (field === 'labels') {
      const labels = Array.isArray(picked)
        ? picked.filter((value): value is string => typeof value === 'string').map((id) => meta()?.labels.find((label) => label.id === id)?.name ?? id)
        : [];
      saveField('labels', labels);
    } else if (field === 'project') {
      const project = typeof picked === 'string' ? meta()?.projects?.find((item) => item.id === picked) : undefined;
      saveField('project', project?.name ?? null);
    } else if (field === 'milestone') {
      const milestone = typeof picked === 'string' ? meta()?.milestones?.find((item) => item.id === picked) : undefined;
      saveField('milestone', milestone?.name ?? null);
    }
  }
  function startRelationSearch(anchor: HTMLElement): void {
    if (!canWrite()) return;
    const options: PickerOption<TrackerRelationKind>[] = [
      { value: 'blocks', label: 'Blocks' }, { value: 'blocked_by', label: 'Blocked by' },
      { value: 'relates_to', label: 'Related to' }, { value: 'duplicates', label: 'Duplicate of' }, { value: 'duplicated_by', label: 'Duplicated by' },
    ];
    void openPicker(anchor, { label: 'Relation type', options }).then((picked) => {
      if (typeof picked !== 'string') return;
      relationSearch = { kind: picked as TrackerRelationKind, query: '', results: [], loading: false };
      render();
      root.querySelector<HTMLInputElement>('[data-focus-id="relation-query"]')?.focus();
    });
  }
  async function searchRelations(): Promise<void> {
    if (!relationSearch) return;
    const term = relationSearch.query.trim();
    if (!term) { relationSearch.error = 'Enter a ticket key or title.'; render(); return; }
    relationSearch.loading = true;
    relationSearch.error = undefined;
    render();
    try {
      const page = await opts.store.loadList({ q: term, limit: 20 });
      if (!relationSearch) return;
      relationSearch.results = page.tickets.filter((item) => item.key !== ticket()?.key);
      relationSearch.loading = false;
    } catch (error) {
      if (!relationSearch) return;
      relationSearch.loading = false;
      relationSearch.error = error instanceof Error ? error.message : 'Could not search tickets.';
    }
    render();
    root.querySelector<HTMLInputElement>('[data-focus-id="relation-query"]')?.focus();
  }
  function addRelation(target: TrackerTicket): void {
    if (!relationSearch) return;
    const relation = { kind: relationSearch.kind, key: target.key };
    relationSearch = null;
    void opts.store.addRelation(opts.key, relation).then(() => announce(`${target.key} added as ${RELATION_LABELS[relation.kind].toLocaleLowerCase()}.`)).catch((error: unknown) => {
      localError = error instanceof Error ? error.message : 'Could not add relation.';
      render();
    });
  }
  function removeRelation(relation: { kind: TrackerRelationKind; key: string }): void {
    void opts.store.removeRelation(opts.key, relation).catch((error: unknown) => {
      localError = error instanceof Error ? error.message : 'Could not remove relation.';
      render();
    });
  }
  function commentStorageKey(key: string): string { return `tracker:comment-draft:${key.toLocaleUpperCase()}`; }
  function saveCommentDraft(value: string): void {
    commentDraft = value;
    try { localStorage.setItem(commentStorageKey(opts.key), value); } catch { /* private browsing can disable storage */ }
  }
  function newClientId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    return `comment-${opts.me.userId}-${uuid ?? `${Date.now().toString(36)}-${++localCommentSerial}`}`;
  }
  function postComment(): void {
    const body = commentDraft.trim();
    if (!body || !canWrite() || commentSending) return;
    if (!commentRetry || commentRetry.body !== body) commentRetry = { body, clientId: newClientId() };
    commentSending = true;
    commentError = '';
    render();
    void opts.store.addComment(opts.key, body, commentRetry.clientId).then(() => {
      commentSending = false;
      commentRetry = null;
      commentError = '';
      saveCommentDraft('');
      announce('Comment posted.');
      render();
    }).catch((error: unknown) => {
      commentSending = false;
      commentError = error instanceof Error ? error.message : 'Comment could not be posted.';
      render();
    });
  }
  function olderActivity(): void {
    if (cache.loadingOlderActivity) return;
    loadingOlderPage = true;
    void opts.store.loadOlderActivity(opts.key).catch((error: unknown) => {
      localError = error instanceof Error ? error.message : 'Could not load older activity.';
      render();
    }).finally(() => { loadingOlderPage = false; });
  }
  function activityTime(at: number): HTMLTimeElement {
    const iso = timeAt(at);
    if (Date.now() - at < 7 * 24 * 60 * 60_000) return relativeTime(Date.now(), iso);
    const date = new Date(at);
    return h('time', { class: 'trk-relative-time', dateTime: iso, title: date.toLocaleString() }, Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleDateString());
  }
  function ticketLookup(key: string): TrackerTicket | null {
    const cached = opts.store.ticket(key).ticket;
    return cached ?? null;
  }
  function markdown(source: string, extraClass?: string): HTMLElement {
    return buildMarkdownDom(renderMarkdownSafe(source), {
      lookup: ticketLookup,
      onNavigate: (key) => opts.onNavigate(key),
      className: extraClass,
    });
  }
  function relationRow(relation: { kind: TrackerRelationKind; key: string }): HTMLElement {
    const target = opts.store.ticket(relation.key).ticket;
    const row = h('div', { class: 'tk-relation-row' });
    const link = button(`${relation.key} · ${RELATION_LABELS[relation.kind]}`, 'tk-ticket-link', false, (event) => {
      event.preventDefault(); opts.onNavigate(relation.key);
    });
    link.append(keyChip(relation.key));
    if (target) link.append(stateGlyph(target.state.category, target.state.key), h('span', { class: 'tk-list-title' }, target.title));
    row.append(link);
    row.append(describeDisabled(button(`Remove ${RELATION_LABELS[relation.kind].toLocaleLowerCase()} relation to ${relation.key}`, 'tk-remove-relation', !canWrite(), () => removeRelation(relation)), !canWrite()));
    return row;
  }

  function render(): void {
    if (destroyed) return;
    const current = ticket();
    const active = document.activeElement as HTMLElement | null;
    const activeId = active && root.contains(active) ? active.getAttribute('data-focus-id') : null;
    const oldActivity = root.querySelector<HTMLElement>('.tk-activity-list');
    const oldScrollTop = oldActivity?.scrollTop ?? 0;
    const oldAtBottom = !oldActivity || oldActivity.scrollHeight <= oldActivity.clientHeight || oldActivity.scrollHeight - oldActivity.clientHeight - oldScrollTop < 32;
    if (oldActivity && oldAtBottom) newComments = 0;
    root.replaceChildren();
    root.setAttribute('aria-label', `Ticket ${current?.key ?? opts.key}`);
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    if (!online || cache.offlineQueued) root.appendChild(h('div', { class: 'tk-offline-banner', role: 'status' }, 'Offline. Changes are saved here and will sync.'));
    if (!current) {
      if (cache.error?.code === 'not_found' || cache.error?.code === 'forbidden') {
        root.appendChild(h('section', { class: 'tk-state-screen', role: 'status' },
          h('h1', null, `${opts.key} doesn’t exist or you can’t see it.`),
          h('p', null, 'This ticket doesn’t exist or you can’t see it.'),
          button('Retry', 'tk-button tk-button--secondary', false, () => { void opts.store.loadTicket(opts.key, true).catch(() => undefined); }, 'retry-ticket'),
        ));
      } else if (cache.error) {
        root.appendChild(h('section', { class: 'tk-state-screen', role: 'alert' },
          h('h1', null, 'Couldn’t load this ticket.'), h('p', null, 'Check your connection and try again.'),
          button('Retry', 'tk-button tk-button--secondary', false, () => { void opts.store.loadTicket(opts.key, true).catch(() => undefined); }, 'retry-ticket'),
        ));
      } else if (showLoadingSkeleton) {
        root.appendChild(h('section', { class: 'tk-loading', role: 'status', 'aria-label': 'Loading ticket' },
          h('span', { class: 'tk-skeleton tk-skeleton--wide' }), h('span', { class: 'tk-skeleton' }), h('span', { class: 'tk-skeleton tk-skeleton--wide' }),
          h('span', { class: 'tk-skeleton' }), h('span', { class: 'tk-skeleton tk-skeleton--wide' }), h('span', { class: 'tk-skeleton' }),
          h('span', { class: 'tk-skeleton tk-skeleton--wide' }), h('span', { class: 'tk-skeleton' }),
        ));
      }
      if (activeId) root.querySelector<HTMLElement>(`[data-focus-id="${activeId}"]`)?.focus();
      return;
    }

    const writeable = canWrite();
    const reason = disabledReason();
    root.appendChild(h('p', { id: readonlyId, class: 'tk-sr-only' }, reason));
    if (cache.error?.code === 'conflict' && cache.conflict && Object.keys(pendingMine).length) {
      const changed = h('section', { class: 'tk-conflict-bar', role: 'alert', 'aria-label': 'Ticket changed' },
        h('strong', null, 'This ticket changed'),
        h('span', null, 'Choose which value to keep for each field.'),
      );
      for (const field of Object.keys(pendingMine) as ConflictField[]) {
        const mine = pendingMine[field];
        const row = h('div', { class: 'tk-conflict-field' },
          h('span', { class: 'tk-property-label' }, FIELD_NAMES[field]),
          h('span', null, `Yours: ${conflictText(mine)} · Theirs: ${valueText(cache.conflict, field)}`),
          describeDisabled(button(`Keep mine for ${FIELD_NAMES[field].toLocaleLowerCase()}`, 'tk-button tk-button--secondary', !canWrite(), () => {
            const value = pendingMine[field];
            delete pendingMine[field];
            if (field === 'state') saveField('state', value);
            else callUpdate(fieldPatch(field, value), field, value);
          }), !canWrite(), disabledReason()),
          button(`Take theirs for ${FIELD_NAMES[field].toLocaleLowerCase()}`, 'tk-button tk-button--quiet', false, () => {
            delete pendingMine[field];
            if (!Object.keys(pendingMine).length) cache = opts.store.ticket(opts.key);
            render();
          }),
        );
        changed.appendChild(row);
      }
      root.appendChild(changed);
    }
    if (current.archivedAt) {
      const archivedDate = new Date(current.archivedAt);
      root.appendChild(h('section', { class: 'tk-archived-banner', role: 'status' },
        h('span', null, `Archived on ${Number.isNaN(archivedDate.getTime()) ? 'an earlier date' : archivedDate.toLocaleDateString()}.`),
        describeDisabled(button('Restore', 'tk-button tk-button--secondary', !canRestore(), () => archive(false), 'restore-ticket'), !canRestore(), permissionReason()),
      ));
    }

    const header = h('header', { class: 'tk-header' });
    const idButton = button(`Copy link to ${current.key}`, 'tk-header-key', false, () => copyLink(), 'ticket-key');
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    if (current.due && current.due < today && current.assignee?.userId === opts.me.userId && current.state.category !== 'completed' && current.state.category !== 'canceled') {
      idButton.classList.add('tk-header-key--overdue');
    }
    idButton.replaceChildren(keyChip(current.key), h('span', { class: 'tk-copy-glyph', 'aria-hidden': 'true' }, '⧉'));
    idButton.setAttribute('data-tip', 'Copy link');
    header.append(idButton);
    const stateButton = fieldButton(current.state.name, 'state', (event) => { void openFieldPicker('state', event.currentTarget as HTMLElement); }, 'ticket-state');
    stateButton.prepend(stateGlyph(current.state.category, current.state.key));
    stateButton.append(h('span', { 'aria-hidden': 'true' }, ' ▾'));
    header.append(stateButton);
    const subscribed = cache.subscribed ?? cache.detail?.subscribed ?? false;
    const subscribeButton = fieldButton(subscribed ? 'Subscribed' : 'Subscribe', 'subscription', () => toggleSubscribe(), 'ticket-subscribe');
    subscribeButton.classList.add('tk-subscribe-button');
    subscribeButton.setAttribute('aria-pressed', String(subscribed));
    subscribeButton.setAttribute('aria-label', `${subscribed ? 'Unsubscribe from' : 'Subscribe to'} ${current.key}`);
    subscribeButton.replaceChildren(bellIcon(), h('span', null, subscribed ? 'Subscribed' : 'Subscribe'));
    header.append(subscribeButton);
    const tools = h('div', { class: 'tk-header-tools' });
    const moreButton = button('More ticket actions', 'tk-icon-button', false, () => { menuOpen = !menuOpen; render(); }, 'ticket-menu');
    moreButton.textContent = '⋯';
    moreButton.setAttribute('data-tip', 'More actions');
    moreButton.setAttribute('aria-expanded', String(menuOpen));
    tools.append(moreButton);
    if (menuOpen) {
      const menu = h('div', { class: 'tk-more-menu', role: 'menu', 'aria-label': 'Ticket actions' });
      menu.append(button('Copy link', 'tk-menu-item', false, () => copyLink()));
      menu.append(button('Copy key', 'tk-menu-item', false, () => copyText(current.key)));
      if (!current.archivedAt) menu.append(describeDisabled(button('Archive', 'tk-menu-item', !canRestore(), () => archive(true)), !canRestore(), permissionReason()));
      else menu.append(describeDisabled(button('Restore', 'tk-menu-item', !canRestore(), () => archive(false)), !canRestore(), permissionReason()));
      header.appendChild(menu);
    }
    const closeButton = button('Close ticket', 'tk-icon-button', false, () => opts.onClose(), 'ticket-close');
    closeButton.textContent = '×';
    closeButton.setAttribute('data-tip', 'Close ticket');
    tools.append(closeButton);
    header.appendChild(tools);
    root.appendChild(header);

    if (failedUpdate || failedTransition) {
      const retry = describeDisabled(button('Retry save', 'tk-button tk-button--secondary', !canWrite(), () => retryFailedSave(), 'retry-save'), !canWrite());
      root.appendChild(h('div', { class: 'tk-save-state tk-save-state--failed', role: 'alert' }, h('span', null, 'Not saved.'), retry));
    } else if (cache.pending) root.appendChild(h('div', { class: 'tk-save-state', role: 'status' }, cache.offlineQueued ? 'Offline, will sync' : 'Saving…'));
    if (localError) root.appendChild(h('div', { class: 'tk-error-inline', role: 'alert' }, localError));

    const layout = h('div', { class: 'tk-layout' });
    const main = h('div', { class: 'tk-main-column' });
    const titleHeading = h('section', { class: 'tk-title-section' });
    if (titleEditing && writeable) {
      const input = h('input', { class: 'tk-title-input', type: 'text', value: titleDraft, maxlength: 400, 'aria-label': 'Title', 'data-focus-id': 'title-input' });
      input.addEventListener('input', () => {
        titleDraft = Array.from(input.value.replace(/[\r\n]+/g, ' ')).slice(0, 200).join('');
        if (input.value !== titleDraft) input.value = titleDraft;
        if (failedUpdate?.field === 'title') failedUpdate = { ...failedUpdate, patch: { title: titleDraft }, mine: titleDraft };
      });
      input.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') { event.preventDefault(); commitTitle(); }
        else if (event.key === 'Escape') { event.preventDefault(); cancelTitle(); }
      });
      titleHeading.append(input, button('Save title', 'tk-button tk-button--secondary', false, () => commitTitle()), button('Cancel title edit', 'tk-button tk-button--quiet', false, () => cancelTitle()));
    } else {
      const title = h('h1', { class: 'tk-title', tabindex: writeable ? '0' : '-1', 'data-focus-id': 'ticket-title', 'aria-label': writeable ? 'Title, press Enter to edit' : 'Title' }, current.title);
      title.addEventListener('click', () => { if (writeable) editTitle(); });
      title.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' && writeable) { event.preventDefault(); editTitle(); }
      });
      titleHeading.appendChild(title);
      if (writeable) titleHeading.appendChild(button('Edit title', 'tk-title-edit', false, () => editTitle()));
    }
    const originInfo = origin(current);
    titleHeading.appendChild(h('p', { class: 'tk-created-by' }, originInfo.actor ? actorVisual(originInfo.actor.kind, originInfo.actor.name) : null, h('span', null, originInfo.text), h('span', null, ' · '), activityTime(current.createdAt)));
    if (current.aliases.length) {
      const aliases = h('p', { class: 'tk-aliases' }, h('span', null, 'Also known as '));
      current.aliases.forEach((alias, index) => {
        if (index) aliases.appendChild(document.createTextNode(', '));
        const aliasButton = button(alias, 'tk-alias-link', false, () => opts.onNavigate(current.key));
        aliases.appendChild(aliasButton);
      });
      titleHeading.appendChild(aliases);
    }
    titleHeading.appendChild(h('hr', { class: 'trk-rule' }));
    main.appendChild(titleHeading);

    const descriptionSection = h('section', { class: 'tk-section tk-description-section', 'aria-labelledby': 'tk-description-heading' });
    descriptionSection.append(h('h2', { id: 'tk-description-heading', class: 'tk-section-heading' }, 'Description'));
    if (descriptionEditing && writeable) {
      const editor = h('div', { class: 'tk-description-editor', 'data-focus-id': 'description-editor' });
      const tabs = h('div', { class: 'tk-editor-tabs', role: 'group', 'aria-label': 'Description editor mode' });
      tabs.append(
        button('Write', `tk-tab-button${descriptionPreview ? '' : ' active'}`, false, () => { descriptionPreview = false; render(); root.querySelector<HTMLTextAreaElement>('[data-focus-id="description-input"]')?.focus(); }),
        button('Preview', `tk-tab-button${descriptionPreview ? ' active' : ''}`, false, () => { descriptionPreview = true; render(); root.querySelector<HTMLElement>('[data-focus-id="description-preview"]')?.focus(); }),
      );
      editor.appendChild(tabs);
      if (descriptionPreview) {
        const preview = markdown(descriptionDraft, 'tk-description-preview');
        preview.tabIndex = 0;
        preview.setAttribute('data-focus-id', 'description-preview');
        editor.appendChild(preview);
      } else {
        const textarea = h('textarea', { class: 'tk-description-input', 'aria-label': 'Description in Markdown', 'data-focus-id': 'description-input', rows: 8 });
        textarea.value = descriptionDraft;
        textarea.addEventListener('input', () => {
          descriptionDraft = textarea.value;
          if (failedUpdate?.field === 'description') failedUpdate = { ...failedUpdate, patch: { description: descriptionDraft }, mine: descriptionDraft };
        });
        textarea.addEventListener('blur', (event: FocusEvent) => {
          const related = event.relatedTarget as Node | null;
          if (related && editor.contains(related)) return;
          window.setTimeout(() => {
            if (descriptionEditing && !editor.contains(document.activeElement)) commitDescription();
          }, 0);
        });
        textarea.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Escape') { event.preventDefault(); cancelDescription(); }
          else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commitDescription(); }
          else if (event.key.toLocaleLowerCase() === 'p' && event.shiftKey && (event.metaKey || event.ctrlKey)) { event.preventDefault(); descriptionPreview = true; render(); }
        });
        editor.appendChild(textarea);
      }
      if (descriptionError) editor.appendChild(h('p', { class: 'tk-error-inline', role: 'alert' }, descriptionError));
      editor.append(button('Save description', 'tk-button tk-button--secondary', false, () => commitDescription()), button('Cancel description edit', 'tk-button tk-button--quiet', false, () => cancelDescription()));
      descriptionSection.appendChild(editor);
    } else {
      if (current.description) descriptionSection.appendChild(markdown(current.description, 'tk-description-body'));
      else descriptionSection.appendChild(h('p', { class: 'tk-empty-copy' }, 'No description yet.'));
      if (writeable) descriptionSection.appendChild(button(current.description ? 'Edit description' : 'Add description', 'tk-button tk-button--quiet', false, () => editDescription(), 'description-edit'));
    }
    main.appendChild(descriptionSection);

    const subIssues = h('section', { class: 'tk-section tk-subissues-section', 'aria-labelledby': 'tk-subissues-heading' });
    const childTickets = Object.values(snapshot.tickets).map((entry) => entry.ticket).filter((item): item is TrackerTicket => Boolean(item?.parent === current.key));
    for (const list of Object.values(snapshot.lists)) for (const item of list.tickets) if (item.parent === current.key && !childTickets.some((child) => child.key === item.key)) childTickets.push(item);
    const doneCount = childTickets.filter((item) => item.state.category === 'completed' || item.state.category === 'canceled').length;
    subIssues.append(h('h2', { id: 'tk-subissues-heading', class: 'tk-section-heading' }, 'Sub-issues'));
    if (childTickets.length) {
      subIssues.append(h('p', { class: 'tk-progress-copy' }, `${doneCount} of ${childTickets.length} complete`), h('div', { class: 'tk-progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(childTickets.length), 'aria-valuenow': String(doneCount), 'aria-label': 'Sub-issue progress' }, h('span', { style: { width: `${Math.round(doneCount / childTickets.length * 100)}%` } })));
      for (const child of childTickets) {
        const row = button(`${child.key} ${child.title}`, 'tk-subissue-row', false, () => opts.onNavigate(child.key));
        row.append(keyChip(child.key), stateGlyph(child.state.category, child.state.key), h('span', { class: 'tk-list-title' }, child.title), h('span', { class: 'tk-muted' }, child.assignee?.name ?? 'Unassigned'));
        subIssues.append(row);
      }
    } else subIssues.appendChild(h('p', { class: 'tk-empty-copy' }, 'No sub-issues yet.'));
    main.appendChild(subIssues);

    const relations = h('section', { class: 'tk-section tk-relations-section', 'aria-labelledby': 'tk-relations-heading' });
    const relationHead = h('div', { class: 'tk-section-head' }, h('h2', { id: 'tk-relations-heading', class: 'tk-section-heading' }, 'Relations'));
    relationHead.appendChild(describeDisabled(button('Add relation', 'tk-button tk-button--quiet', !writeable, (event) => startRelationSearch(event.currentTarget as HTMLElement), 'add-relation'), !writeable));
    relations.appendChild(relationHead);
    const groups = [...new Set(current.relations.map((relation) => relation.kind))];
    if (groups.length) for (const kind of groups) {
      relations.appendChild(h('h3', { class: 'tk-property-label' }, RELATION_LABELS[kind]));
      current.relations.filter((relation) => relation.kind === kind).forEach((relation) => relations.appendChild(relationRow(relation)));
    } else relations.appendChild(h('p', { class: 'tk-empty-copy' }, 'No relations yet.'));
    if (relationSearch) {
      const search = h('div', { class: 'tk-relation-search', role: 'group', 'aria-label': `Search tickets for ${RELATION_LABELS[relationSearch.kind].toLocaleLowerCase()}` });
      search.appendChild(h('label', { for: 'tk-relation-query', class: 'tk-property-label' }, `Find ticket to ${RELATION_LABELS[relationSearch.kind].toLocaleLowerCase()}`));
      const input = h('input', { id: 'tk-relation-query', class: 'tk-inline-input', type: 'search', value: relationSearch.query, 'aria-label': 'Search by ticket key or title', 'data-focus-id': 'relation-query' });
      input.addEventListener('input', () => { if (relationSearch) relationSearch.query = input.value; });
      input.addEventListener('keydown', (event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); void searchRelations(); } else if (event.key === 'Escape') { event.preventDefault(); relationSearch = null; render(); } });
      search.append(input, button(relationSearch.loading ? 'Searching…' : 'Search', 'tk-button tk-button--secondary', relationSearch.loading, () => { void searchRelations(); }), button('Cancel', 'tk-button tk-button--quiet', false, () => { relationSearch = null; render(); }));
      if (relationSearch.error) search.appendChild(h('p', { class: 'tk-error-inline', role: 'alert' }, relationSearch.error));
      if (relationSearch.results.length) for (const result of relationSearch.results) {
        search.appendChild(button(`${result.key} · ${result.title}`, 'tk-relation-result', false, () => addRelation(result)));
      } else if (!relationSearch.loading && relationSearch.query) search.appendChild(h('p', { class: 'tk-empty-copy' }, 'No matching tickets.'));
      relations.appendChild(search);
    }
    main.appendChild(relations);

    const linkedWork = h('section', { class: 'tk-section tk-linked-work-section', 'aria-labelledby': 'tk-linked-work-heading' });
    linkedWork.appendChild(h('h2', { id: 'tk-linked-work-heading', class: 'tk-section-heading' }, 'Linked work'));
    const workLinks = current.links.filter((link) => link.kind !== 'card');
    if (!workLinks.length) linkedWork.appendChild(h('p', { class: 'tk-empty-copy' }, 'No pull requests or commits are linked yet.'));
    for (const link of workLinks) {
      const href = safeExternalUrl(link.url);
      const row = h('div', { class: 'tk-link-row' });
      if (link.kind === 'pr') row.append(h('span', { class: 'tk-link-glyph' }, '↗'), h('span', { class: 'tk-property-label' }, `PR #${link.number}`), h('span', { class: 'tk-list-title' }, link.title), h('span', { class: 'tk-muted' }, link.state));
      else row.append(h('span', { class: 'tk-link-glyph' }, '·'), h('span', { class: 'tk-property-label' }, link.sha.slice(0, 7)), h('span', { class: 'tk-list-title' }, link.title));
      if (href) row.appendChild(h('a', { class: 'tk-external-link', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${link.kind === 'pr' ? `pull request ${link.number}` : 'commit'} in a new tab` }, 'Open'));
      linkedWork.appendChild(row);
    }
    main.appendChild(linkedWork);

    const linkedCards = h('section', { class: 'tk-section tk-linked-cards-section', 'aria-labelledby': 'tk-linked-cards-heading' });
    linkedCards.appendChild(h('h2', { id: 'tk-linked-cards-heading', class: 'tk-section-heading' }, 'Linked cards'));
    const cards = current.links.filter((link) => link.kind === 'card');
    if (cards.length) cards.forEach((link) => linkedCards.appendChild(h('p', { class: 'tk-card-link-row' }, `Card ${link.cardId} · Board ${link.boardId}`)));
    else linkedCards.appendChild(h('p', { class: 'tk-empty-copy' }, 'No cards are linked to this ticket yet.'));
    main.appendChild(linkedCards);

    const properties = h('aside', { class: 'tk-properties', 'aria-label': 'Ticket properties' });
    properties.appendChild(h('h2', { class: 'tk-section-heading' }, 'Properties'));
    const propertyList = h('dl', { class: 'tk-property-list' });
    const data = meta();
    const propertyRow = (name: string, value: HTMLElement) => h('div', { class: 'tk-property-row' }, h('dt', { class: 'tk-property-label' }, name), h('dd', null, value));
    const assigneeLabel = current.assignee?.name ?? 'Unassigned';
    propertyList.append(
      propertyRow('State', fieldButton(current.state.name, 'state', (event) => { void openFieldPicker('state', event.currentTarget as HTMLElement); })),
      propertyRow('Assignee', fieldButton(assigneeLabel, 'assignee', (event) => { void openFieldPicker('assignee', event.currentTarget as HTMLElement); })),
      propertyRow('Priority', fieldButton(priorityLabel(current.priority), 'priority', (event) => { void openFieldPicker('priority', event.currentTarget as HTMLElement); })),
      propertyRow('Labels', (() => {
        const control = h('div', { class: 'tk-label-property' });
        const value = fieldButton(current.labels.map((label) => label.name).join(', ') || 'No labels', 'labels', (event) => { void openFieldPicker('labels', event.currentTarget as HTMLElement); });
        value.replaceChildren(...current.labels.map((label) => labelChip(label.name, label.color)));
        if (!current.labels.length) value.textContent = 'No labels';
        control.appendChild(value);
        if (data?.canCreateLabels) {
          if (creatingLabel) {
            const editor = h('div', { class: 'tk-inline-field tk-create-label' });
            const input = describeDisabled(h('input', { class: 'tk-inline-input', type: 'text', value: labelDraft, maxlength: 64, placeholder: 'Label name', 'aria-label': 'New label name', 'data-focus-id': 'new-label-name', disabled: !writeable }), !writeable);
            const save = button('Save label', 'tk-button tk-button--secondary', !writeable || !labelDraft.trim(), () => createTicketLabel());
            input.addEventListener('input', () => {
              labelDraft = input.value;
              save.disabled = !canWrite() || !labelDraft.trim();
            });
            input.addEventListener('keydown', (event: KeyboardEvent) => {
              if (event.key === 'Enter') { event.preventDefault(); createTicketLabel(); }
              else if (event.key === 'Escape') { event.preventDefault(); creatingLabel = false; labelDraft = ''; labelCreateError = ''; render(); }
            });
            editor.append(input, describeDisabled(save, !writeable), button('Cancel label', 'tk-button tk-button--quiet', false, () => { creatingLabel = false; labelDraft = ''; labelCreateError = ''; render(); }));
            if (labelCreateError) editor.appendChild(h('p', { class: 'tk-error-inline', role: 'alert' }, labelCreateError));
            control.appendChild(editor);
          } else {
            control.appendChild(describeDisabled(button('Create label', 'tk-button tk-button--quiet tk-create-label-button', !writeable, () => {
              creatingLabel = true;
              labelDraft = '';
              labelCreateError = '';
              render();
              root.querySelector<HTMLInputElement>('[data-focus-id="new-label-name"]')?.focus();
            }), !writeable));
          }
        }
        return control;
      })()),
      propertyRow('Due', (() => {
        if (!dueEditing) return fieldButton(current.due ?? 'No due date', 'due', () => { dueEditing = true; render(); root.querySelector<HTMLInputElement>('[data-focus-id="due-input"]')?.focus(); });
        const control = h('div', { class: 'tk-inline-field' });
        const input = describeDisabled(h('input', { type: 'date', class: 'tk-inline-input', value: current.due ?? '', 'aria-label': 'Due date, YYYY-MM-DD', 'data-focus-id': 'due-input', disabled: !writeable }), !writeable);
        input.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Escape') { event.preventDefault(); if (failedUpdate?.field === 'due') failedUpdate = null; localError = ''; dueEditing = false; render(); }
        });
        input.addEventListener('input', () => {
          input.dataset.value = input.value;
          if (failedUpdate?.field === 'due') failedUpdate = { ...failedUpdate, patch: { due: input.value || null }, mine: input.value || null };
        });
        control.append(input, describeDisabled(button('Save due date', 'tk-button tk-button--secondary', !writeable, () => {
          const value = input.value.trim();
          if (value && !isValidDueDate(value)) { localError = 'Use a valid YYYY-MM-DD date.'; render(); return; }
          dueEditing = false; saveField('due', value || null);
        }), !writeable), describeDisabled(button('Clear due date', 'tk-button tk-button--quiet', !writeable, () => { dueEditing = false; saveField('due', null); }), !writeable), button('Cancel due date', 'tk-button tk-button--quiet', false, () => { if (failedUpdate?.field === 'due') failedUpdate = null; localError = ''; dueEditing = false; render(); }));
        return control;
      })()),
      propertyRow('Parent', (() => {
        if (!parentEditing) return fieldButton(current.parent ?? 'No parent', 'parent', () => { parentEditing = true; render(); root.querySelector<HTMLInputElement>('[data-focus-id="parent-input"]')?.focus(); });
        const control = h('div', { class: 'tk-inline-field' });
        const input = describeDisabled(h('input', { class: 'tk-inline-input', type: 'text', value: current.parent ?? '', placeholder: 'TAB-123', 'aria-label': 'Parent ticket key', 'data-focus-id': 'parent-input', disabled: !writeable }), !writeable);
        input.addEventListener('input', () => {
          input.dataset.value = input.value;
          if (failedUpdate?.field === 'parent') failedUpdate = { ...failedUpdate, patch: { parent: input.value.trim() || null }, mine: input.value.trim() || null };
        });
        input.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Enter') { event.preventDefault(); parentEditing = false; saveField('parent', input.value.trim() || null); }
          else if (event.key === 'Escape') { event.preventDefault(); if (failedUpdate?.field === 'parent') failedUpdate = null; localError = ''; parentEditing = false; render(); }
        });
        control.append(input, describeDisabled(button('Save parent', 'tk-button tk-button--secondary', !writeable, () => { parentEditing = false; saveField('parent', input.value.trim() || null); }), !writeable), describeDisabled(button('Clear parent', 'tk-button tk-button--quiet', !writeable, () => { parentEditing = false; saveField('parent', null); }), !writeable), button('Cancel parent', 'tk-button tk-button--quiet', false, () => { if (failedUpdate?.field === 'parent') failedUpdate = null; localError = ''; parentEditing = false; render(); }));
        return control;
      })()),
    );
    if (data?.projects) {
      propertyList.appendChild(propertyRow('Project', fieldButton(current.project?.name ?? 'No project', 'project', (event) => { void openFieldPicker('project', event.currentTarget as HTMLElement); })));
    } else propertyList.appendChild(propertyRow('Project', h('span', { class: 'tk-readonly-value' }, current.project?.name ?? 'No project')));
    if (data?.milestones) {
      propertyList.appendChild(propertyRow('Milestone', fieldButton(current.milestone?.name ?? 'No milestone', 'milestone', (event) => { void openFieldPicker('milestone', event.currentTarget as HTMLElement); })));
    } else propertyList.appendChild(propertyRow('Milestone', h('span', { class: 'tk-readonly-value' }, current.milestone?.name ?? 'No milestone')));
    propertyList.appendChild(propertyRow('Created', h('span', { class: 'tk-readonly-value' }, new Date(current.createdAt).toLocaleDateString())));
    if (current.due) propertyList.appendChild(propertyRow('Due status', dueChip(current.due, Date.now()) ?? h('span', { class: 'tk-readonly-value' }, 'No due date')));
    properties.appendChild(propertyList);
    main.insertBefore(properties, descriptionSection);
    layout.appendChild(main);

    const activitySection = h('section', { class: 'tk-section tk-activity-section', 'aria-labelledby': 'tk-activity-heading' });
    const activityHead = h('div', { class: 'tk-section-head' }, h('h2', { id: 'tk-activity-heading', class: 'tk-section-heading' }, 'Activity'));
    const filters = h('div', { class: 'tk-activity-filters', role: 'group', 'aria-label': 'Activity filter' });
    for (const choice of ['all', 'comments', 'history'] as const) {
      const filter = button(choice[0].toLocaleUpperCase() + choice.slice(1), `tk-tab-button${selectedActivity === choice ? ' active' : ''}`, false, () => { selectedActivity = choice; render(); });
      filter.setAttribute('aria-pressed', String(selectedActivity === choice));
      filters.appendChild(filter);
    }
    activityHead.appendChild(filters);
    activitySection.appendChild(activityHead);
    const activity = h('div', { class: 'tk-activity-list', role: 'feed', 'aria-live': 'off', 'aria-label': 'Comments and ticket history' });
    const comments = cache.detail?.comments ?? [];
    const events = cache.detail?.events ?? [];
    const rows: ActivityItem[] = [
      ...(selectedActivity === 'history' ? [] : comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment }))),
      ...(selectedActivity === 'comments' ? [] : events.map((event) => ({ kind: 'event' as const, at: event.at, event }))),
    ].sort((a, b) => a.at - b.at || (a.kind === 'event' ? -1 : 1));
    const canLoadOlder = Boolean((cache.commentsHasMore ?? (comments.length >= 50)) || (cache.eventsHasMore ?? (events.length >= 50)));
    if (canLoadOlder) activity.appendChild(button(cache.loadingOlderActivity ? 'Loading older activity…' : 'Load older activity', 'tk-load-older', Boolean(cache.loadingOlderActivity), () => olderActivity(), 'load-older'));
    if (!rows.length && !canLoadOlder) activity.appendChild(h('p', { class: 'tk-empty-copy' }, selectedActivity === 'comments' ? 'No comments yet.' : 'No activity yet.'));

    let groupedRows = rows;
    if (selectedActivity === 'history') {
      const collapsed: Array<ActivityItem | { kind: 'group'; at: number; events: TrackerEvent[] }> = [];
      for (const row of rows) {
        if (row.kind === 'event' && ['ticket.updated', 'updated'].includes(row.event.eventType) && eventChangedFields(row.event).length) {
          const last = collapsed.at(-1);
          if (last?.kind === 'group' && eventActorKey(last.events.at(-1)!) === eventActorKey(row.event)) last.events.push(row.event);
          else collapsed.push({ kind: 'group', at: row.at, events: [row.event] });
        } else collapsed.push(row);
      }
      for (const row of collapsed) {
        if (row.kind !== 'group') {
          renderActivityItem(activity, row);
          continue;
        }
        const described = describeEvent(row.events.at(-1)!, { ticketKey: current.key, members: meta()?.members });
        const fields = [...new Set(row.events.flatMap(eventChangedFields))];
        const line = h('article', { class: 'tk-history-row' },
          h('span', { class: 'tk-event-icon', 'aria-hidden': 'true' }, displayEventIcon('update')),
          actorVisual(described.actor.kind, described.actor.name),
          h('span', { class: 'tk-history-text' }, `${described.actor.name} changed ${fields.join(', ')} · ${row.events.length} changes`),
          activityTime(row.at),
        );
        activity.appendChild(line);
      }
    } else for (const row of groupedRows) renderActivityItem(activity, row);
    activitySection.appendChild(activity);
    if (newComments > 0) activitySection.appendChild(button(`New comments ↓ (${newComments})`, 'tk-new-comments', false, () => {
      const list = root.querySelector<HTMLElement>('.tk-activity-list');
      if (list) list.scrollTop = list.scrollHeight;
      newComments = 0; render();
    }));
    const composer = h('div', { class: 'tk-comment-composer' });
    composer.appendChild(h('label', { for: 'tk-comment-input', class: 'tk-property-label' }, 'Add a comment'));
    const commentInput = h('textarea', { id: 'tk-comment-input', class: 'tk-comment-input', rows: 4, placeholder: writeable ? 'Write a comment in Markdown…' : reason, 'aria-label': 'Comment in Markdown', disabled: !writeable, 'aria-describedby': !writeable ? readonlyId : undefined, 'data-focus-id': 'comment-input' });
    commentInput.value = commentDraft;
    commentInput.addEventListener('input', () => {
      saveCommentDraft(commentInput.value);
      const submit = root.querySelector<HTMLButtonElement>('.tk-comment-submit');
      if (submit) submit.disabled = !canWrite() || commentSending || !commentDraft.trim();
      if (commentError && submit) {
        commentError = '';
        submit.textContent = 'Post comment';
        submit.setAttribute('aria-label', 'Post comment');
        root.querySelector('.tk-comment-composer .tk-error-inline')?.remove();
      }
    });
    commentInput.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); postComment(); }
    });
    composer.append(commentInput, describeDisabled(button(commentError ? 'Retry comment' : commentSending ? 'Posting…' : 'Post comment', 'tk-button tk-button--primary tk-comment-submit', !writeable || commentSending || !commentDraft.trim(), () => postComment(), 'post-comment'), !writeable));
    if (commentError) composer.appendChild(h('p', { class: 'tk-error-inline', role: 'alert' }, `Comment not sent. ${commentError}`));
    activitySection.appendChild(composer);
    main.appendChild(activitySection);
    root.appendChild(layout);

    if (oldActivity) {
      const nextActivity = root.querySelector<HTMLElement>('.tk-activity-list');
      if (nextActivity) {
        nextActivity.scrollTop = oldAtBottom ? nextActivity.scrollHeight : oldScrollTop;
      }
    }
    if (activeId) root.querySelector<HTMLElement>(`[data-focus-id="${activeId}"]`)?.focus();
  }

  function renderActivityItem(parent: HTMLElement, item: ActivityItem): void {
    if (item.kind === 'event') {
      const described = describeEvent(item.event, { ticketKey: opts.key, members: meta()?.members });
      parent.appendChild(h('article', { class: 'tk-history-row' },
        h('span', { class: 'tk-event-icon', 'aria-hidden': 'true' }, displayEventIcon(described.icon)),
        actorVisual(described.actor.kind, described.actor.name), h('span', { class: 'tk-history-text' }, described.text), activityTime(item.at),
      ));
      return;
    }
    const comment = item.comment;
    const deleted = Boolean(comment.deleted || comment.deletedAt);
    const who = comment.author.userId ? actorVisual('person', comment.author.name) : actorVisual('import', `Integration · ${comment.author.name}`);
    const row = h('article', { class: `tk-comment-row${comment.id.startsWith('pending:') ? ' pending' : ''}`, 'data-comment-id': comment.id });
    const header = h('div', { class: 'tk-comment-head' }, who, h('strong', null, comment.author.name), activityTime(comment.createdAt));
    if (comment.editedAt) header.appendChild(h('span', { class: 'tk-muted' }, 'edited'));
    row.appendChild(header);
    if (deleted) row.appendChild(h('p', { class: 'tk-deleted-comment' }, 'Comment deleted'));
    else if (editingCommentId === comment.id) {
      const editor = h('div', { class: 'tk-comment-edit' });
      const textarea = h('textarea', { class: 'tk-comment-input', rows: 3, 'aria-label': 'Edit comment in Markdown', 'data-focus-id': `edit-comment-${comment.id}` });
      textarea.value = commentEditDraft;
      textarea.addEventListener('input', () => { commentEditDraft = textarea.value; });
      textarea.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); editingCommentId = null; commentActionError = ''; render(); }
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveCommentEdit(comment.id); }
      });
      editor.append(textarea, button('Save comment edit', 'tk-button tk-button--secondary', !canWrite(), () => saveCommentEdit(comment.id)), button('Cancel comment edit', 'tk-button tk-button--quiet', false, () => { editingCommentId = null; commentActionError = ''; render(); }));
      if (commentActionError) editor.appendChild(h('p', { class: 'tk-error-inline', role: 'alert' }, commentActionError));
      row.appendChild(editor);
    } else {
      row.appendChild(markdown(comment.body, 'tk-comment-body'));
      const ownsComment = comment.author.userId === opts.me.userId;
      if ((ownsComment || meta()?.me.canDeleteAnyComment) && canWrite()) {
        const actions = h('div', { class: 'tk-comment-actions' });
        if (ownsComment) actions.appendChild(button('Edit comment', 'tk-button tk-button--quiet', false, () => {
          editingCommentId = comment.id;
          commentEditDraft = comment.body;
          commentActionError = '';
          render();
          root.querySelector<HTMLElement>(`[data-focus-id="edit-comment-${comment.id}"]`)?.focus();
        }));
        actions.appendChild(button('Delete comment', 'tk-button tk-button--quiet', false, () => deleteCommentAction(comment.id)));
        row.appendChild(actions);
      }
    }
    parent.appendChild(row);
  }

  function saveCommentEdit(id: string): void {
    void opts.store.editComment(opts.key, id, commentEditDraft).then(() => {
      editingCommentId = null;
      commentActionError = '';
      announce('Comment updated.');
      render();
    }).catch((error: unknown) => {
      commentActionError = error instanceof Error ? error.message : 'Could not update the comment.';
      render();
    });
  }

  function deleteCommentAction(id: string): void {
    void opts.store.deleteComment(opts.key, id).then(() => {
      commentActionError = '';
      announce('Comment deleted.');
    }).catch((error: unknown) => {
      localError = error instanceof Error ? error.message : 'Could not delete the comment.';
      render();
    });
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && titleEditing) { event.preventDefault(); cancelTitle(); return; }
    if (event.key === 'Escape' && descriptionEditing) { event.preventDefault(); cancelDescription(); return; }
    if (isTypingTarget(event.target)) {
      return;
    }
    if (event.key === 'Escape' && menuOpen) { event.preventDefault(); menuOpen = false; render(); return; }
    if (event.key === 'Escape' && relationSearch) { event.preventDefault(); relationSearch = null; render(); return; }
    if (event.key === 'Escape' && dueEditing) { event.preventDefault(); if (failedUpdate?.field === 'due') failedUpdate = null; localError = ''; dueEditing = false; render(); return; }
    if (event.key === 'Escape' && parentEditing) { event.preventDefault(); if (failedUpdate?.field === 'parent') failedUpdate = null; localError = ''; parentEditing = false; render(); return; }
    if (event.key.toLocaleLowerCase() === 'e' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); editTitle(); return; }
    if (event.key.toLocaleLowerCase() === 's' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); toggleSubscribe(); return; }
    const resolved = resolveKey({ active: true, modifier: PLATFORM_MODIFIER, focusOwner: 'tracker', layers: ['ticket'] }, event);
    if (resolved.action?.type === 'escape') { event.preventDefault(); opts.onClose(); return; }
    if (resolved.action?.type === 'open-picker') {
      event.preventDefault();
      if (resolved.action.field === 'due') void openFieldPicker('due');
      else void openFieldPicker(resolved.action.field);
    }
  }
  root.addEventListener('keydown', keydown);
  render();

  function readCommentDraft(key: string): string {
    try { return localStorage.getItem(`tracker:comment-draft:${key.toLocaleUpperCase()}`) ?? ''; } catch { return ''; }
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribeTicket();
      unsubscribeStore();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearTimeout(loadingTimer);
      root.removeEventListener('keydown', keydown);
      root.remove();
    },
    focus() {
      if (titleEditing) root.querySelector<HTMLInputElement>('[data-focus-id="title-input"]')?.focus();
      else root.querySelector<HTMLElement>('[data-focus-id="ticket-title"]')?.focus();
    },
  };
}
