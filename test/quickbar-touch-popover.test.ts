import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountQuickbar } from '../src/ui/quickbar';
import { closePopover } from '../src/ui/common';
import { FakeEvent, FakeElement, control, installFakeBrowser, type FakeBrowser } from './fake-dom';

vi.mock('../src/ui/ai-bar', () => ({
  aiBarFor: () => null,
  glyph: () => document.createElement('span'),
  onAiBarChange: () => () => undefined,
}));

let browser: FakeBrowser;
let sticky: { id: string; type: 'sticky'; fill: string; x: number; y: number; w: number; h: number; rotation: number; z: string; text: string };

beforeEach(() => {
  vi.useFakeTimers();
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  sticky = { id: 'sticky', type: 'sticky', fill: '#FFE16B', x: 0, y: 0, w: 100, h: 80, rotation: 0, z: 'a1', text: 'Note' };
});

afterEach(() => {
  closePopover();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  browser.uninstall();
});

function mount() {
  const parent = browser.mount();
  const listeners = new Map<string, (() => void)[]>();
  const app = {
    selection: [sticky.id],
    tool: { kind: 'select' },
    dragging: false,
    editor: { active: false },
    readOnly: false,
    zoom: 1,
    store: { connectorsOf: () => [], transact: (fn: () => void) => fn() },
    r: { onCamera: () => () => undefined, contentBounds: () => null },
    on: (name: string, fn: () => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      return () => undefined;
    },
    selected: () => [sticky],
    selectedLeaves: () => [sticky],
    stickyPalette: () => [
      { name: 'Yellow', value: '#FFE16B' },
      { name: 'Coral', value: '#F58A7E' },
    ],
    updateSelectedLeaves: (patch: Partial<typeof sticky>) => Object.assign(sticky, patch),
    canTurnIntoCards: () => false,
    toggleLock() {},
    duplicate() {},
    deleteSelection() {},
  };
  const props = {
    el: browser.document.createElement('aside'),
    toggle() {},
    isOpen: () => false,
    onToggle() {},
  };
  mountQuickbar(app as never, parent as unknown as HTMLElement, props as never, { demo: true });
  return parent;
}

function pickSecondColor(parent: FakeElement, pointerType: 'mouse' | 'touch') {
  control(parent, 'Colour').click();
  const popover = browser.document.body.querySelector('.popover') as FakeElement;
  const second = popover.querySelectorAll('[role="radio"]')[1];
  const down = Object.assign(new FakeEvent('pointerdown'), { pointerType });
  second.dispatchEvent(down);
  const click = Object.assign(new FakeEvent('click'), { pointerType, detail: 1 });
  second.dispatchEvent(click);
  return popover;
}

describe('sticky colour picker in the quickbar', () => {
  it('closes after a touch selects a swatch', () => {
    const parent = mount();
    const popover = pickSecondColor(parent, 'touch');

    expect(sticky.fill).toBe('#F58A7E');
    expect(popover.isConnected).toBe(false);
    expect(browser.document.body.querySelector('.popover')).toBeNull();
  });

  it('stays open after a mouse selects a swatch', () => {
    const parent = mount();
    const popover = pickSecondColor(parent, 'mouse');

    expect(sticky.fill).toBe('#F58A7E');
    expect(popover.isConnected).toBe(true);
    expect(browser.document.body.querySelector('.popover')).toBe(popover);
  });
});
