import type { TrackerPriority, TrackerStateCategory } from '../../tracker-types';
import { escapeXml } from '../../text';
import { stateGlyphMarkup } from './link-glyph-paths';

export interface LinkedCardState { key: string; name: string; category: TrackerStateCategory }
export interface LinkedCardHeaderOptions {
  key: string;
  state: LinkedCardState | null;
  laneStateKey: string | null | undefined;
  width: number;
  zoom: number;
  offline?: boolean;
  blocked?: boolean;
  priority?: TrackerPriority;
}

const number = (value: number) => Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0';
const measureText = (value: string) => Array.from(value).length * 5.9;

function priorityMarkup(priority: TrackerPriority | undefined, x: number): string {
  if (priority !== 'urgent' && priority !== 'high') return '';
  const geometry = priority === 'urgent'
    ? '<path d="M3 3h10v10H3zM7 5h2v4H7zM7 10h2v1H7z" fill="currentColor" fill-rule="evenodd" stroke="none"/>'
    : '<path d="M3 10v3M7 7v6M11 4v9"/>';
  return `<svg class="trk-priority" x="${number(x)}" y="8" width="12" height="12" viewBox="0 0 16 16" color="var(--canvas-ink)" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true" focusable="false">${geometry}<title>${priority === 'urgent' ? 'Urgent' : 'High priority'}</title></svg>`;
}

function offlineMarkup(x: number): string {
  return `<svg class="trk-offline" x="${number(x)}" y="8" width="12" height="12" viewBox="0 0 24 24" color="var(--graphite)" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 3l18 18M8.5 6.6A6 6 0 0117.7 10h.3a4 4 0 012.6 7M17 18H7a4.5 4.5 0 01-1.6-8.7"/><title>Offline</title></svg>`;
}

function blockedMarkup(x: number): string {
  return `<g class="trk-blocked"><path d="M${number(x)} 13h8" fill="none" stroke="var(--graphite)" stroke-width="1.5"/><text x="${number(x + 12)}" y="17" font-family="var(--ui, 'Instrument Sans', sans-serif)" font-size="10" font-weight="700" fill="var(--graphite)">Blocked</text></g>`;
}

/** SVG content for a linked card's header. User-supplied key and state text are XML escaped. */
export function linkedCardHeaderMarkup(options: LinkedCardHeaderOptions): string {
  const width = Math.max(80, Number.isFinite(options.width) ? options.width : 80);
  const zoom = Number.isFinite(options.zoom) && options.zoom > 0 ? options.zoom : 1;
  const lowZoom = 11 * zoom < 9;
  const key = String(options.key ?? '');
  const split = key.lastIndexOf('-');
  const prefix = split >= 0 ? key.slice(0, split + 1) : key;
  const numberPart = split >= 0 ? key.slice(split + 1) : '';
  const keyWidth = measureText(key);
  let right = width - 12;
  const parts: string[] = [];

  if (options.blocked) { right -= 48; parts.push(blockedMarkup(right)); right -= 5; }
  if (options.offline) { right -= 12; parts.push(offlineMarkup(right)); right -= 7; }
  if (options.priority === 'urgent' || options.priority === 'high') { right -= 12; parts.push(priorityMarkup(options.priority, right)); right -= 7; }

  const showState = Boolean(options.state && (options.state.key !== options.laneStateKey || width > 240));
  if (showState && options.state) {
    const showName = !lowZoom;
    const maxNameWidth = Math.max(0, right - 12 - (12 + keyWidth) - 12);
    const stateNameWidth = showName ? Math.min(measureText(options.state.name), maxNameWidth) : 0;
    const groupWidth = 12 + (stateNameWidth > 0 ? 6 + stateNameWidth : 0);
    const x = Math.max(12 + keyWidth + 10, right - groupWidth);
    parts.push(stateGlyphMarkup(options.state.category, options.state.key, { x, y: 8, size: 12, className: 'trk-linked-state' }));
    if (stateNameWidth > 0) {
      parts.push(`<text class="trk-linked-state-name" x="${number(x + 18)}" y="17" textLength="${number(stateNameWidth)}" lengthAdjust="spacingAndGlyphs" font-family="var(--ui, 'Instrument Sans', sans-serif)" font-size="10" font-weight="600" fill="var(--canvas-ink)">${escapeXml(options.state.name)}</text>`);
    }
  }

  const keyMarkup = `<text class="trk-linked-key" x="12" y="17" font-family="var(--ui, 'Instrument Sans', sans-serif)" font-size="11" font-weight="700" font-variant-numeric="tabular-nums"><tspan fill="var(--graphite)">${escapeXml(prefix)}</tspan><tspan fill="var(--canvas-ink)">${escapeXml(numberPart)}</tspan></text>`;
  return `<g class="trk-linked-card-header" color="var(--canvas-ink)"><rect class="trk-linked-marker" x="0" y="0" width="3" height="100%" fill="var(--canvas-ink)"/>${keyMarkup}${parts.join('')}</g>`;
}

function warningGlyph(x: number, y: number): string {
  return `<svg x="${number(x)}" y="${number(y)}" width="12" height="12" viewBox="0 0 12 12" color="var(--canvas-ink)" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 1.25 11 10.5H1Z"/><path d="M6 4v3M6 8.7v.1"/></svg>`;
}

/** A dashed status chip for a ticket state whose cards have no mapped lane. */
export function unmappedStateChipMarkup(options: { width: number }): string {
  const width = Math.max(100, Number.isFinite(options.width) ? options.width : 100);
  return `<g class="trk-unmapped-state"><title>State not mapped to a lane</title><rect x="0.5" y="0.5" width="${number(width - 1)}" height="21" rx="var(--radius-xs)" fill="none" stroke="var(--graphite)" stroke-width="1" stroke-dasharray="3 2"/><text x="7" y="14.5" font-family="var(--ui, 'Instrument Sans', sans-serif)" font-size="11" font-weight="700" fill="var(--canvas-ink)">Unmapped state</text>${warningGlyph(width - 20, 5)}</g>`;
}

/** The canvas chip used for a new lane that has not been linked to a tracker state. */
export function unmappedLaneChipMarkup(): string {
  return '<g class="trk-unmapped-lane"><rect x="0.5" y="0.5" width="75" height="21" rx="var(--radius-xs)" fill="none" stroke="var(--graphite)" stroke-width="1" stroke-dasharray="3 2"/><text x="7" y="14.5" font-family="var(--ui, \'Instrument Sans\', sans-serif)" font-size="11" font-weight="700" fill="var(--canvas-ink)">Not linked</text></g>';
}
