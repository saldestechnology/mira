import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatShortcutLabel, SHORTCUTS, TOOL_KEYS, shortcutKeys } from '../src/shortcuts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Keys the keydown listener in bindKeys handles, read from its source text.
function handledKeys(): Set<string> {
  const src = readFileSync(join(ROOT, 'src/app.ts'), 'utf8');
  const bind = src.indexOf('private bindKeys()');
  const start = src.indexOf("window.addEventListener('keydown'", bind);
  const end = src.indexOf("window.addEventListener('keyup'", start);
  expect(bind).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  let body = src.slice(start, end);
  const ids = new Set<string>();
  const zoomIn = "mod && (k === '=' || k === '+')";
  if (body.includes(zoomIn)) ids.add('mod+=');
  body = body.split(zoomIn).join('');
  for (const [, key] of body.matchAll(/mod && k === '([^']+)'/g)) ids.add(`mod+${key}`);
  // A Shift variant inside a Ctrl/Cmd block, such as Ctrl/Cmd+Shift+Z for redo.
  for (const [, key, block] of body.matchAll(/mod && k === '([^']+)'\)\s*\{([^}]*)\}/g)) {
    if (block.includes('e.shiftKey')) ids.add(`mod+shift+${key}`);
  }
  // Arrow keys are matched by the startsWith rule below.
  for (const [, key] of body.matchAll(/(?<!mod && )k === '([^']+)'/g)) {
    if (!key.startsWith('arrow')) ids.add(key);
  }
  for (const [, n] of body.matchAll(/e\.shiftKey && e\.code === 'Digit(\d)'/g)) ids.add(`shift+${n}`);
  if (/e\.shiftKey && [^{]*k === 'h'/.test(body)) ids.add('shift+h');
  if (/e\.shiftKey && [^{]*k === 'v'/.test(body)) ids.add('shift+v');
  if (body.includes("k.startsWith('arrow')")) ids.add('arrows');
  if (body.includes("e.code === 'Space'")) ids.add('space');
  return ids;
}

describe('platform-specific shortcut labels', () => {
  const undo = SHORTCUTS.find((row) => row.ids.includes('mod+z'))!;
  const redo = SHORTCUTS.find((row) => row.ids.includes('mod+shift+z'))!;

  it.each([
    ['MacIntel', '⌘Z', '⇧⌘Z, ⌘Y'],
    ['Win32', 'Ctrl+Z', 'Shift+Ctrl+Z, Ctrl+Y'],
    ['Android', 'Ctrl+Z', 'Shift+Ctrl+Z, Ctrl+Y'],
  ])('formats %s labels without changing shortcut ids', (platform, expectedUndo, expectedRedo) => {
    expect(formatShortcutLabel(undo.keys, platform)).toBe(expectedUndo);
    expect(formatShortcutLabel(redo.keys, platform)).toBe(expectedRedo);
    expect(undo.ids).toEqual(['mod+z']);
    expect(redo.ids).toEqual(['mod+shift+z', 'mod+y']);
  });

  it.each(['MacIntel', 'Win32', 'Android'])('keeps non-key Shift labels spelled out on %s', (platform) => {
    expect(formatShortcutLabel('Shift+click', platform)).toBe('Shift+click');
    expect(formatShortcutLabel('Shift while resizing', platform)).toBe('Shift while resizing');
  });

  it('uses Mac Shift glyphs only for keys, digits, arrows, and key chords', () => {
    expect(formatShortcutLabel('Shift+1 / Shift+2 / Shift+0', 'MacIntel')).toBe('⇧1 / ⇧2 / ⇧0');
    expect(formatShortcutLabel('Shift+Arrows', 'MacIntel')).toBe('⇧Arrows');
    expect(formatShortcutLabel('Shift+Ctrl/Cmd+Z', 'MacIntel')).toBe('⇧⌘Z');
    expect(formatShortcutLabel('Shift+1 / Shift+Arrows', 'Win32')).toBe('Shift+1 / Shift+Arrows');
  });

  it('shows Mac Option symbols for Alt chords and keeps other platforms unchanged', () => {
    expect(formatShortcutLabel('Alt+Shift+Arrows', 'MacIntel')).toBe('⌥⇧Arrows');
    expect(formatShortcutLabel('Alt+Arrows', 'MacIntel')).toBe('⌥Arrows');
    expect(formatShortcutLabel('Alt+Shift+Arrows', 'Win32')).toBe('Alt+Shift+Arrows');
    expect(formatShortcutLabel('Alt+Arrows', 'Android')).toBe('Alt+Arrows');
  });
});

describe('keyboard shortcuts dialog', () => {
  const documented = new Set(SHORTCUTS.flatMap((s) => s.ids));
  const toolLetters = new Set(Object.keys(TOOL_KEYS));

  it('lists every single-key tool', () => {
    const missing = [...toolLetters].filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });

  it('documents every key the keydown handler handles', () => {
    const undocumented = [...handledKeys()].filter((id) => !documented.has(id));
    expect(undocumented).toEqual([]);
  });

  it('finds every documented key in the keydown handler', () => {
    const handled = handledKeys();
    // Paste is a paste event, not a keydown; tool letters are handled through TOOL_KEYS; the AI bar's keys by its own listener
    // (src/ui/ai-bar.ts); Alt+L by the layers panel's (src/ui/layers.ts).
    const elsewhere = new Set(['mod+v', 'mod+k', '/', 'alt+l']);
    const unhandled = [...documented].filter((id) => !toolLetters.has(id) && !elsewhere.has(id) && !handled.has(id));
    expect(unhandled).toEqual([]);
  });

  it('gives board chat M, a key no tool and no other row uses (docs/chat.md)', () => {
    const rows = SHORTCUTS.filter((s) => s.ids.includes('m'));
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toMatch(/board chat/i);
    expect(TOOL_KEYS.m).toBeUndefined();
    expect(shortcutKeys('m')).toBe('M');
    const ids = SHORTCUTS.flatMap((s) => s.ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says ] brings to front and [ sends to back', () => {
    const row = (id: string) => SHORTCUTS.find((s) => s.ids.includes(id));
    expect(row(']')?.action).toMatch(/bring to front/i);
    expect(row('[')?.action).toMatch(/send to back/i);
  });

  it('documents the flip shortcuts without taking the plain hand and select keys', () => {
    expect(SHORTCUTS.find((s) => s.ids.includes('shift+h'))?.action).toMatch(/flip.*horizontally/i);
    expect(SHORTCUTS.find((s) => s.ids.includes('shift+v'))?.action).toMatch(/flip.*vertically/i);
    expect(TOOL_KEYS.h).toEqual({ kind: 'hand' });
    expect(TOOL_KEYS.v).toEqual({ kind: 'select' });
  });
});
