import { describe, expect, it } from 'vitest';
import { chipModel, splitTicketKeys } from '../src/tracker-chips';
import type { TrackerTicket } from '../src/tracker-types';

const prefixes = ['TAB', 'OLD'];

function ticket(overrides: Partial<TrackerTicket> = {}): TrackerTicket {
  return {
    id: 'ticket-1', key: 'TAB-123', trackerId: 'tracker-1', title: 'Fix lane movement', description: '',
    state: { id: 'state-doing', key: 'doing', name: 'In progress', category: 'started' }, priority: 'none',
    assignee: null, creator: { type: 'user', id: 'user-1', name: 'A' }, labels: [], project: null,
    milestone: null, estimate: null, due: null, parent: null, relations: [], links: [], aliases: ['OLD-9'],
    archivedAt: null, createdAt: 1, updatedAt: 2, updatedSeq: 3, ...overrides,
  };
}

describe('splitTicketKeys', () => {
  it('keeps punctuation and markdown around case-insensitive keys', () => {
    expect(splitTicketKeys('Fix (tab-123), then **OLD-9**.', { prefixes })).toEqual([
      { type: 'text', text: 'Fix (' }, { type: 'key', key: 'TAB-123', raw: 'tab-123' },
      { type: 'text', text: '), then **' }, { type: 'key', key: 'OLD-9', raw: 'OLD-9' }, { type: 'text', text: '**.' },
    ]);
  });

  it('chips visible markdown text but not URL destinations or URL contents', () => {
    expect(splitTicketKeys('[TAB-1](https://example.test/TAB-2) https://example.test/TAB-3 www.example.test/TAB-4', { prefixes }))
      .toEqual([
        { type: 'text', text: '[' }, { type: 'key', key: 'TAB-1', raw: 'TAB-1' },
        { type: 'text', text: '](https://example.test/TAB-2) https://example.test/TAB-3 www.example.test/TAB-4' },
      ]);
  });

  it('ignores inline and fenced Markdown code spans', () => {
    expect(splitTicketKeys('`TAB-1` ```txt\nOLD-2\n``` TAB-3', { prefixes })).toEqual([
      { type: 'text', text: '`TAB-1` ```txt\nOLD-2\n``` ' }, { type: 'key', key: 'TAB-3', raw: 'TAB-3' },
    ]);
  });

  it('finds multiple keys and preserves an unmatched key as ordinary text when its prefix is disabled', () => {
    expect(splitTicketKeys('TAB-1 / OLD-2 / XYZ-3', { prefixes })).toEqual([
      { type: 'key', key: 'TAB-1', raw: 'TAB-1' }, { type: 'text', text: ' / ' },
      { type: 'key', key: 'OLD-2', raw: 'OLD-2' }, { type: 'text', text: ' / XYZ-3' },
    ]);
    expect(splitTicketKeys('TAB-1', { prefixes: [] })).toEqual([{ type: 'text', text: 'TAB-1' }]);
  });

  it('scans 10k-character text with repeated URLs and code spans quickly', () => {
    const text = ('plain TAB-1 `OLD-2` https://example.test/TAB-3 ').repeat(220);
    const start = performance.now();
    const segments = splitTicketKeys(text, { prefixes });
    const elapsed = performance.now() - start;
    expect(text.length).toBeGreaterThan(10_000);
    expect(segments.filter((segment) => segment.type === 'key')).toHaveLength(220);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('chipModel', () => {
  it('returns canonical ticket data only when lookup can read the ticket', () => {
    expect(chipModel('old-9', () => ticket())).toEqual({
      key: 'TAB-123', title: 'Fix lane movement', state: { name: 'In progress', category: 'started' }, resolved: true,
    });
    expect(chipModel('TAB-999', () => undefined)).toEqual({
      key: 'TAB-999', title: 'TAB-999', state: null, resolved: false,
    });
    expect(chipModel('TAB-999', () => { throw new Error('forbidden'); })).toMatchObject({ resolved: false, state: null });
  });
});
