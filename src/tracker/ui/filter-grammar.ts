import { TrackerError } from '../../tracker-types';

// The server filter grammar as the UI models it (chips). Owned by the tracker UI so the data layer stays untouched.
export type TrackerFilterField = 'assignee' | 'state' | 'label' | 'due' | 'has' | 'is' | 'created';
export interface TrackerFilterToken { field: TrackerFilterField; value: string; not: boolean }

const TRACKER_FILTER_FIELDS = new Set<TrackerFilterField>(['assignee', 'state', 'label', 'due', 'has', 'is', 'created']);

function isValidDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Parses one server filter token; a leading `-` negates, commas mean any of. Throws invalid_filter. */
export function parseFilterToken(source: string): TrackerFilterToken {
  const token = source.trim();
  const not = token.startsWith('-');
  const body = not ? token.slice(1) : token;
  const separator = body.indexOf(':');
  const field = separator > 0 ? body.slice(0, separator).toLowerCase() : '';
  const value = separator > 0 ? body.slice(separator + 1).trim() : '';
  const values = value.split(',').map((item) => item.trim());
  const invalid = (): never => { throw new TrackerError('invalid_filter', `Invalid filter: ${source}`, { path: source }); };
  if (separator < 1 || !TRACKER_FILTER_FIELDS.has(field as TrackerFilterField) || !value || value.includes(':') || values.some((item) => !item)) invalid();
  const f = field as TrackerFilterField;
  if (f === 'due') {
    for (const item of values) {
      if (item === 'overdue' || item === 'today' || item === 'this-week') continue;
      if (!item.startsWith('before-') || !isValidDate(item.slice(7))) invalid();
    }
  } else if (f === 'has' && values.some((item) => item !== 'link')) invalid();
  else if (f === 'is' && values.some((item) => item !== 'archived')) invalid();
  else if (f === 'created' && values.some((item) => !item.startsWith('after-') || !isValidDate(item.slice(6)))) invalid();
  return { field: f, value, not };
}

export function parseFilterTokens(input: readonly string[]): TrackerFilterToken[] {
  return input.map(parseFilterToken);
}

/** Formats validated chips as the repeated filter parameters the tracker API accepts. */
export function formatFilterTokens(input: readonly TrackerFilterToken[]): string[] {
  return input.map((item) => {
    const token = `${item.not ? '-' : ''}${item.field}:${item.value}`;
    parseFilterToken(token);
    return token;
  });
}
