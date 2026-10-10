import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCommandItems, openCommandBox, rankCommands, type CommandItem } from '../src/tracker/ui/command-box';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';
import { FakeElement } from './fake-dom';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; vi.useRealTimers(); });

const candidates: CommandItem[] = [
  { id: 'title-hit', kind: 'ticket', key: 'TAB-310', label: 'Improve keyboard focus', hint: 'Ticket' },
  { id: 'alias-hit', kind: 'ticket', key: 'TAB-45', aliases: ['ENG-45'], label: 'Imported issue', hint: 'Ticket' },
  { id: 'view', kind: 'view', label: 'Keyboard review', hint: 'Saved view' },
  { id: 'tab', kind: 'tab', label: 'All issues', hint: 'Go to tab' },
  { id: 'action', kind: 'action', label: 'Assign to me', hint: 'Action' },
];

describe('tracker command ranking', () => {
  it('ranks an exact canonical key and alias ahead of title results', () => {
    expect(rankCommands('tab-310', candidates).map((item) => item.id)[0]).toBe('title-hit');
    expect(rankCommands('ENG-45', candidates).map((item) => item.id)[0]).toBe('alias-hit');
  });

  it('ranks title prefixes and exact labels above title substrings', () => {
    const items: CommandItem[] = [
      { id: 'inside', kind: 'ticket', label: 'A keyboard has focus' },
      { id: 'prefix', kind: 'ticket', label: 'Keyboard navigation' },
      { id: 'exact', kind: 'view', label: 'keyboard' },
    ];
    expect(rankCommands('keyboard', items).map((item) => item.id)).toEqual(['exact', 'prefix', 'inside']);
  });

  it('returns supplied tabs, saved views, and actions when the query is empty', () => {
    expect(rankCommands('', candidates).map((item) => item.kind)).toEqual(['ticket', 'ticket', 'view', 'tab', 'action']);
  });

  it('builds go-to-tab, action, and saved-view palette entries', () => {
    const items = buildCommandItems({ views: [{ id: 'mine', name: 'My active issues' }] });
    expect(items.filter((item) => item.kind === 'tab')).toHaveLength(5);
    expect(items.map((item) => item.id)).toContain('action:assign-to-me');
    expect(items.map((item) => item.id)).toContain('action:move-project');
    expect(items.find((item) => item.id === 'view:mine')).toMatchObject({ kind: 'view', label: 'My active issues' });
  });
});

describe('tracker command palette', () => {
  it('debounces title search and exposes a combobox/listbox operated with arrows and Enter', async () => {
    browser = installTrackerUiBrowser();
    vi.useFakeTimers();
    const anchor = browser.document.createElement('button') as unknown as HTMLElement;
    anchor.textContent = 'Open commands';
    browser.document.body.appendChild(anchor as unknown as FakeElement);
    const onSearch = vi.fn<(query: string) => Promise<readonly CommandItem[]>>().mockResolvedValue([
      { id: 'dynamic', kind: 'ticket', key: 'TAB-99', label: 'Keyboard command tests', hint: 'TAB-99' },
    ]);
    const onSelect = vi.fn<(item: CommandItem) => void>();
    const box = openCommandBox(anchor, { items: candidates, searchTickets: onSearch, onSelect, debounceMs: 25 });
    expect(box.input.getAttribute('role')).toBe('combobox');
    expect(box.input.getAttribute('aria-expanded')).toBe('true');
    expect(box.list.getAttribute('role')).toBe('listbox');
    box.input.value = 'keyboard command';
    (box.input as unknown as FakeElement).dispatchEvent(uiEvent('input'));
    await vi.advanceTimersByTimeAsync(24);
    expect(onSearch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSearch).toHaveBeenCalledWith('keyboard command');
    await vi.runAllTicks();
    expect(box.list.textContent).toContain('Keyboard command tests');
    expect(box.input.getAttribute('aria-activedescendant')).toBeTruthy();
    (box.input as unknown as FakeElement).dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'dynamic' }));
    expect(box.input.getAttribute('aria-expanded')).toBe('false');
  });

  it('supports selecting supplied actions, tabs, and saved views and closes on Escape', () => {
    browser = installTrackerUiBrowser();
    const anchor = browser.document.createElement('button') as unknown as HTMLElement;
    browser.document.body.appendChild(anchor as unknown as FakeElement);
    const selected = vi.fn<(item: CommandItem) => void>();
    const closed = vi.fn<() => void>();
    const box = openCommandBox(anchor, { items: candidates, onSelect: selected, onClose: closed });
    box.input.value = 'All issues';
    (box.input as unknown as FakeElement).dispatchEvent(uiEvent('input'));
    (box.input as unknown as FakeElement).dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tab', label: 'All issues' }));
    expect(closed).toHaveBeenCalledTimes(1);

    const second = openCommandBox(anchor, { items: candidates, onClose: closed });
    browser.dispatchWindow(uiEvent('keydown', { key: 'Escape' }));
    expect(second.input.getAttribute('aria-expanded')).toBe('false');
    expect(closed).toHaveBeenCalledTimes(2);
  });
});
