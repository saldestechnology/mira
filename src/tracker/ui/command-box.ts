import './tracker.css';
import { h } from '../../ui/dom';
import { popover } from '../../ui/common';
import { parseTicketKey } from './keys-util';
import { renderSnippet } from './snippet';

export type CommandItemKind = 'tab' | 'ticket' | 'action' | 'view';
export interface CommandItem {
  id: string;
  kind: CommandItemKind;
  label: string;
  hint?: string;
  snippet?: string;
  key?: string;
  aliases?: readonly string[];
  run?: () => void;
}

export interface CommandBoxOptions {
  items: readonly CommandItem[];
  searchTickets?: (query: string) => Promise<readonly CommandItem[]> | readonly CommandItem[];
  onSelect?: (item: CommandItem) => void;
  onClose?: () => void;
  debounceMs?: number;
}

export interface SavedViewItem { id: string; name: string }
export interface CommandCatalogOptions {
  views?: readonly SavedViewItem[];
  actions?: readonly CommandItem[];
}

const TRACKER_TABS: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: 'inbox', label: 'Go to Inbox', hint: 'Tracker tab' },
  { id: 'my', label: 'Go to My issues', hint: 'Tracker tab' },
  { id: 'all', label: 'Go to All issues', hint: 'Tracker tab' },
  { id: 'board', label: 'Go to Board', hint: 'Tracker tab' },
  { id: 'projects', label: 'Go to Projects', hint: 'Tracker tab' },
];

/** Base palette entries; callers add workspace actions and saved views from their data source. */
export function buildCommandItems(options: CommandCatalogOptions = {}): CommandItem[] {
  return [
    ...TRACKER_TABS.map((tab) => ({ id: `tab:${tab.id}`, kind: 'tab' as const, label: tab.label, hint: tab.hint })),
    { id: 'action:assign-to-me', kind: 'action', label: 'Assign to me', hint: 'Selected tickets' },
    { id: 'action:move-project', kind: 'action', label: 'Move to project…', hint: 'Selected tickets' },
    ...(options.actions ?? []),
    ...(options.views ?? []).map((view) => ({ id: `view:${view.id}`, kind: 'view' as const, label: view.name, hint: 'Saved view' })),
  ];
}

export interface CommandBoxController {
  el: HTMLElement;
  input: HTMLInputElement;
  list: HTMLUListElement;
  close(): void;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** Stable relevance ranking for tabs, tickets, actions, and saved views. */
export function rankCommands(query: string, items: readonly CommandItem[]): CommandItem[] {
  const needle = normalized(query);
  if (!needle) return [...items];
  const parsedNeedle = parseTicketKey(query)?.key;
  const score = (item: CommandItem): number => {
    if (parsedNeedle && item.kind === 'ticket') {
      if (parseTicketKey(item.key ?? '')?.key === parsedNeedle) return 10_000;
      if (item.aliases?.some((alias) => parseTicketKey(alias)?.key === parsedNeedle)) return 9_500;
      if (normalized(item.key ?? '').startsWith(needle)) return 8_000;
    }
    const label = normalized(item.label);
    const hint = normalized(item.hint ?? '');
    if (label === needle) return 7_000;
    if (label.startsWith(needle)) return 6_000;
    if (label.includes(needle)) return 4_000;
    if (hint.startsWith(needle)) return 2_000;
    if (hint.includes(needle)) return 1_000;
    const words = needle.split(/\s+/u).filter(Boolean);
    const combined = `${label} ${hint}`;
    return words.length > 1 && words.every((word) => combined.includes(word)) ? 500 : 0;
  };
  return items.map((item, index) => ({ item, index, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

/** Opens a Cmd/Ctrl+K command palette at the supplied anchor. The caller maps the key action to this function. */
export function openCommandBox(anchor: HTMLElement, options: CommandBoxOptions): CommandBoxController {
  const id = `trk-command-${++commandSeq}`;
  const input = h('input', {
    class: 'trk-command-input', type: 'search', role: 'combobox', 'aria-label': 'Search commands',
    'aria-haspopup': 'listbox', 'aria-expanded': 'true', 'aria-controls': `${id}-results`,
    placeholder: 'Search tickets, views, or actions', autocomplete: 'off', spellcheck: 'false',
  });
  const list = h('ul', { class: 'trk-command-results', id: `${id}-results`, role: 'listbox', 'aria-label': 'Command results' });
  const content = h('div', { class: 'trk trk-command-box' }, input, list);
  let results = [...options.items];
  let active = -1;
  let timer = 0;
  let requestId = 0;
  let closed = false;
  let pop: ReturnType<typeof popover> | null = null;
  const debounceMs = Math.max(0, options.debounceMs ?? 180);

  const choose = (item: CommandItem | undefined) => {
    if (!item || closed) return;
    item.run?.();
    options.onSelect?.(item);
    close();
  };
  const render = () => {
    const ranked = rankCommands(input.value, results);
    list.replaceChildren();
    if (!ranked.length) {
      list.appendChild(h('li', { class: 'trk-command-empty', role: 'presentation' }, 'No matching commands'));
      active = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    if (active < 0 || active >= ranked.length) active = 0;
    ranked.forEach((item, index) => {
      const row = h('li', {
        class: `trk-command-option${active === index ? ' active' : ''}`,
        id: `${id}-option-${index}`, role: 'option', 'aria-selected': String(active === index),
      }, h('span', null, item.label), item.hint ? h('span', { class: 'trk-muted' }, item.hint) : null,
      item.snippet ? h('span', { class: 'trk-search-snippet' }, renderSnippet(item.snippet)) : null);
      row.addEventListener('pointerenter', () => { active = index; render(); });
      row.addEventListener('click', () => choose(item));
      list.appendChild(row);
    });
    input.setAttribute('aria-activedescendant', `${id}-option-${active}`);
  };
  const updateSearch = () => {
    clearTimeout(timer);
    const query = input.value.trim();
    results = [...options.items];
    active = 0;
    render();
    if (!query || !options.searchTickets) return;
    const current = ++requestId;
    timer = window.setTimeout(async () => {
      try {
        const found = await options.searchTickets!(query);
        if (closed || current !== requestId || input.value.trim() !== query) return;
        const byId = new Map(options.items.map((item) => [item.id, item]));
        for (const item of found) byId.set(item.id, item);
        results = [...byId.values()];
        active = 0;
        render();
      } catch {
        if (!closed && current === requestId && input.value.trim() === query) {
          results = [...options.items];
          render();
        }
      }
    }, debounceMs);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    input.setAttribute('aria-expanded', 'false');
    pop?.close();
    options.onClose?.();
  };

  input.addEventListener('input', updateSearch);
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    const ranked = rankCommands(input.value, results);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!ranked.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + delta + ranked.length) % ranked.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(ranked[active]);
    }
  });
  render();
  pop = popover(anchor, content, {
    className: 'trk trk-pop trk-command-pop', label: 'Command box',
    onClose: () => {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        input.setAttribute('aria-expanded', 'false');
        options.onClose?.();
      }
    },
  });
  // Explicit close and Escape/outside close share one completion callback.
  const controller: CommandBoxController = { el: pop.el, input, list, close };
  return controller;
}

let commandSeq = 0;
