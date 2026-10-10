import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, THEMES } from '../src/themes';

const css = readFileSync(new URL('../src/tracker/ui/tracker.css', import.meta.url), 'utf8');
const ticketCss = readFileSync(new URL('../src/tracker/ui/ticket-page.css', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function declarations(source: string, selector: string): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, header]) => header.trim() === selector);
  if (!rule) throw new Error(`missing CSS rule: ${selector}`);
  return rule[2];
}

function mixHex(foreground: string, background: string, foregroundShare: number): string {
  const channels = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const from = channels(foreground);
  const to = channels(background);
  return `#${from.map((channel, index) => Math.round(channel * foregroundShare + to[index] * (1 - foregroundShare)).toString(16).padStart(2, '0')).join('')}`;
}

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

  it('keeps tracker link, status, error, and pending timestamp text at AA contrast in every theme', () => {
    const inkOnPaper = [
      [ticketCss, '.trk.tk-page .tk-external-link'],
      [ticketCss, '.trk.tk-page .tk-new-comments'],
      [css, '.trk .trk-relative-time'],
    ] as const;
    for (const [source, selector] of inkOnPaper) expect(declarations(source, selector)).toMatch(/color:\s*var\(--ink\)/);
    expect(declarations(ticketCss, '.trk.tk-page')).toMatch(/background:\s*var\(--paper-hi,\s*var\(--paper\)\)/);
    expect(declarations(appCss, '.tray')).toMatch(/background:\s*var\(--tray\)/);

    const trayErrors = declarations(css, '.trk-inline-error, .trk-create-reason');
    expect(trayErrors).toMatch(/color:\s*var\(--tray-text\)/);
    expect(trayErrors).toMatch(/border-radius:\s*var\(--radius-xs\)/);
    expect(trayErrors).toMatch(/color-mix\(in srgb, var\(--danger\) 80%, var\(--tray-text\)\)/);
    expect(declarations(css, '.trk-inline-error::before, .trk-create-reason::before')).toMatch(/content:\s*'!'/);
    const pending = declarations(ticketCss, '.trk.tk-page .tk-comment-row.pending');
    expect(pending).not.toMatch(/opacity\s*:/);
    expect(pending).toMatch(/border-inline-start:\s*1px dashed var\(--ink\)/);

    for (const theme of THEMES) {
      for (const [, selector] of inkOnPaper) {
        expect(contrast(theme.vars['--ink'], theme.vars['--paper']), `${theme.id} ${selector} on paper`).toBeGreaterThanOrEqual(4.5);
      }
      for (const label of ['inline error', 'offline create reason']) {
        expect(contrast(theme.vars['--tray-text'], theme.vars['--tray']), `${theme.id} ${label} on tray`).toBeGreaterThanOrEqual(4.5);
      }
      const dangerMarker = mixHex(theme.vars['--danger'], theme.vars['--tray-text'], 0.8);
      expect(contrast(dangerMarker, theme.vars['--tray']), `${theme.id} danger marker on tray`).toBeGreaterThanOrEqual(3);
    }
  });
});
