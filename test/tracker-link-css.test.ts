import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cssFiles = [
  readFileSync(new URL('../src/tracker/ui/link-dialog.css', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/tracker/ui/unlink-confirm.css', import.meta.url), 'utf8'),
];

describe('tracker linking dialog styles', () => {
  it('uses scoped selectors and theme variables only', () => {
    expect(cssFiles[0]).toContain('var(--radius-md');
    for (const css of cssFiles) {
      expect(css).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/i);
      const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const selectors = [...source.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(([, selector]) => selector.trim()).filter((selector) => !selector.startsWith('@'));
      expect(selectors.length).toBeGreaterThan(5);
      for (const selector of selectors) for (const part of selector.split(',')) expect(part.trim().startsWith('.trk')).toBe(true);
      expect(css).toContain('var(--radius-lg');
      expect(css).toContain('var(--radius-sm');
      expect(css).toContain('outline: 2px solid var(--signal)');
      expect(css).toContain('outline-offset: 2px');
      expect(css).toContain('prefers-reduced-motion: reduce');
      expect(css).toContain('forced-colors: active');
    }
  });
});
