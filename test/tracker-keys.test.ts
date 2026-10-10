import { describe, expect, it } from 'vitest';
import { isNativeActivationTarget, PLATFORM_MODIFIER, resolveKey, SHORTCUTS, type KeyEventLike, type KeyState } from '../src/tracker/ui/keys';
import { FakeElement } from './fake-dom';

function key(keyName: string, options: Partial<KeyEventLike> = {}): KeyEventLike & { prevented: boolean } {
  const event = {
    key: keyName, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, timeStamp: 100,
    target: null, prevented: false,
    preventDefault() { this.prevented = true; },
    ...options,
  };
  return event;
}

const state: KeyState = { active: true, modifier: 'ctrl', layers: ['work'] };
const eventTarget = (element: FakeElement) => element as unknown as EventTarget;

describe('tracker key resolver', () => {
  it('resolves every single-key list and global binding from the shortcut map', () => {
    const cases: Array<[string, Partial<KeyEventLike>, string]> = [
      ['c', {}, 'create'], ['/', {}, 'focus-search'], ['f', {}, 'open-filter'], ['?', { shiftKey: true }, 'shortcut-sheet'],
      ['Enter', { shiftKey: true }, 'expand'], ['ArrowUp', {}, 'move-cursor'], ['ArrowDown', {}, 'move-cursor'],
      ['ArrowUp', { shiftKey: true }, 'move-cursor'], ['ArrowDown', { shiftKey: true }, 'move-cursor'],
      ['k', {}, 'move-cursor'], ['j', {}, 'move-cursor'], ['ArrowLeft', {}, 'group'], ['ArrowRight', {}, 'group'],
      ['Enter', {}, 'open-ticket'], [' ', {}, 'peek'], ['x', {}, 'toggle-selection'], ['s', {}, 'open-picker'],
      ['a', {}, 'open-picker'], ['p', {}, 'open-picker'], ['l', {}, 'open-picker'], ['d', {}, 'open-picker'],
      ['m', {}, 'open-picker'], ['Home', {}, 'move-to-edge'], ['End', {}, 'move-to-edge'],
      ['PageUp', {}, 'page'], ['PageDown', {}, 'page'], ['Backspace', {}, 'archive'], ['Delete', {}, 'archive'],
    ];
    for (const [keyName, modifiers, type] of cases) {
      expect(resolveKey(state, key(keyName, modifiers)).action?.type, `${keyName}`).toBe(type);
    }
    const mod = { ctrlKey: true };
    expect(resolveKey(state, key('k', mod)).action?.type).toBe('command-box');
    expect(resolveKey(state, key('a', mod)).action?.type).toBe('select-all');
    expect(resolveKey(state, key('z', mod)).action?.type).toBe('undo');
    expect(resolveKey(state, key('z', { ...mod, shiftKey: true })).action?.type).toBe('redo');
    expect(resolveKey(state, key('c', { ...mod, shiftKey: true })).action?.type).toBe('copy-link');
    expect(resolveKey(state, key('c', { ...mod, altKey: true })).action?.type).toBe('copy-key');
    expect(resolveKey(state, key('Escape')).action).toEqual({ type: 'escape', layer: 'work' });
    for (const [keyName, modifiers] of cases) {
      expect(SHORTCUTS.some((row) => row.keys.length > 0), `${keyName} has a populated shortcut sheet`).toBe(true);
      expect(resolveKey(state, key(keyName, modifiers)).action).not.toBeNull();
    }
    expect(SHORTCUTS.some((row) => row.keys === 'Esc')).toBe(true);
    expect(PLATFORM_MODIFIER === 'meta' || PLATFORM_MODIFIER === 'ctrl').toBe(true);
  });

  it('uses the selected platform modifier and keeps Ctrl and Meta from firing together', () => {
    expect(resolveKey({ active: true, modifier: 'meta' }, key('k', { metaKey: true })).action?.type).toBe('command-box');
    expect(resolveKey({ active: true, modifier: 'meta' }, key('k', { ctrlKey: true })).action).toBeNull();
    expect(resolveKey({ active: true, modifier: 'ctrl' }, key('k', { metaKey: true })).action).toBeNull();
  });

  it('waits for G then resolves I, M, A, B, and P, and expires the sequence', () => {
    for (const [next, tab] of [['i', 'inbox'], ['m', 'my'], ['a', 'all'], ['b', 'board'], ['p', 'projects']] as const) {
      const begin = resolveKey(state, key('g', { timeStamp: 100 }));
      expect(begin.action).toEqual({ type: 'sequence-pending', key: 'g', expiresAt: 1100 });
      expect(resolveKey({ ...state, pendingSequence: begin.pendingSequence }, key(next, { timeStamp: 500 })).action).toEqual({ type: 'switch-tab', tab });
    }
    const begin = resolveKey(state, key('g', { timeStamp: 100 }));
    expect(resolveKey({ ...state, pendingSequence: begin.pendingSequence }, key('i', { timeStamp: 1200 })).action).toBeNull();
  });

  it('does not capture typing or picker keys, but Escape still closes the top layer', () => {
    const input = { tagName: 'INPUT', closest: () => null } as unknown as HTMLElement;
    expect(resolveKey(state, key('f', { target: input })).action).toBeNull();
    expect(resolveKey(state, key('c', { target: input })).action).toBeNull();
    expect(resolveKey(state, key('?', { shiftKey: true, target: input })).action).toBeNull();
    expect(resolveKey(state, key('g', { target: input })).action).toBeNull();
    expect(resolveKey(state, key('k', { ctrlKey: true, target: input })).action).toBeNull();
    expect(resolveKey({ ...state, focusOwner: 'picker' }, key('s')).action).toBeNull();
    expect(resolveKey({ ...state, pickerOpen: true }, key('k', { ctrlKey: true })).action).toBeNull();
    expect(resolveKey({ ...state, focusOwner: 'text', layers: ['work', 'ticket'] }, key('Escape')).action).toEqual({ type: 'escape', layer: 'ticket' });
    expect(resolveKey({ ...state, active: false }, key('j')).action).toBeNull();
  });

  it('keeps shell shortcuts out of the inbox listbox while preserving Escape layering', () => {
    const inboxList = new FakeElement('div');
    inboxList.setAttribute('role', 'listbox');
    inboxList.classList.add('trk-inbox-list');
    const target = eventTarget(inboxList);
    expect(isNativeActivationTarget(target)).toBe(true);
    for (const event of [key('g'), key('c'), key('f'), key('?', { shiftKey: true }), key('k', { ctrlKey: true })]) {
      expect(resolveKey(state, { ...event, target }).action).toBeNull();
    }
    expect(resolveKey({ ...state, layers: ['work', 'ticket'] }, key('Escape', { target })).action).toEqual({ type: 'escape', layer: 'ticket' });
  });

  it('recognizes native activation controls, including nested targets and picker listboxes', () => {
    const button = new FakeElement('button');
    const svg = new FakeElement('svg');
    button.appendChild(svg);
    expect(isNativeActivationTarget(eventTarget(button))).toBe(true);
    expect(isNativeActivationTarget(eventTarget(svg))).toBe(true);

    const link = new FakeElement('a');
    link.setAttribute('href', '/tickets/TAB-101');
    expect(isNativeActivationTarget(eventTarget(link))).toBe(true);
    expect(isNativeActivationTarget(eventTarget(new FakeElement('a')))).toBe(false);
    expect(isNativeActivationTarget(eventTarget(new FakeElement('summary')))).toBe(true);
    for (const role of ['button', 'tab', 'menuitem', 'option', 'radio', 'checkbox', 'combobox', 'switch', 'spinbutton', 'slider', 'link', 'listbox']) {
      const widget = new FakeElement('div');
      widget.setAttribute('role', role);
      expect(isNativeActivationTarget(eventTarget(widget)), `role=${role}`).toBe(true);
    }
    for (const type of ['text', 'search', 'checkbox', 'radio', 'button', 'submit', 'range', 'hidden']) {
      const input = new FakeElement('input');
      input.setAttribute('type', type);
      expect(isNativeActivationTarget(eventTarget(input)), `input[type=${type}]`).toBe(true);
    }
    const row = new FakeElement('div');
    row.setAttribute('role', 'row');
    row.classList.add('trk-list-row');
    const grid = new FakeElement('div');
    grid.setAttribute('role', 'grid');
    expect(isNativeActivationTarget(eventTarget(row))).toBe(false);
    expect(isNativeActivationTarget(eventTarget(grid))).toBe(false);
    expect(isNativeActivationTarget(eventTarget(new FakeElement('body')))).toBe(false);
  });

  it('leaves activation keys to controls and limits grid commands to the focused list grid', () => {
    const button = new FakeElement('button');
    const gridRow = new FakeElement('div');
    gridRow.setAttribute('role', 'row');
    expect(resolveKey({ ...state, gridFocus: true }, key('Enter', { target: eventTarget(button) })).action).toBeNull();
    expect(resolveKey({ ...state, gridFocus: true }, key(' ', { target: eventTarget(button) })).action).toBeNull();
    expect(resolveKey({ ...state, gridFocus: true }, key('x', { target: eventTarget(button) })).action).toBeNull();
    expect(resolveKey({ ...state, layers: ['work', 'ticket'] }, key('Escape', { target: eventTarget(button) })).action).toEqual({ type: 'escape', layer: 'ticket' });
    expect(resolveKey({ ...state, gridFocus: true }, key('Enter', { target: eventTarget(gridRow) })).action?.type).toBe('open-ticket');
    expect(resolveKey({ ...state, gridFocus: false }, key('Enter', { target: eventTarget(gridRow) })).action).toBeNull();
    expect(resolveKey({ ...state, gridFocus: false }, key('j')).action).toBeNull();
    expect(resolveKey({ ...state, gridFocus: false }, key('c')).action?.type).toBe('create');
    expect(resolveKey({ ...state, gridFocus: false }, key('f')).action?.type).toBe('open-filter');
    expect(resolveKey({ ...state, gridFocus: false }, key('?', { shiftKey: true })).action?.type).toBe('shortcut-sheet');
    expect(resolveKey({ ...state, gridFocus: false }, key('g')).action?.type).toBe('sequence-pending');
  });
});
