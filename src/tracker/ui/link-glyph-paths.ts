import type { TrackerStateCategory } from '../../tracker-types';
import { escapeXml } from '../../text';

export interface LinkGlyphShape {
  tag: 'circle' | 'path';
  attrs: Record<string, string>;
}

/** Shared state-glyph geometry for the link dialog and SVG canvas projection. */
export function stateGlyphShapes(category: TrackerStateCategory, key?: string): LinkGlyphShape[] {
  if (category === 'backlog') return [{ tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.25', 'stroke-dasharray': '2 2' } }];
  if (category === 'unstarted') return [{ tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.25' } }];
  if (category === 'started' && key === 'in_review') return [
    { tag: 'path', attrs: { d: 'M8 2.75a5.25 5.25 0 1 1-5.25 5.25H8z', fill: 'currentColor' } },
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.25' } },
  ];
  if (category === 'started') return [
    { tag: 'path', attrs: { d: 'M8 2.75A5.25 5.25 0 0 1 8 13.25Z', fill: 'currentColor' } },
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.25' } },
  ];
  if (category === 'completed') return [{ tag: 'path', attrs: {
    d: 'M8 2.25a5.75 5.75 0 1 0 0 11.5a5.75 5.75 0 1 0 0-11.5ZM4.35 7.85l1.05-1.05 1.7 1.7 3.5-3.5 1.05 1.05-4.55 4.55z',
    fill: 'currentColor', 'fill-rule': 'evenodd', stroke: 'none',
  } }];
  return [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.25' } },
    { tag: 'path', attrs: { d: 'M6 6l4 4M10 6l-4 4' } },
  ];
}

export function stateGlyphElement(category: TrackerStateCategory, key: string, label: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    class: 'trk-glyph trk-link-state-glyph', viewBox: '0 0 16 16', width: String(size), height: String(size),
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'square', 'stroke-linejoin': 'miter',
    'aria-hidden': 'true', focusable: 'false', 'data-glyph-label': label,
  })) svg.setAttribute(name, value);
  for (const shape of stateGlyphShapes(category, key)) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', shape.tag);
    for (const [name, value] of Object.entries(shape.attrs)) element.setAttribute(name, value);
    svg.appendChild(element);
  }
  return svg;
}

export function stateGlyphMarkup(category: TrackerStateCategory, key: string, options: { x: number; y: number; size: number; className?: string }): string {
  const size = Number.isFinite(options.size) ? Math.max(1, options.size) : 12;
  const attrs = stateGlyphShapes(category, key).map((shape) => {
    const values = Object.entries(shape.attrs).map(([name, value]) => `${name}="${escapeXml(value)}"`).join(' ');
    return `<${shape.tag} ${values}/>`;
  }).join('');
  const classAttr = options.className ? ` class="${escapeXml(options.className)}"` : '';
  return `<svg x="${options.x}" y="${options.y}" width="${size}" height="${size}" viewBox="0 0 16 16"${classAttr} color="var(--canvas-ink)" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">${attrs}</svg>`;
}
