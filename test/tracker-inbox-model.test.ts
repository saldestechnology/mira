import { describe, expect, it } from 'vitest';
import type { TrackerInboxItem, TrackerNotificationKind } from '../src/tracker-types';
import {
  choiceLabel, clearInboxSelection, createInboxSelection, extendInboxSelection, groupByDay,
  kindLabel, moveInboxCursor, moveInboxCursorToEdge, reasonLine, reconcileInboxSelection, selectAllInbox,
  toggleInboxSelection,
} from '../src/tracker/ui/inbox-model';

function item(kind: TrackerNotificationKind, overrides: Partial<TrackerInboxItem> = {}): TrackerInboxItem {
  return {
    id: kind,
    kind,
    createdAt: Date.UTC(2026, 9, 10, 12),
    readAt: null,
    ticket: {
      key: 'TAB-12', title: 'Review the inbox', state: { name: 'In progress', category: 'started' },
      assignee: null, priority: 'none',
    },
    actor: null,
    preview: null,
    detail: null,
    ...overrides,
  };
}

describe('tracker inbox model', () => {
  it('builds reason lines for every kind with and without actor or detail', () => {
    expect(reasonLine(item('assigned', { actor: { name: 'Mara' } }))).toBe('Mara assigned you');
    expect(reasonLine(item('assigned'))).toBe('Assigned to you');
    expect(reasonLine(item('mentioned', { actor: { name: 'Mara' } }))).toBe('Mara mentioned you');
    expect(reasonLine(item('mentioned'))).toBe('Mentioned you');
    expect(reasonLine(item('commented', { actor: { name: 'Mara' } }))).toBe('Mara commented');
    expect(reasonLine(item('commented'))).toBe('New comment');
    expect(reasonLine(item('status_changed', { detail: { state: 'In review' } }))).toBe('Moved to In review');
    expect(reasonLine(item('status_changed'))).toBe('Status changed');
    expect(reasonLine(item('relation_changed', { detail: { key: 'TAB-4', relation: 'blocked_by' } }))).toBe('Now blocked by TAB-4');
    expect(reasonLine(item('relation_changed', { detail: { key: 'TAB-4', relation: 'relates_to' } }))).toBe('Now related to TAB-4');
    expect(reasonLine(item('relation_changed', { detail: { relation: 'blocks' } }))).toBe('Relation changed');
    expect(reasonLine(item('integration_activity', { detail: { text: 'Merged PR 482' } }))).toBe('Merged PR 482');
    expect(reasonLine(item('integration_activity'))).toBe('New activity');
    expect(reasonLine(item('due_soon', { detail: { dueDate: '2026-10-12' } }))).toBe('Due 2026-10-12');
    expect(reasonLine(item('due_soon'))).toBe('Due soon');
  });

  it('groups newest first by the viewer local day across midnight and offsets', () => {
    const now = Date.UTC(2026, 9, 10, 10, 15);
    const rows = [
      item('assigned', { id: 'today-late', createdAt: Date.UTC(2026, 9, 10, 9, 30) }),
      item('mentioned', { id: 'today-early', createdAt: Date.UTC(2026, 9, 10, 6, 30) }),
      item('commented', { id: 'yesterday', createdAt: Date.UTC(2026, 9, 9, 0, 30) }),
      item('due_soon', { id: 'older', createdAt: Date.UTC(2026, 9, 8, 11, 30) }),
    ];
    const groups = groupByDay(rows, now, 120);
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', 'Thu 8 Oct']);
    expect(groups[0].items.map((notice) => notice.id)).toEqual(['today-late', 'today-early']);
    expect(groupByDay(rows, now, -420)[0].items.map((notice) => notice.id)).toEqual(['today-late']);
  });

  it('moves the notification cursor, extends from an anchor, toggles, selects all and clears', () => {
    let model = createInboxSelection(['notice-1', 'notice-2', 'notice-3'], 'notice-2');
    expect(moveInboxCursor(model, -1).cursor).toBe('notice-1');
    model = moveInboxCursor(model, -1);
    model = moveInboxCursor(model, 1, true);
    expect(model).toMatchObject({ cursor: 'notice-2', anchor: 'notice-1' });
    expect([...model.selected]).toEqual(['notice-1', 'notice-2']);
    model = extendInboxSelection(model, 'notice-3');
    expect([...model.selected]).toEqual(['notice-1', 'notice-2', 'notice-3']);

    model = toggleInboxSelection(model, 'notice-2');
    expect([...model.selected]).toEqual(['notice-1', 'notice-3']);
    expect(model.anchor).toBe('notice-2');
    model = toggleInboxSelection(model, 'notice-2');
    expect(model.selected.has('notice-2')).toBe(true);
    model = moveInboxCursorToEdge(model, 'last');
    expect(model.cursor).toBe('notice-3');
    model = selectAllInbox(model);
    expect([...model.selected]).toEqual(['notice-1', 'notice-2', 'notice-3']);
    expect(reconcileInboxSelection(model, ['notice-2', 'notice-3']).cursor).toBe('notice-3');
    model = clearInboxSelection(model);
    expect(model.selected.size).toBe(0);
    expect(model.anchor).toBeNull();
  });

  it('labels preference kinds and choices for the settings panel', () => {
    expect(kindLabel('assigned')).toBe('Assigned to me');
    expect(kindLabel('integration_activity')).toBe('Integration activity');
    expect(choiceLabel('both')).toBe('In Tabula and email');
    expect(choiceLabel('app')).toBe('In Tabula only');
    expect(choiceLabel('off')).toBe('Off');
  });
});
