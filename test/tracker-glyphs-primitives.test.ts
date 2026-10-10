import { afterEach, describe, expect, it } from 'vitest';
import { actorBadgeGlyph, priorityGlyph, priorityLabel, prStateGlyph, prStateLabel, stateGlyph, stateLabel } from '../src/tracker/ui/glyphs';
import { avatar, countBadge, dueChip, formatRelative, keyChip, labelChip, relativeTime } from '../src/tracker/ui/primitives';
import { parseTicketKey, ticketChipText, ticketPath } from '../src/tracker/ui/keys-util';
import { installTrackerUiBrowser } from './tracker-ui-test-helpers';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; });

describe('tracker glyphs', () => {
  it('draws the five state categories as 16px currentColor SVGs and supplies accessible text labels', () => {
    browser = installTrackerUiBrowser();
    const cases = [
      ['backlog', 'backlog', 'Backlog'], ['unstarted', 'todo', 'To do'], ['started', 'in_progress', 'In progress'],
      ['started', 'in_review', 'In review'], ['completed', 'done', 'Done'], ['canceled', 'cancelled', 'Cancelled'],
    ] as const;
    for (const [category, key, label] of cases) {
      const glyph = stateGlyph(category, key);
      expect(glyph.tagName).toBe('SVG');
      expect(glyph.getAttribute('width')).toBe('16');
      expect(glyph.getAttribute('height')).toBe('16');
      expect(glyph.getAttribute('stroke-width')).toBe('1.5');
      expect(glyph.getAttribute('stroke-linecap')).toBe('square');
      expect(glyph.getAttribute('stroke')).toBe('currentColor');
      expect(glyph.getAttribute('aria-hidden')).toBe('true');
      expect(glyph.getAttribute('data-glyph-label')).toBe(label);
      expect(stateLabel(category, key)).toBe(label);
      expect(glyph.querySelectorAll('circle, path').length).toBeGreaterThan(0);
    }
    expect(stateGlyph('backlog').querySelector('circle')?.getAttribute('stroke-dasharray')).toBe('2 2');
    expect(stateGlyph('unstarted').querySelector('circle')?.getAttribute('fill')).toBeNull();
    expect(stateGlyph('completed').querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd');
    expect(stateGlyph('canceled').querySelectorAll('path')).toHaveLength(1);
  });

  it('draws priority bars and the urgent mark, plus each pull-request state', () => {
    browser = installTrackerUiBrowser();
    expect(priorityLabel('none')).toBe('No priority');
    expect(priorityLabel('urgent')).toBe('Urgent');
    expect(priorityGlyph('none').querySelector('path')?.getAttribute('d')).toBe('M3 8h10');
    expect(priorityGlyph('low').querySelectorAll('path')).toHaveLength(1);
    expect(priorityGlyph('medium').querySelectorAll('path')).toHaveLength(2);
    expect(priorityGlyph('high').querySelectorAll('path')).toHaveLength(3);
    expect(priorityGlyph('urgent').querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd');
    for (const state of ['draft', 'open', 'merged', 'closed'] as const) {
      const glyph = prStateGlyph(state);
      expect(glyph.getAttribute('aria-hidden')).toBe('true');
      expect(glyph.getAttribute('data-glyph-label')).toBe(prStateLabel(state));
      expect(glyph.getAttribute('stroke')).toBe('currentColor');
      expect(glyph.querySelectorAll('circle, path')).not.toHaveLength(0);
    }
    expect(prStateGlyph('draft').querySelector('circle')?.getAttribute('stroke-dasharray')).toBe('2 2');
    expect(prStateGlyph('merged').querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd');
    expect(prStateGlyph('closed').querySelectorAll('path')).toHaveLength(1);
  });

  it('uses source badges for agents, GitHub, and imports', () => {
    browser = installTrackerUiBrowser();
    for (const [kind, mark] of [['agent', 'A'], ['github', 'GH'], ['import', 'IM']] as const) {
      const glyph = actorBadgeGlyph(kind);
      expect(glyph.getAttribute('aria-hidden')).toBe('true');
      expect(glyph.querySelector('rect')).not.toBeNull();
      expect(glyph.querySelector('text')?.textContent).toBe(mark);
    }
  });
});

describe('tracker primitive chips and times', () => {
  it('keeps the key prefix muted, number visible, and label name present', () => {
    browser = installTrackerUiBrowser();
    const key = keyChip('tab-123');
    expect(key.textContent).toBe('TAB-123');
    expect(key.querySelector('.trk-key-prefix')?.textContent).toBe('TAB-');
    expect(key.querySelector('.trk-key-number')?.textContent).toBe('123');
    expect(key.getAttribute('aria-label')).toBe('TAB-123');
    expect(labelChip('Accessibility').textContent).toBe('Accessibility');
    expect(countBadge(7).textContent).toBe('7');
    expect(countBadge(7).getAttribute('aria-label')).toBe('7 issues');
  });

  it('renders initials for people and named square badges for non-person actors', () => {
    browser = installTrackerUiBrowser();
    expect(avatar({ kind: 'person', name: 'Maya Chen' }).textContent).toBe('MC');
    expect(avatar({ kind: 'agent' }).getAttribute('aria-label')).toBe('Agent');
    expect(avatar({ kind: 'github' }).getAttribute('aria-label')).toBe('GitHub');
    expect(avatar({ kind: 'import' }).getAttribute('aria-label')).toBe('Import');
  });

  it('formats relative time against an injected clock and keeps the absolute time in title', () => {
    browser = installTrackerUiBrowser();
    const now = Date.UTC(2026, 9, 10, 12);
    expect(formatRelative(now, new Date(now - 5 * 60_000).toISOString())).toBe('5 minutes ago');
    // a time ahead of the clock is skew, shown as now
    expect(formatRelative(now, new Date(now + 60_000).toISOString())).toBe('just now');
    expect(formatRelative(now, new Date(now + 8 * 30 * 86_400_000).toISOString())).toBe('just now');
    expect(formatRelative(now, 'bad-date')).toBe('Unknown time');
    const time = relativeTime(now, new Date(now - 5 * 60_000).toISOString());
    expect(time.textContent).toBe('5 minutes ago');
    expect(time.getAttribute('title')).not.toBe('');
  });

  it('spells out overdue due dates and never relies on color alone', () => {
    browser = installTrackerUiBrowser();
    const now = Date.UTC(2026, 9, 10, 12);
    expect(dueChip('2026-10-09', now)?.textContent).toMatch(/^Overdue/);
    expect(dueChip('2026-10-09', now)?.getAttribute('aria-label')).toMatch(/^Overdue/);
    expect(dueChip('2026-10-10', now)?.textContent).toBe('Due today');
    expect(dueChip('2026-10-12', now)?.textContent).toMatch(/^Due /);
    expect(dueChip('2026-02-30', now)?.textContent).toBe('Due 2026-02-30');
    expect(dueChip(null, now)).toBeNull();
  });
});

describe('ticket key helpers', () => {
  it('parses canonical keys, aliases, and deep links into stable paths and chip text', () => {
    expect(parseTicketKey('tab-123')).toEqual({ key: 'TAB-123', prefix: 'TAB', number: 123 });
    expect(parseTicketKey('ENG-45')?.key).toBe('ENG-45');
    expect(parseTicketKey('/t/TAB-123')).toEqual({ key: 'TAB-123', prefix: 'TAB', number: 123 });
    expect(parseTicketKey('/t/TAB-123?from=mail')?.key).toBe('TAB-123');
    expect(ticketPath('tab-123')).toBe('/t/TAB-123');
    expect(ticketPath('not-a-ticket')).toBeNull();
    expect(ticketChipText('eng-45')).toBe('ENG-45');
    expect(ticketChipText('free text')).toBe('free text');
  });
});
