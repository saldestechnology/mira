import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFilterBar } from '../src/tracker/ui/filter-bar';
import { build, FilterTokenError, filterChipLabel, parse, type FilterChip } from '../src/tracker/ui/filter';
import { createTrackerVisualSeed } from '../src/tracker/ui/visual-seed';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';
import { FakeElement } from './fake-dom';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; vi.useRealTimers(); });

describe('tracker filter token bridge', () => {
  it('round-trips the data layer grammar, including negation and comma-separated any-of values', () => {
    const tokens = [
      'assignee:me', 'assignee:none', 'assignee:Maya Chen', 'state:in_review', 'state:Done,in_progress',
      '-state:Done,in_progress', 'label:Accessibility,Bug', 'due:overdue', 'due:today', 'due:this-week', 'due:before-2026-12-31',
      'has:link', 'is:archived', 'created:after-2026-01-10', 'design system debt',
    ];
    const chips = parse(tokens);
    expect(build(chips)).toEqual(tokens);
    expect(parse(build(chips))).toEqual(chips);
    expect(filterChipLabel({ field: 'state', value: 'Done', not: true })).toBe('not state: Done');
  });

  it('rejects fields and values the tracker data layer and server do not support', () => {
    for (const token of [
      'unknown:value', 'state:', 'due:before-2026-02-30', 'due:Overdue', 'created:after-2026-1-01', 'has:comment', 'has:Link', 'is:open', 'is:Archived',
      'state:is-not:done', 'creator:Maya', 'priority:high', 'category:completed', 'project:Roadmap', 'milestone:V1',
      'relation:blocked', 'assignee:', 'state:done,',
    ]) {
      let caught: unknown;
      try { parse([token]); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(FilterTokenError);
      expect((caught as FilterTokenError).token).toBe(token);
    }
    expect(parseFilterLabels()).toEqual(['assignee: Me', 'not state: Done']);
  });

  it('handles empty filters and free-text chips', () => {
    expect(parse([])).toEqual([]);
    expect(build([])).toEqual([]);
    expect(filterChipLabel({ field: 'text', value: 'title phrase' })).toBe('title phrase');
    expect(() => build([{ field: 'text', value: '  ' }])).toThrow(FilterTokenError);
  });
});

function parseFilterLabels(): string[] {
  return [
    filterChipLabel({ field: 'assignee', value: 'me' }),
    filterChipLabel({ field: 'state', value: 'Done', not: true }),
  ];
}

describe('tracker one-row filter bar', () => {
  it('suggests fields and values, commits a filter chip, and keeps the active filter labelled', () => {
    browser = installTrackerUiBrowser();
    const changes: FilterChip[][] = [];
    const searches: string[] = [];
    const bar = createFilterBar({ meta: createTrackerVisualSeed().meta, onChange: (chips) => changes.push([...chips]), onSearch: (query) => searches.push(query) });
    browser.mount().appendChild(bar.el as unknown as FakeElement);
    const input = bar.el.querySelector('.trk-filter-input') as unknown as FakeElement;

    bar.open();
    input.value = 'sta';
    input.dispatchEvent(uiEvent('input'));
    expect(Array.from(bar.el.querySelectorAll('[role="option"]')).map((option) => option.textContent)).toContain('state:');
    const tab = uiEvent('keydown', { key: 'Tab' });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(input.value).toBe('state:');

    input.value = 'state:In';
    input.dispatchEvent(uiEvent('input'));
    input.dispatchEvent(uiEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(input.value).toBe('state:In progress');
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(bar.getChips()).toEqual([{ field: 'state', value: 'In progress' }]);
    expect(bar.el.textContent).toContain('state: In progress');
    expect(changes).toHaveLength(1);
    input.value = 'due:';
    input.dispatchEvent(uiEvent('input'));
    expect(Array.from(bar.el.querySelectorAll('[role="option"]')).map((option) => option.textContent)).toContain('due: This week');
    expect(searches).toEqual(['', '', '', '', '', '']);
  });

  it('locks view filters, removes the last editable chip with Backspace, and displays invalid_filter inline', () => {
    browser = installTrackerUiBrowser();
    const bar = createFilterBar({ initial: [
      { field: 'assignee', value: 'me', locked: true }, { field: 'state', value: 'in_progress' }, { field: 'has', value: 'link' },
    ] });
    browser.mount().appendChild(bar.el as unknown as FakeElement);
    const input = bar.el.querySelector('.trk-filter-input') as unknown as FakeElement;
    input.dispatchEvent(uiEvent('keydown', { key: 'Backspace' }));
    expect(bar.getChips().map((chip) => chip.value)).toEqual(['me', 'in_progress']);
    expect(bar.el.querySelectorAll('.trk-filter-chip button')).toHaveLength(1);

    input.value = 'priority:high';
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(bar.getChips()).toHaveLength(2);
    expect(bar.el.querySelector('[role="alert"]')?.textContent).toBe('Invalid filter: priority:high');
    bar.setError('Unsupported filter priority:high.');
    expect(bar.el.querySelector('[role="alert"]')?.textContent).toBe('Unsupported filter priority:high.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.dispatchEvent(uiEvent('keydown', { key: 'Escape' }));
    expect(bar.suggestionsOpen()).toBe(false);
  });

  it('uses the same input for free-text search and hides suggestions on Escape', () => {
    browser = installTrackerUiBrowser();
    const searches: string[] = [];
    const bar = createFilterBar({ onSearch: (query) => searches.push(query) });
    browser.mount().appendChild(bar.el as unknown as FakeElement);
    const input = bar.el.querySelector('.trk-filter-input') as unknown as FakeElement;
    input.value = 'layout';
    input.dispatchEvent(uiEvent('input'));
    expect(searches).toEqual(['layout']);
    expect(input.getAttribute('placeholder')).toBe('Filter or search');
    expect(bar.suggestionsOpen()).toBe(false);
    input.value = 'sta';
    input.dispatchEvent(uiEvent('input'));
    expect(bar.suggestionsOpen()).toBe(true);
    input.dispatchEvent(uiEvent('keydown', { key: 'Escape' }));
    expect(bar.suggestionsOpen()).toBe(false);
    expect(bar.el.querySelector('.trk-filter-editor')).toBeNull();
  });
});
