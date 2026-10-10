import { readFileSync, readdirSync } from 'node:fs';
import { join, relative as relativePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A path from the repository root with forward slashes, which is how the expectations below spell it (Windows gives backslashes). */
const relative = (from: string, to: string) => relativePath(from, to).replaceAll('\\', '/');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? cssFiles(file) : entry.name.endsWith('.css') ? [file] : [];
  });
}

function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selector = css.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1;
    let end = open + 1;
    while (end < css.length && depth) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') depth--;
      end++;
    }
    const body = css.slice(open + 1, end - 1);
    if (selector.startsWith('@media') || selector.startsWith('@supports') || selector.startsWith('@container')) out.push(...rules(body));
    else if (!selector.startsWith('@')) out.push({ selector, body });
    i = end;
  }
  return out;
}

const FILES = [join(ROOT, 'src/styles.css'), ...cssFiles(join(ROOT, 'src/ui'))];
const ALL_RULES = FILES.flatMap((file) => rules(readFileSync(file, 'utf8')).map((rule) => ({ ...rule, file })));

describe('UI chrome radii', () => {
  it('defines the four shared radius tokens and keeps the legacy alias', () => {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    const root = rules(css).find((rule) => rule.selector === ':root')?.body ?? '';
    expect(root).toMatch(/--radius-xs:\s*4px\s*;/);
    expect(root).toMatch(/--radius-sm:\s*8px\s*;/);
    expect(root).toMatch(/--radius-md:\s*12px\s*;/);
    expect(root).toMatch(/--radius-lg:\s*14px\s*;/);
    expect(root).toMatch(/--radius:\s*var\(--radius-md\)\s*;/);
  });

  it('keeps curated UI chrome selectors on nonzero radii', () => {
    const chrome = [
      '.tray', '.btn', '.input', '.modal', '.menu', '.ctx-menu', '.popover', '.quickbar', '.rail',
      '.top-left', '.top-right', '.toast', '.minimap', '.combo', '.combo-list', '.segmented', '.chip',
      '.drawer', '.flowbar', '.zoom-tray', '.poll-card', '.emoji-pop', '.ks-sheet', '.ks-bsheet',
    ];
    const zero = ALL_RULES.flatMap((rule) => rule.body.match(/border-radius\s*:\s*0(?:\s*px)?\s*(?:!important\s*)?;/g)?.map((value) => `${relative(ROOT, rule.file)} ${rule.selector}: ${value}`) ?? []);
    const boardContent = [
      ".text-editor[data-mode='class']",
      '.remote-cursor-name',
    ];
    const intentional = zero.filter((entry) => boardContent.some((selector) => entry.endsWith(`${selector}: border-radius: 0;`)));
    expect(zero.filter((entry) => !intentional.includes(entry))).toEqual([]);
    expect(intentional).toHaveLength(boardContent.length);
    expect(intentional).toEqual(expect.arrayContaining([
      `src/styles.css .text-editor[data-mode='class']: border-radius: 0;`,
      'src/styles.css .remote-cursor-name: border-radius: 0;',
    ]));
    const mentions = (selector: string, base: string) => new RegExp(`(?:^|[\\s,>+~])${base.replaceAll('.', '\\.')}($|[\\s.#:\\[>+~])`).test(selector);
    const curatedZero = ALL_RULES.filter((rule) => /border-radius\s*:\s*0(?:\s*px)?\s*(?:!important\s*)?;/.test(rule.body)
      && chrome.some((selector) => mentions(rule.selector, selector)))
      .map((rule) => `${relative(ROOT, rule.file)} ${rule.selector}`);
    expect(curatedZero).toEqual([]);
  });

  it('keeps board text and remote cursor geometry, matching the connector label pill', () => {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    const parsed = rules(css);
    const value = (selector: string) => parsed.find((rule) => rule.selector === selector)?.body.match(/border-radius\s*:\s*([^;]+)/)?.[1].trim();
    expect(value(".text-editor[data-mode='class']")).toBe('0');
    expect(value(".text-editor[data-mode='label']")).toBe('var(--radius-xs)');
    expect(value('.remote-cursor-name')).toBe('0');
    expect(value('.remote-cursor-guest')).toBe('var(--radius-xs)');

    const markup = readFileSync(join(ROOT, 'src/markup.ts'), 'utf8');
    expect(markup).toMatch(/rx="4" fill="\$\{PAPER\}"/);

    const kanbanCanvasRules = ALL_RULES.filter((rule) => rule.selector.split(',').some((selector) => /(?:^|[\s>])\.canvas(?:$|\s|[.#:[>])/.test(selector.trim())));
    expect(kanbanCanvasRules.flatMap((rule) => rule.body.match(/border-radius\s*:[^;]+;/g) ?? [])).toEqual([]);
  });

  it('clips rounded containers where full-width inner rows meet the edge', () => {
    for (const selector of ['.modal', '.drawer', '.side-tray', '.ks-sheet']) {
      const body = ALL_RULES.find((rule) => rule.selector === selector && /overflow:\s*hidden\s*;/.test(rule.body))?.body ?? '';
      expect(body, `${selector} should clip its edge rows`).toMatch(/overflow:\s*hidden\s*;/);
    }
  });
});
