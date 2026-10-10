import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/tracker/ui/inbox.css', import.meta.url), 'utf8');
const foundation = readFileSync(new URL('../src/tracker/ui/tracker.css', import.meta.url), 'utf8');

describe('tracker inbox styles', () => {
  it('scopes every selector to the tracker namespace', () => {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...source.matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map(([, selector]) => selector.trim()).filter((selector) => !selector.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) {
      for (const part of selector.split(',')) expect(part.trim().startsWith('.trk')).toBe(true);
    }
  });

  it('keeps the reason line on a phone, so two notices on one ticket are not identical', () => {
    const narrow = css.slice(css.indexOf('@container (max-width: 719px)'), css.indexOf('@media (forced-colors: active)'));
    const rule = /\.trk \.trk-inbox-reason\s*\{([^}]*)\}/.exec(narrow);
    expect(rule?.[1]).toBeDefined();
    expect(rule![1]).not.toMatch(/display\s*:\s*none/);
    expect(rule![1]).toMatch(/display\s*:\s*block/);
    // the base rule cuts a long reason with an ellipsis on one line
    expect(css).toMatch(/\.trk \.trk-inbox-reason\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
  });

  it('keeps unread and selected rows distinguishable, adapts below 720px and supports forced colors', () => {
    expect(css).toContain('.trk .trk-inbox-row.is-unread');
    expect(css).toContain('.trk .trk-inbox-unread-dot::before');
    expect(css).toContain("@container (max-width: 719px)");
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('white-space: nowrap');
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain('outline: 2px solid Highlight');
    expect(foundation).toContain('outline: 2px solid var(--signal)');
    expect(foundation).toContain('outline-offset: 2px');
    expect(css).not.toMatch(/animation\s*:/i);
  });
});
