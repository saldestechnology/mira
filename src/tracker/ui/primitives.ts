import './tracker.css';
import { h } from '../../ui/dom';
import { actorBadgeGlyph, actorLabel, type ActorBadgeKind } from './glyphs';
import { ticketChipText } from './keys-util';

export function keyChip(key: string): HTMLElement {
  const display = ticketChipText(key);
  const match = /^([A-Z]{2,5}-)(\d+)$/i.exec(display);
  if (!match) return h('span', { class: 'trk-key-chip' }, display);
  return h('span', { class: 'trk-key-chip', 'aria-label': display },
    h('span', { class: 'trk-key-prefix', 'aria-hidden': 'true' }, match[1].toUpperCase()),
    h('span', { class: 'trk-key-number', 'aria-hidden': 'true' }, match[2]),
  );
}

export function labelChip(name: string, color?: string | null): HTMLElement {
  const chip = h('span', { class: 'trk-label-chip' }, name);
  if (color && /^#[\da-f]{3,8}$/i.test(color)) chip.style.setProperty('--trk-label-color', color);
  return chip;
}

export function countBadge(count: number, label?: string): HTMLElement {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return h('span', {
    class: 'trk-count-badge',
    'aria-label': label ?? `${safeCount} ${safeCount === 1 ? 'issue' : 'issues'}`,
  }, String(safeCount));
}

export type AvatarActor =
  | { kind: 'person'; name: string; imageUrl?: string | null }
  | { kind: ActorBadgeKind; name?: string };

function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return words.slice(0, 2).map((word) => Array.from(word)[0] ?? '').join('').toLocaleUpperCase();
}

export function avatar(actor: AvatarActor): HTMLElement {
  if (actor.kind !== 'person') {
    return h('span', { class: 'trk-actor-badge', 'aria-label': actor.name ?? actorLabel(actor.kind) },
      actorBadgeGlyph(actor.kind),
      h('span', null, actor.name ?? actorLabel(actor.kind)),
    );
  }
  if (actor.imageUrl) {
    return h('span', { class: 'trk-avatar', role: 'img', 'aria-label': actor.name },
      h('img', { src: actor.imageUrl, alt: '', 'aria-hidden': 'true' }),
    );
  }
  return h('span', { class: 'trk-avatar', 'aria-label': actor.name }, initials(actor.name) || '?');
}

function absoluteTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'Unknown time' : at.toLocaleString();
}

export function formatRelative(now: number, iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(now) || Number.isNaN(then)) return 'Unknown time';
  const delta = then - now;
  const future = delta > 0;
  const seconds = Math.abs(delta) / 1000;
  // a time ahead of this clock is clock skew between server and client, never news: show it as now
  if (future) return 'just now';
  if (seconds < 60) return 'just now';
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'], [60 * 60 * 24 * 30, 'month'], [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'], [60 * 60, 'hour'], [60, 'minute'],
  ];
  const [size, unit] = units.find(([secondsPerUnit]) => seconds >= secondsPerUnit)!;
  const amount = Math.floor(seconds / size);
  const text = `${amount} ${unit}${amount === 1 ? '' : 's'}`;
  return `${text} ago`;
}

export function relativeTime(now: number, iso: string): HTMLTimeElement {
  const absolute = absoluteTime(iso);
  const label = formatRelative(now, iso);
  return h('time', { class: 'trk-relative-time', dateTime: iso, title: absolute, 'aria-label': `${label} (${absolute})` },
    label,
  );
}

export function dueChip(due: string | null, now: number): HTMLElement | null {
  if (!due) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(due) ? new Date(`${due}T00:00:00Z`) : null;
  const valid = !!parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === due;
  if (!valid) return h('span', { class: 'trk-due-chip' }, `Due ${due}`);
  const today = new Date(now).toISOString().slice(0, 10);
  const overdue = due < today;
  const date = new Date(`${due}T00:00:00Z`);
  const shortDate = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const text = due === today ? 'Due today' : overdue ? `Overdue · ${shortDate}` : `Due ${shortDate}`;
  return h('span', {
    class: `trk-due-chip${overdue ? ' trk-overdue' : ''}`,
    'aria-label': overdue ? `Overdue, due ${date.toLocaleDateString(undefined, { dateStyle: 'long', timeZone: 'UTC' })}` : text,
  }, text);
}
