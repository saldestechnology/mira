import type { BaseObj, Point } from './types';
import { newId } from './store';
import type { Store } from './store';

export const TRACKER_FRAME_DEFAULT_SIZE = { w: 1440, h: 900 } as const;
export const TRACKER_FRAME_MIN_SIZE = { w: 480, h: 360 } as const;

/** The SVG snapshot hook; the tracker UI can register its own static frame renderer later. */
export type TrackerRenderer = (frame: BaseObj) => string;

/** Safe, static fallback used by board drawing and PNG/SVG export. It contains no ticket data. */
export function trackerPlaceholder(frame: BaseObj): string {
  const w = Number.isFinite(frame.w) ? Math.max(0, frame.w) : 0;
  const h = Number.isFinite(frame.h) ? Math.max(0, frame.h) : 0;
  const ruleY = Math.min(64, h);
  return `<rect x="0" y="0" width="${w}" height="${h}" fill="var(--paper, #F7F5F0)" stroke="var(--ink, #121216)" stroke-width="1"/>` +
    `<text x="24" y="40" font-family="sans-serif" font-size="20" font-weight="700" fill="var(--ink, #121216)">Tracker</text>` +
    `<text x="${Math.max(24, w - 24)}" y="40" text-anchor="end" font-family="sans-serif" font-size="12" fill="var(--graphite, #55555C)">TAB</text>` +
    `<line x1="0" y1="${ruleY}" x2="${w}" y2="${ruleY}" stroke="var(--rule, #55555C)" stroke-width="1"/>` +
    `<text x="24" y="${Math.min(h - 20, 92)}" font-family="sans-serif" font-size="12" fill="var(--graphite, #55555C)">Open this frame to work with workspace tickets.</text>`;
}

let trackerRenderer: TrackerRenderer = trackerPlaceholder;

/** Register the designer's frame snapshot renderer. The returned function restores the previous renderer. */
export function registerTrackerRenderer(renderer: TrackerRenderer): () => void {
  const previous = trackerRenderer;
  trackerRenderer = renderer;
  return () => {
    if (trackerRenderer === renderer) trackerRenderer = previous;
  };
}

export function renderTrackerFrame(frame: BaseObj): string {
  return trackerRenderer(frame);
}

/** Create a frame for this workspace's tracker, reusing the workspace tracker ID when another frame already exists. */
export function createTrackerFrame(store: Store, position: Point): BaseObj | null {
  if (store.readOnly) return null;
  const existing = [...store.cache.values()].find((o) => {
    const trackerId = (o as BaseObj).trackerId;
    return o.type === 'tracker' && typeof trackerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(trackerId);
  }) as BaseObj | undefined;
  const frame: BaseObj = {
    id: newId(),
    type: 'tracker',
    x: position.x,
    y: position.y,
    ...TRACKER_FRAME_DEFAULT_SIZE,
    rotation: 0,
    z: store.topZ(),
    trackerId: existing?.trackerId ?? newId(),
    view: 'inbox',
  };
  store.transact(() => store.create(frame));
  return frame;
}
