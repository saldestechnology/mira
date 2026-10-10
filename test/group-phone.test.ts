import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { groupChipAvoidBox } from '../src/ui/group-ui-logic';
import { placeBar } from '../src/ui/quickbar-layout';
import { isInSelection, movedPastSlop, sameSelection } from '../src/ui/touch-menu';
import { contextMenuItems } from '../src/ui/context-menu';
import type { Obj } from '../src/types';

// TAB-253: groups on phones. CSS is read as text, as tray-overlap.test.ts does.
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const styles = read('../src/styles.css');
const groupCss = read('../src/ui/group-ui.css');
const board = read('../src/ui/board.ts');

function phoneBlock(css: string): string {
  const at = css.indexOf('@media (max-width: 860px)');
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i);
  }
  return '';
}

describe('group chips beside an open tray (phone width)', () => {
  const block = phoneBlock(groupCss);
  const rule = block.split('\n').find((l) => /visibility:\s*hidden/.test(l)) ?? '';
  it('are hidden, kept in place, while a drawer or the side tray is open', () => {
    expect(rule).toMatch(/:has\(>\s*:is\(\.drawer, \.side-tray\)\.show\)/);
    for (const c of ['.group-chip', '.group-done']) expect(rule).toContain(c);
    expect(rule).not.toMatch(/display:\s*none/);
  });
  it('are not hidden outside phone width', () => {
    expect(groupCss.replace(block, '')).not.toMatch(/side-tray[^{]*\{[^}]*visibility:\s*hidden/);
  });
});

describe('Undo and Redo on a phone rail', () => {
  it('sit below the scrolling tools as a separate box', () => {
    expect(board).toMatch(/class: 'rail-end'[\s\S]*?'aria-label': 'Undo'[\s\S]*?'aria-label': 'Redo'/);
    expect(board).toMatch(/class: 'rail-tools'[\s\S]*?pollBtn,[\s\S]*?class: 'rail-end'/);
    expect(styles).toMatch(/\.rail-tools\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
    expect(styles).not.toMatch(/\.rail-end\s*\{[^}]*position:\s*sticky/);
  });
  it('flattens the wrappers on a tall wide screen', () => {
    expect(styles).toMatch(/\.rail-tools, \.rail-end \{ display: contents; \}/);
  });
});

describe('the group chip box the quick bar avoids', () => {
  const viewport = { width: 390, height: 844 };
  it('is unchanged without a clamp', () => {
    expect(groupChipAvoidBox(100, 300, 'Group · 2', 1)).toEqual({ x: 90, y: 264, w: 83, h: 40 });
  });
  it('follows the chip held inside the viewport and under the top bars', () => {
    const box = groupChipAvoidBox(10, 100, 'Group · 2', 1, { viewport, topInset: 120, width: 72 })!;
    expect(box.x).toBe(8 - 4);
    expect(box.y).toBe(120 - 4);
  });
  it('makes the bar flip below a group at the left edge of a phone', () => {
    const target = { x: 10, y: 150, w: 300, h: 200 };
    const bar = { w: 260, h: 52 };
    const avoid = groupChipAvoidBox(target.x, target.y, 'Group · 2', 1, { viewport, topInset: 120, width: 72 })!;
    const p = placeBar(target, bar, { w: 390, h: 844 }, 0, undefined, 120, undefined, [avoid], 76);
    expect(p.x).toBeGreaterThanOrEqual(76);
    expect(p.below).toBe(true);
  });
});

describe('touch long press helpers', () => {
  const g = { id: 'g', type: 'group' } as unknown as Obj;
  const n = { id: 'n', type: 'sticky', parent: 'g' } as unknown as Obj;
  it('tells a hold from a drag', () => {
    expect(movedPastSlop(3, 4)).toBe(false);
    expect(movedPastSlop(12, 0)).toBe(true);
  });
  it('finds a member of a selected group', () => {
    expect(isInSelection(n, ['g'], (id) => (id === 'g' ? g : undefined))).toBe(true);
    expect(isInSelection(n, ['x'], (id) => (id === 'g' ? g : undefined))).toBe(false);
    expect(isInSelection(n, ['n'], () => undefined)).toBe(true);
  });
  it('compares selections', () => {
    expect(sameSelection(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameSelection(['a', 'b'], ['b'])).toBe(false);
  });
});

describe('long press is wired to the context menu with Group and Ungroup', () => {
  it('mounts beside the group UI and opens the same menu', () => {
    expect(board).toContain('mountTouchMenu(app)');
    expect(read('../src/ui/touch-menu.ts')).toContain('openContextMenu(app,');
    expect(read('../src/ui/context-menu.ts')).toMatch(/action: 'group'[\s\S]*action: 'ungroup'/);
  });
});


describe('Android long-press menu hints', () => {
  it('keeps selection actions but hides desktop shortcut hints on touch', () => {
    const items = contextMenuItems({ count: 2, locked: false, canUngroup: true, touch: true });
    expect(items.map((item) => item.action)).toContain('group');
    expect(items.map((item) => item.action)).toContain('ungroup');
    expect(items.every((item) => item.hint === undefined)).toBe(true);
  });
});
