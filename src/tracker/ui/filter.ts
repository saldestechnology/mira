import { formatFilterTokens, parseFilterTokens, type TrackerFilterField } from './filter-grammar';

export type FilterField = TrackerFilterField;
export type FilterChip = {
  field: FilterField | 'creator' | 'text';
  value: string;
  not?: boolean;
  /** Fixed view filters stay visible but cannot be removed or serialized as user filters. */
  locked?: boolean;
};

export class FilterTokenError extends Error {
  constructor(public readonly token: string) {
    super(`Invalid tracker filter: ${token}`);
    this.name = 'FilterTokenError';
  }
}

/** Parses UI chips with the data layer's accepted server grammar. Bare text remains a search chip. */
export function parse(tokens: readonly string[]): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const source of tokens) {
    if (!source.includes(':')) {
      if (source.trim()) chips.push({ field: 'text', value: source.trim() });
      continue;
    }
    try {
      const [token] = parseFilterTokens([source]);
      chips.push({ field: token.field, value: token.value, not: token.not || undefined });
    } catch {
      throw new FilterTokenError(source);
    }
  }
  return chips;
}

/** Serializes editable chips through the same grammar helpers used by the store. */
export function build(chips: readonly FilterChip[]): string[] {
  return chips.flatMap((chip) => {
    if (chip.locked) return [];
    if (!chip.value.trim()) throw new FilterTokenError(chip.field === 'text' ? chip.value : `${chip.field}:`);
    if (chip.field === 'text') {
      if (chip.value.includes('\n')) throw new FilterTokenError(chip.value);
      return [chip.value];
    }
    if (chip.field === 'creator') throw new FilterTokenError(`${chip.field}:${chip.value}`);
    try {
      return formatFilterTokens([{ field: chip.field, value: chip.value, not: Boolean(chip.not) }]);
    } catch {
      throw new FilterTokenError(`${chip.not ? '-' : ''}${chip.field}:${chip.value}`);
    }
  });
}

export function filterChipLabel(chip: FilterChip): string {
  if (chip.field === 'text') return chip.value;
  const prefix = chip.not ? 'not ' : '';
  const value = chip.value === 'me' ? 'Me' : chip.value.replaceAll('_', ' ');
  return `${prefix}${chip.field}: ${value}`;
}
