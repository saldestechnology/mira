import { describe, expect, it } from 'vitest';
import {
  adjacentTicket, buildListModel, extendSelection, moveCursor, moveCursorTo, selectAll, toggleSelection,
  type TrackerRow,
} from '../src/tracker/ui/list-model';

const rows: TrackerRow[] = [
  { key: 'TAB-1', title: 'Alpha', state: { id: 'todo', name: 'To do' } },
  { key: 'TAB-2', title: 'Beta', state: { id: 'todo', name: 'To do' } },
  { key: 'TAB-3', title: 'Gamma', state: { id: 'started', name: 'In progress' } },
];

describe('tracker list render model', () => {
  it('builds group headers from facets, retains empty groups and applies collapsed state', () => {
    const model = buildListModel({
      pages: [rows], group: 'state',
      facets: { state: [
        { key: 'todo', label: 'To do', count: 7 }, { key: 'started', label: 'In progress', count: 4 },
        { key: 'done', label: 'Done', count: 0 },
      ] },
      collapsedGroups: ['todo'], cursorKey: 'TAB-1',
    });
    expect(model.groups.map((group) => [group.id, group.label, group.count, group.rows.length, group.collapsed])).toEqual([
      ['todo', 'To do', 7, 2, true], ['started', 'In progress', 4, 1, false], ['done', 'Done', 0, 0, false],
    ]);
    expect(model.visibleRows.map((row) => row.key)).toEqual(['TAB-3']);
    expect(model.cursorKey).toBe('TAB-3');
  });

  it('moves the cursor across expanded groups, skips collapsed groups, and clamps at the ends', () => {
    const model = buildListModel({ pages: [rows], group: 'state', collapsedGroups: ['todo'], cursorKey: 'TAB-3' });
    expect(moveCursor(model, 1).cursorKey).toBe('TAB-3');
    expect(moveCursor(model, -1).cursorKey).toBe('TAB-3');
    const expanded = buildListModel({ pages: [rows], group: 'state', cursorKey: 'TAB-2' });
    expect(moveCursor(expanded, 1).cursorKey).toBe('TAB-3');
    expect(moveCursor(expanded, -1).cursorKey).toBe('TAB-1');
    const noCursor = buildListModel({ pages: [rows], group: 'none', cursorKey: null });
    expect(noCursor.cursorKey).toBe('TAB-1');
    expect(moveCursor(noCursor, 1).cursorKey).toBe('TAB-2');
  });

  it('keeps the cursor and selection when a page appends, then picks the nearest row after refresh', () => {
    const first = buildListModel({ pages: [[rows[0], rows[1]]], group: 'none', cursorKey: 'TAB-2', selectedKeys: ['TAB-1'] });
    const appended = buildListModel({ pages: [[rows[0], rows[1]], [rows[2]]], group: 'none', previous: first });
    expect(appended.cursorKey).toBe('TAB-2');
    expect(appended.selectedKeys).toEqual(['TAB-1']);
    const refreshed = buildListModel({ pages: [[rows[0], rows[2]]], group: 'none', previous: appended });
    expect(refreshed.cursorKey).toBe('TAB-3');
    expect(refreshed.selectedKeys).toEqual(['TAB-1']);
  });

  it('supports X toggle, Shift+Arrow range extension, and select-all of visible rows', () => {
    const model = buildListModel({ pages: [rows], group: 'none', cursorKey: 'TAB-2', anchorKey: 'TAB-1' });
    expect(toggleSelection(model).selectedKeys).toEqual(['TAB-2']);
    expect(toggleSelection(toggleSelection(model)).selectedKeys).toEqual([]);
    const range = extendSelection(moveCursorTo(model, 'TAB-3'), 'TAB-3');
    expect(range.selectedKeys).toEqual(['TAB-1', 'TAB-2', 'TAB-3']);
    expect(selectAll(model).selectedKeys).toEqual(['TAB-1', 'TAB-2', 'TAB-3']);
  });

  it('sorts rows and moves to adjacent ticket pages within the list', () => {
    const model = buildListModel({ pages: [rows], group: 'none', sort: { field: 'title', direction: 'desc' } });
    expect(model.visibleRows.map((row) => row.title)).toEqual(['Gamma', 'Beta', 'Alpha']);
    expect(adjacentTicket(model.visibleRows, 'TAB-2', -1)?.key).toBe('TAB-3');
    expect(adjacentTicket(model.visibleRows, 'TAB-2', 1)?.key).toBe('TAB-1');
    expect(adjacentTicket(model.visibleRows, 'TAB-1', 1)).toBeNull();
    expect(adjacentTicket(model.visibleRows, 'missing', 1)).toBeNull();
  });
});
