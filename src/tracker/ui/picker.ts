import './tracker.css';
import { h } from '../../ui/dom';
import { popover } from '../../ui/common';

export interface PickerOption<T> {
  value: T | null;
  label: string;
  group?: string;
  disabled?: boolean;
}

export interface PickerOptions<T> {
  label: string;
  options: readonly PickerOption<T>[];
  value?: T | null;
  selected?: readonly (T | null)[];
  multi?: boolean;
  emptyLabel?: 'No one' | 'None';
}

export type PickerResult<T> = T | null | readonly (T | null)[] | undefined;

let pickerId = 0;

/** Opens an anchored, keyboard-operable listbox. Undefined means dismissed; null is a deliberately chosen empty value. */
export function openPicker<T>(anchor: HTMLElement, options: PickerOptions<T>): Promise<PickerResult<T>> {
  const id = `trk-picker-${++pickerId}`;
  const items = [...options.options];
  const emptyLabel = options.emptyLabel ?? (options.label.toLocaleLowerCase().includes('assignee') ? 'No one' : 'None');
  if (!items.some((item) => item.value === null)) items.unshift({ value: null, label: emptyLabel });
  const search = h('input', {
    class: 'trk-picker-search', type: 'search', 'aria-label': `Search ${options.label.toLowerCase()}`,
    placeholder: 'Search', autocomplete: 'off', spellcheck: 'false',
  });
  const list = h('ul', {
    class: 'trk-picker-list', id: `${id}-list`, role: 'listbox', 'aria-label': options.label,
    'aria-multiselectable': options.multi ? 'true' : undefined, tabindex: '0',
  });
  const selected = new Set<T | null>(options.multi ? options.selected ?? [] : options.value === undefined ? [] : [options.value]);
  let active = Math.max(0, items.findIndex((item) => selected.has(item.value)));
  let searchText = '';
  let typeahead = '';
  let typeaheadTimer = 0;
  let rowEls: HTMLLIElement[] = [];
  const content = h('div', { class: 'trk-picker' });
  const done = options.multi ? h('button', { class: 'trk-small-button', type: 'button' }, 'Done') : null;
  if (items.length > 12) content.append(search, list);
  else content.append(list, search);
  if (done) content.append(done);

  let pop: ReturnType<typeof popover> | null = null;
  let settled = false;
  let resolveResult: (result: PickerResult<T>) => void = () => {};
  const result = new Promise<PickerResult<T>>((resolve) => { resolveResult = resolve; });
  const closeWith = (value: PickerResult<T>) => {
    if (settled) return;
    settled = true;
    resolveResult(value);
    pop?.close();
  };

  const visibleItems = () => items.map((item, index) => ({ item, index })).filter(({ item }) => item.label.toLocaleLowerCase().includes(searchText));
  const syncActive = (next: number) => {
    const visible = visibleItems();
    if (!visible.length) {
      active = -1;
      list.removeAttribute('aria-activedescendant');
      return;
    }
    const currentVisible = visible.findIndex(({ index }) => index === next);
    const at = currentVisible < 0 ? Math.max(0, Math.min(visible.length - 1, next)) : currentVisible;
    active = visible[at].index;
    const activeId = `${id}-option-${active}`;
    list.setAttribute('aria-activedescendant', activeId);
    rowEls.forEach((row, index) => {
      const visibleIndex = visible[index]?.index;
      row.classList.toggle('active', visibleIndex === active);
    });
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  };
  const render = () => {
    searchText = search.value.trim().toLocaleLowerCase();
    const visible = visibleItems();
    list.replaceChildren();
    rowEls = [];
    let lastGroup: string | undefined;
    for (const { item, index } of visible) {
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group;
        list.appendChild(h('li', { class: 'trk-picker-group', role: 'presentation' }, item.group));
      }
      const row = h('li', {
        id: `${id}-option-${index}`, class: 'trk-picker-option', role: 'option',
        'aria-selected': String(selected.has(item.value)), 'aria-disabled': String(Boolean(item.disabled)),
      }, item.label);
      row.addEventListener('pointerenter', () => {
        if (!item.disabled) syncActive(index);
      });
      row.addEventListener('click', () => {
        if (item.disabled) return;
        choose(item.value);
      });
      rowEls.push(row);
      list.appendChild(row);
    }
    if (!visible.length) list.appendChild(h('li', { class: 'trk-picker-empty', role: 'presentation' }, 'No matches'));
    syncActive(active < 0 ? 0 : active);
  };
  const choose = (value: T | null) => {
    if (options.multi) {
      if (value === null) {
        selected.clear();
        selected.add(null);
      } else {
        selected.delete(null);
        if (selected.has(value)) selected.delete(value);
        else selected.add(value);
      }
      render();
      return;
    }
    closeWith(value);
  };

  list.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const visible = visibleItems();
      if (visible.length) {
        const at = Math.max(0, visible.findIndex(({ index }) => index === active));
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        for (let step = 1; step <= visible.length; step++) {
          const next = (at + delta * step + visible.length) % visible.length;
          if (!visible[next].item.disabled) { syncActive(visible[next].index); break; }
        }
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[active];
      if (item && !item.disabled) choose(item.value);
    } else if (/^\d$/.test(event.key) && items.length <= 12) {
      const index = event.key === '0' ? 0 : Number(event.key) - 1;
      if (items[index] && !items[index].disabled) {
        event.preventDefault();
        choose(items[index].value);
      }
    } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      typeahead += event.key.toLocaleLowerCase();
      clearTimeout(typeaheadTimer);
      typeaheadTimer = window.setTimeout(() => { typeahead = ''; }, 700);
      const found = visibleItems().find(({ item }) => item.label.toLocaleLowerCase().startsWith(typeahead));
      if (found) syncActive(found.index);
    }
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list.focus({ preventScroll: true });
    } else if (event.key === 'Enter') {
      const item = items[active];
      if (item && !item.disabled) { event.preventDefault(); choose(item.value); }
    }
  });
  done?.addEventListener('click', () => closeWith([...selected]));
  render();
  const phone = window.innerWidth < 600;
  pop = popover(anchor, content, {
    side: phone ? 'bottom' : undefined,
    className: `trk trk-pop${phone ? ' trk-pop-sheet' : ''}`,
    label: options.label,
    onClose: () => {
      clearTimeout(typeaheadTimer);
      anchor.setAttribute('aria-expanded', 'false');
      if (!settled) {
        settled = true;
        resolveResult(undefined);
      }
    },
  });
  anchor.setAttribute('aria-expanded', 'true');
  return result;
}
