import type { TrackerStateCategory, TrackerTicket } from './tracker-types';

export type TicketTextSegment =
  | { type: 'text'; text: string }
  | { type: 'key'; key: string; raw: string };

export interface TrackerChipModel {
  key: string;
  title: string;
  state: { name: string; category: TrackerStateCategory } | null;
  resolved: boolean;
}

export type TicketLookup = (key: string) => TrackerTicket | null | undefined;

const KEY_RE = /\b([A-Z]{2,5}-[1-9][0-9]{0,18})\b/gi;
const URL_RE = /\b(?:[a-z][a-z0-9.+-]{1,20}:\/\/|(?:mailto|tel):|www\.)\S+/gi;

function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  URL_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);

  const open = new Map<number, number>();
  for (let at = 0; at < text.length;) {
    if (text[at] !== '`') { at += 1; continue; }
    const start = at;
    while (at < text.length && text[at] === '`') at += 1;
    let slashes = 0;
    for (let before = start - 1; before >= 0 && text[before] === '\\'; before -= 1) slashes += 1;
    if (slashes % 2 === 1) continue;
    const length = at - start;
    const opener = open.get(length);
    if (opener === undefined) open.set(length, start);
    else {
      ranges.push([opener, at]);
      open.delete(length);
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** Split visible ticket keys while leaving URLs and Markdown code spans untouched. */
export function splitTicketKeys(text: string, options: { prefixes: readonly string[] }): TicketTextSegment[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const requestedPrefixes = Array.isArray(options?.prefixes) ? options.prefixes : [];
  const prefixes = new Set(requestedPrefixes
    .filter((prefix): prefix is string => typeof prefix === 'string' && /^[A-Za-z]{2,5}$/.test(prefix))
    .map((prefix) => prefix.toUpperCase()));
  if (prefixes.size === 0) return [{ type: 'text', text }];

  const protectedText = protectedRanges(text);
  const result: TicketTextSegment[] = [];
  let lastEnd = 0;
  let protectedIndex = 0;
  KEY_RE.lastIndex = 0;
  for (const match of text.matchAll(KEY_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    while (protectedIndex < protectedText.length && protectedText[protectedIndex][1] <= start) protectedIndex += 1;
    const blocked = protectedText[protectedIndex];
    if (!prefixes.has(raw.slice(0, raw.indexOf('-')).toUpperCase()) || (blocked && start >= blocked[0] && start < blocked[1])) continue;
    if (start > lastEnd) result.push({ type: 'text', text: text.slice(lastEnd, start) });
    result.push({ type: 'key', key: raw.toUpperCase(), raw });
    lastEnd = end;
  }
  if (lastEnd < text.length) result.push({ type: 'text', text: text.slice(lastEnd) });
  return result.length === 0 ? [{ type: 'text', text }] : result;
}

/** An unavailable ticket intentionally returns only its original key, so callers keep it as plain text. */
export function chipModel(key: string, ticketLookup: TicketLookup): TrackerChipModel {
  const normalized = typeof key === 'string' ? key.toUpperCase() : '';
  if (!/^[A-Z]{2,5}-[1-9][0-9]{0,18}$/.test(normalized)) {
    return { key: normalized, title: key, state: null, resolved: false };
  }
  let ticket: TrackerTicket | null | undefined;
  try {
    ticket = ticketLookup(normalized);
  } catch {
    ticket = undefined;
  }
  if (!ticket || typeof ticket.key !== 'string' || typeof ticket.title !== 'string'
    || typeof ticket.state?.name !== 'string' || typeof ticket.state?.category !== 'string') {
    return { key: normalized, title: key, state: null, resolved: false };
  }
  return {
    key: ticket.key,
    title: ticket.title,
    state: { name: ticket.state.name, category: ticket.state.category },
    resolved: true,
  };
}
