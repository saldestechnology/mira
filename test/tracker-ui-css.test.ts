import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/tracker/ui/tracker.css', import.meta.url), 'utf8');

describe('tracker UI styles', () => {
  it('uses app theme variables instead of fixed colors and scopes every selector to .trk', () => {
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/i);
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...source.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(([, selector]) => selector.trim()).filter((selector) => !selector.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) for (const part of selector.split(',')) expect(part.trim().startsWith('.trk')).toBe(true);
  });

  it('keeps radius fallbacks, focus, phone sheet touch sizes, reduced motion, and forced colors', () => {
    expect(css).toContain('var(--radius-xs, 4px)');
    expect(css).toContain('var(--radius-sm, 8px)');
    expect(css).toContain('var(--radius-md, 12px)');
    expect(css).toContain('var(--radius-lg, 14px)');
    expect(css).toContain('outline: 2px solid var(--signal)');
    expect(css).toContain('outline-offset: 2px');
    expect(css).toContain(".trk .trk-list-row[aria-selected='true'] { box-shadow: inset 0 0 0 1px var(--signal); }");
    expect(css).toContain('(pointer: coarse), (max-width: 860px)');
    expect(css).toMatch(/\.trk input, \.trk select, \.trk \.trk-picker-search,[\s\S]*?\.trk-filter-input \{ min-height: 44px; \}/);
    expect(css).toMatch(/\.trk \.trk-filter-button,[\s\S]*?\.trk-gallery-picker-button \{ min-height: 44px; \}/);
    expect(css).toContain('width: 280px; min-width: 280px');
    expect(css).toContain('.trk-board-lanes.is-phone-lane .trk-board-lane');
    expect(css).toContain('min-height: 48px');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('forced-colors: active');
  });
});
