import { h } from '../../ui/dom';
import type { TrackerMeta } from '../../tracker-types';
import { build, filterChipLabel, parse, type FilterChip, type FilterField } from './filter';
import './tracker.css';

const FILTER_FIELDS: FilterField[] = ['assignee', 'state', 'label', 'due', 'has', 'is', 'created'];
let filterBarSequence = 0;

interface Suggestion { value: string; label: string }

export interface FilterBarOptions {
  initial?: readonly FilterChip[];
  meta?: Pick<TrackerMeta, 'states' | 'labels' | 'members'>;
  onChange?: (chips: readonly FilterChip[]) => void;
  onSearch?: (query: string) => void;
}

export interface FilterBarController {
  el: HTMLElement;
  open(): void;
  close(): void;
  setChips(chips: readonly FilterChip[]): void;
  getChips(): FilterChip[];
  setError(message: string | null): void;
  suggestionsOpen(): boolean;
  focusSearch(): void;
}

/** One keyboard-first input for filter tokens and free-text search, with metadata-backed suggestions. */
export function createFilterBar(options: FilterBarOptions = {}): FilterBarController {
  let chips = [...(options.initial ?? [])];
  let suggestions: Suggestion[] = [];
  let activeSuggestion = -1;
  const id = `trk-filter-${++filterBarSequence}`;
  const chipsEl = h('div', { class: 'trk-filter-chips', 'aria-label': 'Active filters' });
  const input = h('input', {
    class: 'trk-filter-input', type: 'text', placeholder: 'Filter or search',
    'aria-label': 'Filter or search', 'aria-autocomplete': 'list', 'aria-controls': `${id}-suggestions`,
    'aria-expanded': 'false', autocomplete: 'off', spellcheck: 'false',
  });
  const suggestionsEl = h('div', {
    class: 'trk-filter-suggestions', id: `${id}-suggestions`, role: 'listbox', 'aria-label': 'Filter suggestions', hidden: true,
  });
  const inputWrap = h('div', { class: 'trk-filter-input-wrap' }, input, suggestionsEl);
  const errorEl = h('div', { class: 'trk-filter-error', role: 'alert', hidden: true });
  const root = h('div', { class: 'trk trk-filter-bar', role: 'search', 'aria-label': 'Tracker filters' }, chipsEl, inputWrap, errorEl);

  const emit = () => options.onChange?.([...chips]);
  const renderChips = () => {
    chipsEl.replaceChildren(...chips.map((chip, index) => {
      const label = filterChipLabel(chip);
      return h('span', { class: `trk-filter-chip${chip.locked ? ' is-locked' : ''}`, 'data-locked': String(Boolean(chip.locked)) },
        h('span', null, label),
        chip.locked ? null : h('button', {
          type: 'button', 'aria-label': `Remove ${label}`, onclick: () => removeAt(index),
        }, '×'),
      );
    }));
  };
  const removeAt = (index: number) => {
    if (index < 0 || index >= chips.length || chips[index].locked) return;
    chips.splice(index, 1);
    clearError();
    renderChips();
    emit();
  };
  const clearError = () => {
    errorEl.hidden = true;
    errorEl.textContent = '';
    input.removeAttribute('aria-invalid');
  };
  const day = new Date().toISOString().slice(0, 10);
  const valuesFor = (field: string): Suggestion[] => {
    if (field === 'assignee') return [
      { value: 'me', label: 'Me' }, { value: 'none', label: 'No one' },
      ...(options.meta?.members ?? []).map((member) => ({ value: member.name, label: member.name })),
    ];
    if (field === 'state') return (options.meta?.states ?? []).map((state) => ({ value: state.name, label: state.name }));
    if (field === 'label') return (options.meta?.labels ?? []).map((label) => ({ value: label.name, label: label.name }));
    if (field === 'due') return [
      { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Today' },
      { value: 'this-week', label: 'This week' }, { value: `before-${day}`, label: `Before ${day}` },
    ];
    if (field === 'has') return [{ value: 'link', label: 'Link' }];
    if (field === 'is') return [{ value: 'archived', label: 'Archived' }];
    if (field === 'created') return [{ value: `after-${day}`, label: `After ${day}` }];
    return [];
  };
  const fieldPrefix = (raw: string): { prefix: string; not: boolean } | null => {
    const not = raw.startsWith('-');
    const prefix = not ? raw.slice(1) : raw;
    return prefix && FILTER_FIELDS.some((field) => field.startsWith(prefix.toLowerCase())) ? { prefix, not } : null;
  };
  const suggestionsFor = (raw: string): Suggestion[] => {
    const colon = raw.indexOf(':');
    const not = raw.startsWith('-');
    const source = not ? raw.slice(1) : raw;
    if (colon < 0) {
      const prefix = source.toLowerCase();
      const fields = FILTER_FIELDS.filter((field) => field.startsWith(prefix)).map((field) => ({
        value: `${not ? '-' : ''}${field}:`, label: `${not ? 'not ' : ''}${field}:`,
      }));
      return fields;
    }
    const localColon = source.indexOf(':');
    if (localColon < 1) return [];
    const field = source.slice(0, localColon).toLowerCase();
    if (!FILTER_FIELDS.includes(field as FilterField)) return [];
    const prefix = source.slice(localColon + 1).toLowerCase();
    const suggestions = valuesFor(field).filter((value) => value.value.toLowerCase().startsWith(prefix));
    return suggestions.map((value) => ({
      value: `${not ? '-' : ''}${field}:${value.value}`,
      label: `${not ? 'not ' : ''}${field}: ${value.label}`,
    }));
  };
  const renderSuggestions = () => {
    suggestionsEl.hidden = suggestions.length === 0;
    input.setAttribute('aria-expanded', String(!suggestionsEl.hidden));
    suggestionsEl.replaceChildren(...suggestions.map((suggestion, index) => h('div', {
      class: `trk-filter-suggestion${index === activeSuggestion ? ' active' : ''}`,
      role: 'option', id: `${id}-option-${index}`, 'aria-selected': String(index === activeSuggestion),
      onclick: () => acceptSuggestion(index),
    }, suggestion.label)));
    if (activeSuggestion >= 0 && suggestions[activeSuggestion]) input.setAttribute('aria-activedescendant', `${id}-option-${activeSuggestion}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const updateSuggestions = () => {
    suggestions = suggestionsFor(input.value.trim());
    activeSuggestion = -1;
    renderSuggestions();
  };
  const updateSearch = () => {
    const raw = input.value.trim();
    if (!raw.includes(':') && !fieldPrefix(raw)) options.onSearch?.(raw);
    else options.onSearch?.('');
  };
  const acceptSuggestion = (index: number) => {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    input.value = suggestion.value;
    clearError();
    updateSearch();
    updateSuggestions();
    input.focus();
    input.setSelectionRange?.(input.value.length, input.value.length);
  };
  const hideSuggestions = () => {
    suggestions = [];
    activeSuggestion = -1;
    renderSuggestions();
  };
  const addChip = () => {
    const source = input.value.trim();
    if (!source.includes(':')) return false;
    let chip: FilterChip;
    try { [chip] = parse([source]); }
    catch {
      errorEl.textContent = `Invalid filter: ${source}`;
      errorEl.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      return false;
    }
    if (chip.field === 'text') return false;
    clearError();
    chips.push(chip);
    renderChips();
    emit();
    input.value = '';
    updateSearch();
    updateSuggestions();
    input.focus();
    return true;
  };

  input.addEventListener('input', () => {
    clearError();
    updateSearch();
    updateSuggestions();
  });
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!suggestions.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      activeSuggestion = (activeSuggestion + delta + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeSuggestion >= 0) acceptSuggestion(activeSuggestion);
      else addChip();
    } else if (event.key === 'Tab') {
      if (activeSuggestion >= 0) { event.preventDefault(); acceptSuggestion(activeSuggestion); }
      else if (suggestions.length) { event.preventDefault(); acceptSuggestion(0); }
      else if (input.value.includes(':')) { event.preventDefault(); addChip(); }
    } else if (event.key === 'Escape') {
      if (!suggestionsEl.hidden) { event.preventDefault(); hideSuggestions(); }
      clearError();
    } else if (event.key === 'Backspace' && !input.value && chips.some((chip) => !chip.locked)) {
      event.preventDefault();
      for (let index = chips.length - 1; index >= 0; index--) if (!chips[index].locked) { removeAt(index); break; }
    }
  });

  const controller: FilterBarController = {
    el: root,
    open() { input.focus(); updateSuggestions(); },
    close() { hideSuggestions(); },
    setChips(next) {
      build(next);
      chips = [...next];
      renderChips();
    },
    getChips() { return [...chips]; },
    setError(message) {
      errorEl.textContent = message ?? '';
      errorEl.hidden = !message;
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
    suggestionsOpen() { return !suggestionsEl.hidden; },
    focusSearch() { input.focus(); updateSuggestions(); },
  };
  renderChips();
  renderSuggestions();
  return controller;
}
