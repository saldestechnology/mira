import { describe, expect, it } from 'vitest';
import { linkedCardHeaderMarkup, unmappedLaneChipMarkup, unmappedStateChipMarkup } from '../src/tracker/ui/linked-card-style';

const state = { key: 'in_progress', name: 'In progress', category: 'started' as const };

describe('linked canvas card SVG helpers', () => {
  it('draws the linked marker and tabular key with shared state glyph geometry', () => {
    const markup = linkedCardHeaderMarkup({ key: 'TAB-124', state, laneStateKey: 'todo', width: 280, zoom: 1 });
    expect(markup).toContain('width="3" height="100%"');
    expect(markup).toContain('x="12"');
    expect(markup).toContain('font-size="11"');
    expect(markup).toContain('font-variant-numeric="tabular-nums"');
    expect(markup).toContain('In progress');
    expect(markup).toContain('M8 2.75A5.25 5.25 0 0 1 8 13.25Z');
    expect(markup).toContain('var(--canvas-ink)');
    expect(markup).toContain('var(--graphite)');
  });

  it('only draws a state name when the state differs or the lane is wide, and drops it below the zoom threshold', () => {
    expect(linkedCardHeaderMarkup({ key: 'TAB-5', state, laneStateKey: 'in_progress', width: 200, zoom: 1 })).not.toContain('In progress');
    expect(linkedCardHeaderMarkup({ key: 'TAB-5', state, laneStateKey: 'in_progress', width: 250, zoom: 1 })).toContain('In progress');
    const low = linkedCardHeaderMarkup({ key: 'TAB-5', state, laneStateKey: 'todo', width: 200, zoom: 0.8 });
    expect(low).not.toContain('In progress');
    expect(low).toContain('viewBox="0 0 16 16"');
  });

  it('includes urgent/high priority, offline and blocked markers only when requested', () => {
    const normal = linkedCardHeaderMarkup({ key: 'TAB-1', state: null, laneStateKey: null, width: 200, zoom: 1, priority: 'medium' });
    expect(normal).not.toContain('trk-priority');
    const marked = linkedCardHeaderMarkup({ key: 'TAB-1', state: null, laneStateKey: null, width: 280, zoom: 1, priority: 'urgent', offline: true, blocked: true });
    expect(marked).toContain('trk-priority');
    expect(marked).toContain('trk-offline');
    expect(marked).toContain('trk-blocked');
    expect(marked).toContain('Blocked');
    expect(linkedCardHeaderMarkup({ key: 'TAB-1', state: null, laneStateKey: null, width: 280, zoom: 1, priority: 'high' })).toContain('trk-priority');
    expect(linkedCardHeaderMarkup({ key: 'TAB-1', state: null, laneStateKey: null, width: 280, zoom: 1, priority: 'low' })).not.toContain('trk-priority');
  });

  it('escapes hostile key and state text and builds theme-colored mapping chips', () => {
    const hostile = linkedCardHeaderMarkup({
      key: 'TAB-<img onerror="x">', state: { ...state, name: '<script>bad & worse</script>' }, laneStateKey: 'todo', width: 280, zoom: 1,
    });
    expect(hostile).toContain('&lt;img onerror=&quot;x&quot;&gt;');
    expect(hostile).toContain('&lt;script&gt;bad &amp; worse&lt;/script&gt;');
    expect(hostile).not.toContain('<script>');

    const unmapped = unmappedStateChipMarkup({ width: 150 });
    expect(unmapped).toContain('stroke-dasharray');
    expect(unmapped).toContain('Unmapped state');
    expect(unmapped).toContain('<title>State not mapped to a lane</title>');
    expect(unmapped).toContain('var(--');
    expect(unmappedLaneChipMarkup()).toContain('Not linked');
    for (const markup of [hostile, unmapped, unmappedLaneChipMarkup()]) {
      expect(markup).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/i);
    }
  });
});
