import type { Tool } from './app';

// Single-key tool shortcuts. bindKeys reads this map and the keyboard dialog lists it.
export const TOOL_KEYS: Record<string, Tool> = {
  v: { kind: 'select' }, h: { kind: 'hand' }, n: { kind: 'sticky' }, s: { kind: 'sticky' }, t: { kind: 'text' },
  r: { kind: 'shape', shape: 'rect' }, o: { kind: 'shape', shape: 'ellipse' }, d: { kind: 'shape', shape: 'diamond' },
  l: { kind: 'connector' }, x: { kind: 'connector' }, p: { kind: 'pen' }, f: { kind: 'frame' }, c: { kind: 'comment' },
};

export const TOOL_LABELS: Record<string, string> = {
  v: 'Select', h: 'Hand', n: 'Sticky note', s: 'Sticky note', t: 'Text', r: 'Rectangle', o: 'Ellipse', d: 'Diamond',
  l: 'Connector', x: 'Connector', p: 'Pen', f: 'Frame', c: 'Comment',
};

export interface Shortcut {
  group: 'Tools' | 'Edit' | 'View' | 'While dragging';
  keys: string;
  action: string;
  // Handler key ids this row documents (see test/shortcuts.test.ts); empty for pointer gestures.
  ids: string[];
}

const toolRows = (): Shortcut[] => {
  const byLabel = new Map<string, string[]>();
  for (const key of Object.keys(TOOL_KEYS)) {
    const label = TOOL_LABELS[key];
    byLabel.set(label, [...(byLabel.get(label) ?? []), key]);
  }
  return [...byLabel].map(([action, ids]): Shortcut => ({ group: 'Tools', keys: ids.map((k) => k.toUpperCase()).join(' or '), action, ids }));
};

export const SHORTCUTS: Shortcut[] = [
  ...toolRows(),
  { group: 'Tools', keys: 'Esc', action: 'Clear selection, cancel, back to Select', ids: ['escape'] },
  { group: 'Edit', keys: 'Ctrl/Cmd+Z', action: 'Undo', ids: ['mod+z'] },
  { group: 'Edit', keys: 'Shift+Ctrl/Cmd+Z, Ctrl/Cmd+Y', action: 'Redo', ids: ['mod+shift+z', 'mod+y'] },
  { group: 'Edit', keys: 'Ctrl/Cmd+C', action: 'Copy', ids: ['mod+c'] },
  { group: 'Edit', keys: 'Ctrl/Cmd+X', action: 'Cut', ids: ['mod+x'] },
  { group: 'Edit', keys: 'Ctrl/Cmd+V', action: 'Paste', ids: ['mod+v'] },
  { group: 'Edit', keys: 'Ctrl/Cmd+D', action: 'Duplicate', ids: ['mod+d'] },
  { group: 'Edit', keys: 'Ctrl/Cmd+G', action: 'Group selected items', ids: ['mod+g'] },
  { group: 'Edit', keys: 'Shift+Ctrl/Cmd+G', action: 'Ungroup selected groups', ids: ['mod+shift+g'] },
  { group: 'Edit', keys: 'Shift+H', action: 'Flip selection horizontally', ids: ['shift+h'] },
  { group: 'Edit', keys: 'Shift+V', action: 'Flip selection vertically', ids: ['shift+v'] },
  { group: 'Edit', keys: 'Ctrl/Cmd+A', action: 'Select all', ids: ['mod+a'] },
  { group: 'Edit', keys: 'Delete, Backspace', action: 'Delete selection', ids: ['delete', 'backspace'] },
  { group: 'Edit', keys: 'Enter', action: 'Edit text of the selected item, open a card, or open a kanban as a list', ids: ['enter'] },
  { group: 'Edit', keys: 'Arrows (Shift for grid steps)', action: 'Nudge', ids: ['arrows'] },
  { group: 'Edit', keys: 'Alt+Shift+Arrows on a text', action: 'Left and right change the width the text wraps at; up and down change its size', ids: [] },
  { group: 'Edit', keys: 'K', action: 'Turn sticky notes into cards, or cards into sticky notes', ids: ['k'] },
  { group: 'Edit', keys: 'Alt+Arrows on a kanban card', action: 'Move the card in its lane, or to the next lane', ids: [] },
  { group: 'Edit', keys: ']', action: 'Bring to front', ids: [']'] },
  { group: 'Edit', keys: 'Ctrl/Cmd+]', action: 'Bring forward one step', ids: ['mod+]'] },
  { group: 'Edit', keys: 'Ctrl/Cmd+[', action: 'Send backward one step', ids: ['mod+['] },
  { group: 'Edit', keys: '[', action: 'Send to back', ids: ['['] },
  { group: 'Edit', keys: 'Double-click', action: 'Edit text or open a card, or add text on empty canvas', ids: [] },
  { group: 'Edit', keys: 'Shift-click while voting', action: 'Remove a vote', ids: [] },
  { group: 'View', keys: 'Ctrl/Cmd+=, Ctrl/Cmd+-', action: 'Zoom in, zoom out', ids: ['mod+=', 'mod+-'] },
  { group: 'View', keys: 'Ctrl/Cmd + scroll, pinch', action: 'Zoom', ids: [] },
  { group: 'View', keys: 'Shift+1 / Shift+2 / Shift+0', action: 'Fit board / fit selection / 100%', ids: ['shift+1', 'shift+2', 'shift+0'] },
  { group: 'View', keys: 'Hold Space', action: 'Pan while held', ids: ['space'] },
  { group: 'View', keys: 'Ctrl/Cmd+K or /', action: 'Ask AI', ids: ['mod+k', '/'] },
  { group: 'View', keys: 'M', action: 'Open or close board chat', ids: ['m'] },
  { group: 'View', keys: 'Alt+L', action: 'Layers panel', ids: ['alt+l'] },
  { group: 'While dragging', keys: 'Alt while dragging', action: 'Ignore grid and guides', ids: [] },
  { group: 'While dragging', keys: 'Shift while resizing', action: 'Keep proportions', ids: [] },
];

/** Formats a canonical shortcut label for the platform that will display it. */
export function formatShortcutLabel(keys: string, platform: string): string {
  const mac = /Mac|iPhone|iPad/i.test(platform);
  return keys
    .replace(/Shift\+Ctrl\/Cmd\+/g, mac ? '⇧⌘' : 'Shift+Ctrl+')
    .replace(/Ctrl\/Cmd\+/g, mac ? '⌘' : 'Ctrl+')
    .replace(/Ctrl\/Cmd \+/g, mac ? '⌘ +' : 'Ctrl +')
    .replace(/Alt\+/g, mac ? '⌥' : 'Alt+')
    .replace(/Shift\+(?=(?:[A-Z0-9]|Arrows)\b)/g, mac ? '⇧' : 'Shift+');
}

/**
 * The keys the shortcuts dialog lists for one key id (a tool letter, or 'mod+z' style as in `ids`), for tooltips.
 * Undefined when no row documents the id, so a tooltip never shows a shortcut the dialog does not.
 */
export function shortcutKeys(id: string): string | undefined {
  const row = SHORTCUTS.find((s) => s.ids.includes(id));
  if (!row) return undefined;
  if (row.ids.length < 2) return row.keys;
  const alternatives = row.keys.split(/, | or | \/ /);
  return alternatives.length === row.ids.length ? alternatives[row.ids.indexOf(id)] : row.keys;
}
