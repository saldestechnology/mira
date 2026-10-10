export type TrackerTab = 'inbox' | 'my' | 'all' | 'board' | 'projects';
export type PickerField = 'state' | 'assignee' | 'priority' | 'labels' | 'due' | 'project';
export type KeyboardLayer = 'picker' | 'filter' | 'ticket' | 'fullscreen' | 'work';

export type TrackerAction =
  | { type: 'command-box' }
  | { type: 'switch-tab'; tab: TrackerTab }
  | { type: 'sequence-pending'; key: 'g'; expiresAt: number }
  | { type: 'create' }
  | { type: 'focus-search' }
  | { type: 'open-filter' }
  | { type: 'shortcut-sheet' }
  | { type: 'expand' }
  | { type: 'escape'; layer: KeyboardLayer | null }
  | { type: 'undo' | 'redo' }
  | { type: 'move-cursor'; delta: -1 | 1; extend: boolean }
  | { type: 'group'; direction: -1 | 1 }
  | { type: 'open-ticket' }
  | { type: 'peek' }
  | { type: 'toggle-selection' }
  | { type: 'select-all' }
  | { type: 'open-picker'; field: PickerField }
  | { type: 'copy-link' | 'copy-key' }
  | { type: 'archive' }
  | { type: 'move-to-edge'; edge: 'first' | 'last' }
  | { type: 'page'; direction: -1 | 1 };

export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  timeStamp?: number;
  target?: EventTarget | null;
  preventDefault(): void;
}

export interface KeyState {
  active: boolean;
  modifier?: 'meta' | 'ctrl';
  focusOwner?: 'tracker' | 'text' | 'picker' | 'dialog';
  pickerOpen?: boolean;
  layers?: readonly KeyboardLayer[];
  pendingSequence?: { key: 'g'; expiresAt: number } | null;
}

export interface KeyResolution {
  action: TrackerAction | null;
  pendingSequence: KeyState['pendingSequence'];
}

const G_SEQUENCE_MS = 1000;
const SEQUENCE_BINDINGS: Array<{ key: string; display: string; tab: TrackerTab; label: string }> = [
  { key: 'i', display: 'I', tab: 'inbox', label: 'Inbox' },
  { key: 'm', display: 'M', tab: 'my', label: 'My issues' },
  { key: 'a', display: 'A', tab: 'all', label: 'All issues' },
  { key: 'b', display: 'B', tab: 'board', label: 'Board' },
  { key: 'p', display: 'P', tab: 'projects', label: 'Projects' },
];

function detectModifier(): 'meta' | 'ctrl' {
  if (typeof navigator === 'undefined') return 'ctrl';
  return /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`) ? 'meta' : 'ctrl';
}

/** Platform shortcut modifier is resolved once, then shared by the map and shortcut sheet. */
export const PLATFORM_MODIFIER: 'meta' | 'ctrl' = detectModifier();

const KEY_BINDINGS: Array<{
  key: string;
  display: string;
  description: string;
  shift?: boolean;
  action: () => TrackerAction;
}> = [
  { key: 'c', display: 'C', description: 'New issue', action: () => ({ type: 'create' }) },
  { key: '/', display: '/', description: 'Focus search', action: () => ({ type: 'focus-search' }) },
  { key: 'f', display: 'F', description: 'Open filters', action: () => ({ type: 'open-filter' }) },
  { key: '?', display: '?', description: 'Show shortcuts', action: () => ({ type: 'shortcut-sheet' }) },
  { key: 'Enter', display: 'Shift+Enter', shift: true, description: 'Expand tracker', action: () => ({ type: 'expand' }) },
  { key: 'ArrowUp', display: 'Shift+↑', shift: true, description: 'Extend selection upward', action: () => ({ type: 'move-cursor', delta: -1, extend: true }) },
  { key: 'ArrowDown', display: 'Shift+↓', shift: true, description: 'Extend selection downward', action: () => ({ type: 'move-cursor', delta: 1, extend: true }) },
  { key: 'ArrowUp', display: '↑', shift: false, description: 'Move row cursor up', action: () => ({ type: 'move-cursor', delta: -1, extend: false }) },
  { key: 'ArrowDown', display: '↓', shift: false, description: 'Move row cursor down', action: () => ({ type: 'move-cursor', delta: 1, extend: false }) },
  { key: 'k', display: 'K', shift: false, description: 'Move row cursor up', action: () => ({ type: 'move-cursor', delta: -1, extend: false }) },
  { key: 'j', display: 'J', shift: false, description: 'Move row cursor down', action: () => ({ type: 'move-cursor', delta: 1, extend: false }) },
  { key: 'ArrowLeft', display: '←', shift: false, description: 'Collapse group', action: () => ({ type: 'group', direction: -1 }) },
  { key: 'ArrowRight', display: '→', shift: false, description: 'Expand group', action: () => ({ type: 'group', direction: 1 }) },
  { key: 'Enter', display: 'Enter', shift: false, description: 'Open ticket', action: () => ({ type: 'open-ticket' }) },
  { key: ' ', display: 'Space', shift: false, description: 'Peek ticket', action: () => ({ type: 'peek' }) },
  { key: 'x', display: 'X', shift: false, description: 'Toggle selection', action: () => ({ type: 'toggle-selection' }) },
  { key: 's', display: 'S', shift: false, description: 'Change state', action: () => ({ type: 'open-picker', field: 'state' }) },
  { key: 'a', display: 'A', shift: false, description: 'Change assignee', action: () => ({ type: 'open-picker', field: 'assignee' }) },
  { key: 'p', display: 'P', shift: false, description: 'Change priority', action: () => ({ type: 'open-picker', field: 'priority' }) },
  { key: 'l', display: 'L', shift: false, description: 'Change labels', action: () => ({ type: 'open-picker', field: 'labels' }) },
  { key: 'd', display: 'D', shift: false, description: 'Change due date', action: () => ({ type: 'open-picker', field: 'due' }) },
  { key: 'm', display: 'M', shift: false, description: 'Change project', action: () => ({ type: 'open-picker', field: 'project' }) },
  { key: 'Home', display: 'Home', shift: false, description: 'Move to first row', action: () => ({ type: 'move-to-edge', edge: 'first' }) },
  { key: 'End', display: 'End', shift: false, description: 'Move to last row', action: () => ({ type: 'move-to-edge', edge: 'last' }) },
  { key: 'PageUp', display: 'PageUp', shift: false, description: 'Previous page', action: () => ({ type: 'page', direction: -1 }) },
  { key: 'PageDown', display: 'PageDown', shift: false, description: 'Next page', action: () => ({ type: 'page', direction: 1 }) },
  { key: 'Backspace', display: 'Delete / Backspace', shift: false, description: 'Archive ticket', action: () => ({ type: 'archive' }) },
  { key: 'Delete', display: 'Delete / Backspace', shift: false, description: 'Archive ticket', action: () => ({ type: 'archive' }) },
];

const MODIFIER_BINDINGS = [
  { key: 'k', display: '⌘/Ctrl+K', description: 'Open command box', action: { type: 'command-box' } as TrackerAction },
  { key: 'a', display: '⌘/Ctrl+A', description: 'Select all visible issues', action: { type: 'select-all' } as TrackerAction },
  { key: 'z', display: '⌘/Ctrl+Z', description: 'Undo tracker change', action: { type: 'undo' } as TrackerAction },
  { key: 'z', display: 'Shift+⌘/Ctrl+Z', description: 'Redo tracker change', shift: true, action: { type: 'redo' } as TrackerAction },
  { key: 'c', display: '⌘/Ctrl+Shift+C', description: 'Copy ticket link', shift: true, action: { type: 'copy-link' } as TrackerAction },
  { key: 'c', display: '⌘/Ctrl+Alt+C', description: 'Copy ticket key', alt: true, action: { type: 'copy-key' } as TrackerAction },
];

const ESCAPE_BINDING = {
  key: 'Escape', display: 'Esc', description: 'Close the topmost picker, filter, ticket, or panel',
  action: (state: KeyState): TrackerAction => ({ type: 'escape', layer: state.layers?.at(-1) ?? null }),
};

export interface ShortcutRow { keys: string; description: string }

/** Shortcut sheet contents are projected from the same bindings resolveKey uses. */
export const SHORTCUTS: readonly ShortcutRow[] = [
  ...MODIFIER_BINDINGS.map(({ display, description }) => ({ keys: display, description })),
  { keys: '[ / ]', description: 'Switch My issues view' },
  { keys: ESCAPE_BINDING.display, description: ESCAPE_BINDING.description },
  {
    keys: `G then ${SEQUENCE_BINDINGS.map((binding) => binding.display).join(' / ')}`,
    description: `Go to ${SEQUENCE_BINDINGS.map((binding) => binding.label).join(' / ')}`,
  },
  ...KEY_BINDINGS.map(({ display, description }) => ({ keys: display, description })),
].filter((row, index, rows) => rows.findIndex((candidate) => candidate.keys === row.keys && candidate.description === row.description) === index);

function isTextOwner(state: KeyState, event: KeyEventLike): boolean {
  if (state.focusOwner === 'text' || state.focusOwner === 'picker' || state.focusOwner === 'dialog' || state.pickerOpen) return true;
  const target = event.target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!target || typeof target !== 'object') return false;
  const tag = target.tagName?.toLowerCase();
  const listbox = target.closest?.('[role="listbox"]');
  const inboxList = target.closest?.('.trk-inbox-list');
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true ||
    Boolean(target.closest?.('[contenteditable="true"], [role="combobox"], .popover')) || Boolean(listbox && !inboxList);
}

function hasModifier(event: KeyEventLike, modifier: 'meta' | 'ctrl'): boolean {
  return modifier === 'meta' ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
}

function noModifier(event: KeyEventLike): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** Pure key resolver. The caller stores the returned sequence state and dispatches the action. */
export function resolveKey(state: KeyState, event: KeyEventLike): KeyResolution {
  let pendingSequence = state.pendingSequence ?? null;
  const time = event.timeStamp ?? 0;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!state.active) return { action: null, pendingSequence };
  if (key === ESCAPE_BINDING.key) return { action: ESCAPE_BINDING.action(state), pendingSequence: null };
  if (isTextOwner(state, event)) return { action: null, pendingSequence };
  if (pendingSequence && time > pendingSequence.expiresAt) pendingSequence = null;

  const modifier = state.modifier ?? PLATFORM_MODIFIER;
  if (hasModifier(event, modifier)) {
    const binding = MODIFIER_BINDINGS.find((candidate) => candidate.key === key && Boolean(candidate.shift) === Boolean(event.shiftKey) && Boolean(candidate.alt) === Boolean(event.altKey));
    if (binding) { event.preventDefault(); return { action: binding.action, pendingSequence: null }; }
  }
  if (pendingSequence) {
    const sequence = noModifier(event) ? SEQUENCE_BINDINGS.find((binding) => binding.key === key) : undefined;
    if (sequence) {
      event.preventDefault();
      return { action: { type: 'switch-tab', tab: sequence.tab }, pendingSequence: null };
    }
    pendingSequence = null;
  }
  if (key === 'g' && noModifier(event)) {
    event.preventDefault();
    return { action: { type: 'sequence-pending', key: 'g', expiresAt: time + G_SEQUENCE_MS }, pendingSequence: { key: 'g', expiresAt: time + G_SEQUENCE_MS } };
  }
  if (noModifier(event)) {
    const binding = KEY_BINDINGS.find((candidate) => candidate.key === key && (candidate.shift === undefined || candidate.shift === Boolean(event.shiftKey)));
    if (binding) {
      event.preventDefault();
      return { action: binding.action(), pendingSequence };
    }
  }
  return { action: null, pendingSequence };
}
