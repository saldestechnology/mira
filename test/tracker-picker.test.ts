import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPicker } from '../src/tracker/ui/picker';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';
import { FakeElement } from './fake-dom';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; vi.useRealTimers(); });

describe('tracker listbox picker', () => {
  it('opens at its anchor with named options and roving active descendant', async () => {
    browser = installTrackerUiBrowser();
    const anchor = browser.document.createElement('button') as unknown as HTMLElement;
    anchor.textContent = 'State';
    browser.document.body.appendChild(anchor as unknown as FakeElement);
    const picked = openPicker(anchor, { label: 'State', value: 'todo', options: [
      { value: 'todo', label: 'To do' }, { value: 'started', label: 'In progress' },
    ] });
    const list = browser.document.querySelector('[role="listbox"]')!;
    expect(list.getAttribute('aria-label')).toBe('State');
    expect(list.getAttribute('aria-activedescendant')).toBe('trk-picker-1-option-1');
    expect(browser.document.activeElement).toBe(list);
    const rows = browser.document.querySelectorAll('[role="option"]');
    expect(rows.map((row) => row.textContent)).toEqual(['None', 'To do', 'In progress']);
    list.dispatchEvent(uiEvent('keydown', { key: 'ArrowDown' }));
    expect(list.getAttribute('aria-activedescendant')).toBe('trk-picker-1-option-2');
    list.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    await expect(picked).resolves.toBe('started');
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('supports digits for short lists and includes a No one or None option', async () => {
    browser = installTrackerUiBrowser();
    const anchor = browser.document.createElement('button') as unknown as HTMLElement;
    browser.document.body.appendChild(anchor as unknown as FakeElement);
    const result = openPicker(anchor, { label: 'Assignee', emptyLabel: 'No one', options: [
      { value: 'maya', label: 'Maya Chen' }, { value: 'jon', label: 'Jon Bell' },
    ] });
    const list = browser.document.querySelector('[role="listbox"]')!;
    expect(browser.document.querySelectorAll('[role="option"]')[0].textContent).toBe('No one');
    list.dispatchEvent(uiEvent('keydown', { key: '2' }));
    await expect(result).resolves.toBe('maya');
  });

  it('keeps multi selection until Done and returns checked options', async () => {
    browser = installTrackerUiBrowser();
    const anchor = browser.document.createElement('button') as unknown as HTMLElement;
    browser.document.body.appendChild(anchor as unknown as FakeElement);
    const result = openPicker(anchor, {
      label: 'Labels', multi: true, selected: ['bug'], emptyLabel: 'None',
      options: [{ value: 'bug', label: 'Bug' }, { value: 'design', label: 'Design' }],
    });
    const options = browser.document.querySelectorAll('[role="option"]');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    options[2].click();
    expect(browser.document.querySelectorAll('[role="option"]')[2].getAttribute('aria-selected')).toBe('true');
    expect(browser.document.querySelector('.trk-picker-list')).not.toBeNull();
    browser.document.querySelector('.popover button')?.click();
    await expect(result).resolves.toEqual(['bug', 'design']);
  });

  it('autofocuses search only above twelve choices and Escape dismisses without changing selection', async () => {
    browser = installTrackerUiBrowser();
    const smallAnchor = browser.document.createElement('button') as unknown as HTMLElement;
    browser.document.body.appendChild(smallAnchor as unknown as FakeElement);
    const smallResult = openPicker(smallAnchor, { label: 'Priority', options: [{ value: 'high', label: 'High' }] });
    expect((browser.document.activeElement as unknown as { tagName: string }).tagName).toBe('UL');
    browser.dispatchWindow(uiEvent('keydown', { key: 'Escape' }));
    await expect(smallResult).resolves.toBeUndefined();

    const longAnchor = browser.document.createElement('button') as unknown as HTMLElement;
    browser.document.body.appendChild(longAnchor as unknown as FakeElement);
    const longResult = openPicker(longAnchor, { label: 'People', options: Array.from({ length: 13 }, (_, index) => ({ value: index, label: `Person ${index + 1}` })) });
    expect((browser.document.activeElement as unknown as { getAttribute: (name: string) => string | null }).getAttribute('aria-label')).toBe('Search people');
    browser.dispatchWindow(uiEvent('keydown', { key: 'Escape' }));
    await expect(longResult).resolves.toBeUndefined();
  });

  it('filters options from the type-ahead search field', () => {
    browser = installTrackerUiBrowser();
    const anchor = browser.document.createElement('button') as unknown as HTMLElement;
    browser.document.body.appendChild(anchor as unknown as FakeElement);
    void openPicker(anchor, { label: 'People', options: Array.from({ length: 13 }, (_, index) => ({ value: index, label: index === 5 ? 'Maya Chen' : `Person ${index}` })) });
    const search = browser.document.querySelector('.trk-picker-search') as FakeElement;
    search.value = 'maya';
    search.dispatchEvent(uiEvent('input'));
    expect(browser.document.querySelectorAll('[role="option"]').map((row) => row.textContent)).toEqual(['Maya Chen']);
  });
});
