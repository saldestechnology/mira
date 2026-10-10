import { describe, expect, it } from 'vitest';
import { renderTrackerSnapshot, publishTrackerSnapshot } from '../src/tracker/ui/frame-snapshot';
import type { BaseObj } from '../src/types';
import type { TrackerTicket } from '../src/tracker-types';

function frame(trackerId: string, h = 1000): BaseObj {
  return { id: 'frame', type: 'tracker', x: 0, y: 0, w: 800, h, rotation: 0, z: 'a0', trackerId };
}

function ticket(key: string, title: string, state: string): TrackerTicket {
  return { key, title, state: { name: state } } as TrackerTicket;
}

describe('tracker frame snapshots', () => {
  it('escapes hostile ticket text for XML output', () => {
    const trackerId = 'snapshot-xml-escape';
    publishTrackerSnapshot(trackerId, 'all', [
      ticket(`T<&>"'`, `Title <b>& "double" 'single'`, `State <open>& "quoted" 'again'`),
    ], 1);

    const svg = renderTrackerSnapshot(frame(trackerId));

    expect(svg).toContain('>T&lt;&amp;&gt;&quot;&apos;</text>');
    expect(svg).toContain('>Title &lt;b&gt;&amp; &quot;double&quot; &apos;single&apos;</text>');
    expect(svg).toContain('>State &lt;open&gt;&amp; &quot;quoted&quot; &apos;again&apos;</text>');
    expect(svg).not.toContain(`T<&>"'`);
    expect(svg).not.toContain(`Title <b>& "double" 'single'`);
    expect(svg).not.toContain(`State <open>& "quoted" 'again'`);
  });

  it('caps published rows at twelve and floors the displayed issue count', () => {
    const trackerId = 'snapshot-row-count-bounds';
    const tickets = Array.from({ length: 13 }, (_, index) =>
      ticket(`TAB-${index + 1}`, `Ticket ${index + 1}`, 'To do'));
    publishTrackerSnapshot(trackerId, 'all', tickets, 13.9);

    const svg = renderTrackerSnapshot(frame(trackerId));

    for (let index = 1; index <= 12; index++) expect(svg).toContain(`>TAB-${index}</text>`);
    expect(svg).not.toContain('>TAB-13</text>');
    expect(svg).toContain('>13 issues</text>');
  });

  it('clamps a negative issue count to zero', () => {
    const trackerId = 'snapshot-negative-count';
    publishTrackerSnapshot(trackerId, 'all', [ticket('TAB-1', 'One issue', 'To do')], -4);

    expect(renderTrackerSnapshot(frame(trackerId))).toContain('>0 issues</text>');
  });
});
