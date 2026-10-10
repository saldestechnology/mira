import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEMES, type Theme } from '../src/themes';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Fixed colours that stay the same in every theme: sticky notes, white avatars (comments and chat) and cursor labels,
// the modal scrim, and the white field behind the class and label editors (the fallback when the
// object has no colours of its own; editor.ts sets those inline).
const ALLOWED: { file: string; selector: string; literals: string[] }[] = [
  { file: 'src/styles.css', selector: '.remote-cursor-name', literals: ['#fff'] },
  { file: 'src/styles.css', selector: '.avatar', literals: ['#fff'] },
  { file: 'src/styles.css', selector: "[data-tool='sticky']::after", literals: ['#FFE16B'] },
  { file: 'src/styles.css', selector: '.note::after', literals: ['#fff'] },
  { file: 'src/styles.css', selector: '.text-editor[data-mode', literals: ['#fff'] },
  { file: 'src/styles.css', selector: '.tile.uml svg', literals: ['#fff'] },
  { file: 'src/styles.css', selector: '.icon-tile', literals: ['#fff'] },
  {
    file: 'src/styles.css',
    selector: '.empty-hint',
    literals: ['#1D1A12', '#FFE16B', '#FFF0B0', '#FFE58A', '#18212B', 'rgba(24, 33, 43, 0.2)', 'rgba(0, 0, 0, 0.12)', 'rgba(29, 26, 18, 0.1)'],
  },
  { file: 'src/ui/comments.css', selector: '.comment-avatar', literals: ['#fff'] },
  { file: 'src/ui/chat.css', selector: '.chat-avatar', literals: ['#fff'] },
];

const LITERAL = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|(?<![\w-])rgba?\([^)]*\)|(?<![\w-])(?:white|black)(?![\w-])/gi;

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

// Blanks comments but keeps their newlines, so reported line numbers match the source.
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

function isAllowed(file: string, selector: string, literal: string): boolean {
  return ALLOWED.some((a) => a.file === file && selector.includes(a.selector) && a.literals.some((l) => norm(l) === norm(literal)));
}

function scan(file: string): string[] {
  const css = stripComments(readFileSync(file, 'utf8'));
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  const violations: string[] = [];
  for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = block[1].trim();
    if (selector === ':root') continue;
    const bodyStart = (block.index ?? 0) + block[1].length + 1;
    for (const found of block[2].matchAll(LITERAL)) {
      const line = css.slice(0, bodyStart + (found.index ?? 0)).split('\n').length;
      if (!isAllowed(rel, selector, found[0])) violations.push(`${rel}:${line} ${selector} ${found[0]}`);
    }
  }
  return violations;
}

type RGB = [number, number, number];

function hexRgb(value: string): RGB {
  const match = /^#([\da-f]{6})$/i.exec(value);
  if (!match) throw new Error(`expected a six-digit theme colour, got ${value}`);
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16)) as RGB;
}

function resolveThemeToken(value: string, theme: Theme): RGB {
  const match = /^var\((--[\w-]+)\)$/.exec(value);
  if (!match) throw new Error(`expected a theme variable for a group outline, got ${value}`);
  return hexRgb(theme.vars[match[1] as keyof Theme['vars']]);
}

function luminance(rgb: RGB): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(a: RGB, b: RGB): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function colorDistance(a: RGB, b: RGB): number {
  return Math.hypot(...a.map((channel, i) => channel - b[i]));
}

function rootToken(name: string): string {
  const css = stripComments(readFileSync(join(ROOT, 'src/ui/group-ui.css'), 'utf8'));
  const root = css.match(/:root\s*\{([^}]+)\}/)?.[1];
  const value = root?.match(new RegExp(`(?:^|\\n)\\s*${name}:\\s*([^;]+);`))?.[1]?.trim();
  if (!value) throw new Error(`missing ${name} in group UI theme tokens`);
  return value;
}

describe('css colours', () => {
  it('uses theme variables instead of literal colours outside the allowlist', () => {
    const files = cssFiles(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap(scan)).toEqual([]);
  });

  it('keeps group hover and member outlines high-contrast across every theme', () => {
    const hoverToken = rootToken('--group-hover');
    const memberToken = rootToken('--group-member-line');
    for (const theme of THEMES) {
      const canvas = hexRgb(theme.vars['--canvas']);
      const paper = hexRgb(theme.vars['--paper']);
      const wire = hexRgb(theme.vars['--wire']);
      const hover = resolveThemeToken(hoverToken, theme);
      const member = resolveThemeToken(memberToken, theme);
      expect(contrastRatio(hover, canvas), `${theme.id} group hover`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(member, canvas), `${theme.id} group members`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(member, paper), `${theme.id} group members on paper`).toBeGreaterThanOrEqual(3);
      expect(colorDistance(hover, wire), `${theme.id} hover differs from selection`).toBeGreaterThan(50);
    }
  });

  it('keeps single-item selection outlines and handle strokes high-contrast across every theme', () => {
    for (const theme of THEMES) {
      const canvas = hexRgb(theme.vars['--canvas']);
      const paper = hexRgb(theme.vars['--paper']);
      const wire = hexRgb(theme.vars['--wire']);
      const handleFill = hexRgb(theme.vars['--selection-handle-fill']);
      const handleStroke = hexRgb(theme.vars['--selection-handle-stroke']);
      expect(contrastRatio(wire, canvas), `${theme.id} selection outline`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(handleStroke, canvas), `${theme.id} selection handles`).toBeGreaterThanOrEqual(3);
      expect(handleStroke, `${theme.id} handle stroke follows selection colour`).toEqual(wire);
      expect(handleFill, `${theme.id} handle fill follows group handle fill`).toEqual(paper);
    }
  });
});
