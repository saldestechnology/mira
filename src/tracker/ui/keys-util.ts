export interface ParsedTicketKey {
  key: string;
  prefix: string;
  number: number;
}

const KEY = /(?:^|\/t\/)([A-Z]{2,5})-(\d+)(?=$|[/?#])/i;

/** Accepts a canonical key, an alias-shaped key, or a /t/ deep link. */
export function parseTicketKey(value: string): ParsedTicketKey | null {
  const match = KEY.exec(value.trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 0) return null;
  const prefix = match[1].toUpperCase();
  return { key: `${prefix}-${number}`, prefix, number };
}

export function ticketPath(value: string): string | null {
  const parsed = parseTicketKey(value);
  return parsed ? `/t/${parsed.key}` : null;
}

/** The visible text of a ticket key, normalized when it has the expected form. */
export function ticketChipText(value: string): string {
  return parseTicketKey(value)?.key ?? value;
}
