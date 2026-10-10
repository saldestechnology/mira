// The menu a right-click on the board opens (TAB-108): the four stacking steps, then duplicate, lock and delete.
// What is in it is decided by `contextMenuItems`, which has no DOM so a test can read it.
import type { BoardApp } from '../app';
import { h, icon } from './dom';
import { popover } from './common';

export type ContextAction = 'front' | 'forward' | 'backward' | 'back' | 'group' | 'ungroup' | 'flipHorizontal' | 'flipVertical' | 'duplicate' | 'lock' | 'delete';

export interface ContextItem { action: ContextAction; label: string; hint?: string; icon: IconName; danger?: boolean; disabled?: boolean; reason?: string; separatorBefore?: boolean }

type IconName = Parameters<typeof icon>[0];

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The entries for a selection of `count` objects, all locked or not. */
export function contextMenuItems({ count, locked, touch = false, groupReason = 'Select at least two groupable items.', canUngroup = false, flipHorizontalReason = null, flipVerticalReason = null }: {
  count: number;
  locked: boolean;
  touch?: boolean;
  groupReason?: string | null;
  canUngroup?: boolean;
  flipHorizontalReason?: string | null;
  flipVerticalReason?: string | null;
}): ContextItem[] {
  if (count === 0) return [];
  const mod = isMac() ? 'Cmd' : 'Ctrl';
  return [
    { action: 'front', label: 'Bring to front', hint: touch ? undefined : ']', icon: 'front' },
    { action: 'forward', label: 'Bring forward', hint: touch ? undefined : `${mod}+]`, icon: 'forward' },
    { action: 'backward', label: 'Send backward', hint: touch ? undefined : `${mod}+[`, icon: 'backward' },
    { action: 'back', label: 'Send to back', hint: touch ? undefined : '[', icon: 'back' },
    { action: 'group', label: 'Group', hint: touch ? undefined : `${mod}+G`, icon: 'group', disabled: groupReason !== null, reason: groupReason ?? undefined, separatorBefore: true },
    { action: 'ungroup', label: 'Ungroup', hint: touch ? undefined : `Shift+${mod}+G`, icon: 'ungroup', disabled: !canUngroup, reason: canUngroup ? undefined : 'Select one or more groups to ungroup.' },
    { action: 'flipHorizontal', label: 'Flip horizontal', hint: touch ? undefined : 'Shift+H', icon: 'flipHorizontal', disabled: flipHorizontalReason !== null, reason: flipHorizontalReason ?? undefined, separatorBefore: true },
    { action: 'flipVertical', label: 'Flip vertical', hint: touch ? undefined : 'Shift+V', icon: 'flipVertical', disabled: flipVerticalReason !== null, reason: flipVerticalReason ?? undefined },
    { action: 'duplicate', label: 'Duplicate', hint: touch ? undefined : `${mod}+D`, icon: 'dup', separatorBefore: true },
    { action: 'lock', label: locked ? 'Unlock' : 'Lock', icon: locked ? 'unlock' : 'lock' },
    { action: 'delete', label: 'Delete', hint: touch ? undefined : 'Del', icon: 'trash', danger: true },
  ];
}

const RUN: Record<ContextAction, (app: BoardApp) => void> = {
  front: (a) => a.bringToFront(),
  forward: (a) => void a.bringForward(),
  backward: (a) => void a.sendBackward(),
  back: (a) => a.sendToBack(),
  group: (a) => void a.groupSelection(),
  ungroup: (a) => void a.ungroupSelection(),
  flipHorizontal: (a) => void a.flipSelection('horizontal'),
  flipVertical: (a) => void a.flipSelection('vertical'),
  duplicate: (a) => a.duplicate(),
  lock: (a) => a.toggleLock(),
  delete: (a) => a.deleteSelection(),
};

/** Opens the menu at a screen position, for the selection as it is now. Closes on a pick, Escape or a click elsewhere. */
/** A press from a finger keeps the menu off the finger: no item sits under it, and the lift that ends the hold presses nothing. */
export const TOUCH_ANCHOR = 56;
export const TOUCH_LIFT_GUARD_MS = 400;

export function openContextMenu(app: BoardApp, x: number, y: number, touch = false): void {
  const sel = app.selected();
  const items = contextMenuItems({
    count: sel.length,
    locked: sel.length > 0 && sel.every((o) => o.locked),
    groupReason: app.groupReason(),
    canUngroup: app.canUngroupSelection(),
    flipHorizontalReason: app.flipReason('horizontal'),
    flipVerticalReason: app.flipReason('vertical'),
    touch,
  });
  if (!items.length || app.readOnly) return;
  // the popover places itself against an element: a one pixel anchor at the pointer
  const size = touch ? TOUCH_ANCHOR : 1;
  const anchor = h('span', { style: `position:fixed;left:${Math.round(x - size / 2)}px;top:${Math.round(y - size / 2)}px;width:${size}px;height:${size}px;pointer-events:none`, 'aria-hidden': 'true' });
  const openedAt = Date.now();
  document.body.appendChild(anchor);
  const menu = h('div', { class: 'menu ctx-menu', role: 'menu', 'aria-label': 'Object actions' },
    ...items.flatMap((item) => [
      item.separatorBefore ? h('hr', { class: 'menu-sep', role: 'separator' }) : null,
      h('button', {
        class: `menu-item${item.danger ? ' danger' : ''}`, role: 'menuitem',
        disabled: item.disabled,
        'data-tip': item.reason,
        onclick: () => {
          if (touch && Date.now() - openedAt < TOUCH_LIFT_GUARD_MS) return;
          pop.close();
          RUN[item.action](app);
        },
      }, icon(item.icon, 18), h('span', null, item.label), item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null),
    ]),
  );
  const pop = popover(anchor, menu, { side: 'bottom', className: 'ctx-pop', avoidAnchor: touch, onClose: () => anchor.remove() });
  menu.querySelector<HTMLButtonElement>('button')?.focus();
}
