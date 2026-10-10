import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// At 320 px the right top bar ran under the tool rail (the first avatar sat half behind it). Read as text, as toast-steps.test.ts does.
const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

describe('the right top bar at the narrowest phones', () => {
  it('wraps the touch-sized tray clear of the rail and tightens the narrowest phones further', () => {
    expect(css).toMatch(/@media \(max-width: 500px\) \{[^}]*\.top-right \{[^}]*max-width: calc\(100% - var\(--rail-clear\)[^}]*flex-wrap: wrap;[^}]*justify-content: flex-end;/);
    expect(css).toMatch(/@media \(max-width: 340px\) \{\s*\.top-right \{[^}]*gap: 2px;/);
    expect(css).toMatch(/\.top-right \.btn\.primary \{ padding-left: 10px; padding-right: 10px; \}/);
    expect(css).toMatch(/@media \(pointer: coarse\) and \(min-width: 501px\) and \(max-width: 528px\) \{\s*\.top-right \{[^}]*max-width: calc\(100% - var\(--rail-clear\)[^}]*flex-wrap: wrap;[^}]*justify-content: flex-end;/);
  });
});
