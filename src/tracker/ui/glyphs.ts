import type { StateCategory } from './ticket-types';

const SVG_NS = 'http://www.w3.org/2000/svg';
type GlyphKind = 'state' | 'priority' | 'actor' | 'pr';

function svg(kind: GlyphKind, label: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('class', `trk-glyph trk-${kind}-glyph`);
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('width', '16');
  el.setAttribute('height', '16');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.5');
  el.setAttribute('stroke-linecap', 'square');
  el.setAttribute('stroke-linejoin', 'miter');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  el.setAttribute('data-glyph-label', label);
  return el;
}

function part(parent: SVGSVGElement, tag: 'circle' | 'path' | 'rect' | 'text', attrs: Record<string, string>) {
  const child = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, value);
  parent.appendChild(child);
  return child;
}

const STATE_NAMES: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function stateLabel(category: StateCategory, key?: string): string {
  if (key && STATE_NAMES[key]) return STATE_NAMES[key];
  if (category === 'backlog') return 'Backlog';
  if (category === 'unstarted') return 'To do';
  if (category === 'started') return 'In progress';
  if (category === 'completed') return 'Done';
  return 'Cancelled';
}

export function stateGlyph(category: StateCategory, key?: string): SVGSVGElement {
  const label = stateLabel(category, key);
  const el = svg('state', label);
  if (category === 'backlog') {
    part(el, 'circle', { cx: '8', cy: '8', r: '5.25', 'stroke-dasharray': '2 2' });
  } else if (category === 'unstarted') {
    part(el, 'circle', { cx: '8', cy: '8', r: '5.25' });
  } else if (category === 'started' && key === 'in_review') {
    part(el, 'path', { d: 'M8 2.75a5.25 5.25 0 1 1-5.25 5.25H8z', fill: 'currentColor' });
    part(el, 'circle', { cx: '8', cy: '8', r: '5.25' });
  } else if (category === 'started') {
    part(el, 'path', { d: 'M8 2.75A5.25 5.25 0 0 1 8 13.25Z', fill: 'currentColor' });
    part(el, 'circle', { cx: '8', cy: '8', r: '5.25' });
  } else if (category === 'completed') {
    // Even-odd fill cuts the check through the filled circle so the glyph uses currentColor alone.
    part(el, 'path', {
      d: 'M8 2.25a5.75 5.75 0 1 0 0 11.5a5.75 5.75 0 1 0 0-11.5ZM4.35 7.85l1.05-1.05 1.7 1.7 3.5-3.5 1.05 1.05-4.55 4.55z',
      fill: 'currentColor',
      'fill-rule': 'evenodd',
      stroke: 'none',
    });
  } else {
    part(el, 'circle', { cx: '8', cy: '8', r: '5.25' });
    part(el, 'path', { d: 'M6 6l4 4M10 6l-4 4' });
  }
  return el;
}

export type Priority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

const PRIORITY_NAMES: Record<Priority, string> = {
  none: 'No priority', urgent: 'Urgent', high: 'High priority', medium: 'Medium priority', low: 'Low priority',
};

export function priorityLabel(priority: Priority): string {
  return PRIORITY_NAMES[priority];
}

export function priorityGlyph(priority: Priority): SVGSVGElement {
  const el = svg('priority', priorityLabel(priority));
  if (priority === 'none') {
    part(el, 'path', { d: 'M3 8h10' });
    return el;
  }
  if (priority === 'urgent') {
    part(el, 'path', {
      d: 'M3 3h10v10H3zM7 5h2v4H7zM7 10h2v1H7z',
      fill: 'currentColor',
      'fill-rule': 'evenodd',
      stroke: 'none',
    });
    return el;
  }
  const level = priority === 'low' ? 1 : priority === 'medium' ? 2 : 3;
  for (let i = 0; i < level; i++) {
    const x = 3 + i * 4;
    const top = 10 - i * 3;
    part(el, 'path', { d: `M${x} ${top}v${13 - top}` });
  }
  return el;
}

export type ActorBadgeKind = 'agent' | 'github' | 'import';
const ACTOR_LABELS: Record<ActorBadgeKind, string> = { agent: 'Agent', github: 'GitHub', import: 'Import' };

export function actorLabel(kind: ActorBadgeKind): string {
  return ACTOR_LABELS[kind];
}

export function actorBadgeGlyph(kind: ActorBadgeKind): SVGSVGElement {
  const el = svg('actor', actorLabel(kind));
  part(el, 'rect', { x: '1.75', y: '1.75', width: '12.5', height: '12.5' });
  const text = part(el, 'text', {
    x: '8', y: '10.5', fill: 'currentColor', stroke: 'none', 'text-anchor': 'middle',
    'font-family': 'var(--ui, sans-serif)', 'font-size': kind === 'agent' ? '6.5' : '5.5', 'font-weight': '700',
  });
  text.textContent = kind === 'agent' ? 'A' : kind === 'github' ? 'GH' : 'IM';
  return el;
}

export type PullRequestState = 'draft' | 'open' | 'merged' | 'closed';
const PR_NAMES: Record<PullRequestState, string> = {
  draft: 'Draft pull request', open: 'Open pull request', merged: 'Merged pull request', closed: 'Closed pull request',
};

export function prStateLabel(state: PullRequestState): string {
  return PR_NAMES[state];
}

export function prStateGlyph(state: PullRequestState): SVGSVGElement {
  const el = svg('pr', prStateLabel(state));
  if (state === 'draft') {
    part(el, 'circle', { cx: '8', cy: '8', r: '5.25', 'stroke-dasharray': '2 2' });
  } else if (state === 'open') {
    part(el, 'circle', { cx: '8', cy: '8', r: '5.25' });
    part(el, 'path', { d: 'M6 10l4-4M7 6h3v3' });
  } else if (state === 'merged') {
    // Inverted filled circle with the check knocked out in the paper behind it.
    part(el, 'path', {
      d: 'M8 2.25a5.75 5.75 0 1 0 0 11.5a5.75 5.75 0 1 0 0-11.5ZM4.35 7.85l1.05-1.05 1.7 1.7 3.5-3.5 1.05 1.05-4.55 4.55z',
      fill: 'currentColor', 'fill-rule': 'evenodd', stroke: 'none',
    });
  } else {
    part(el, 'circle', { cx: '8', cy: '8', r: '5.25' });
    part(el, 'path', { d: 'M3 13L13 3' });
  }
  return el;
}
