import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Keep the phone bars in separate rows and put the tool rail below them. Read CSS as text, as toast-steps.test.ts does.
const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

describe('the right top bar at the narrowest phones', () => {
  it('keeps the tray on one row, gives it eight pixels below the left bar, and moves the rail beneath it', () => {
    expect(css).toMatch(/\.top-right \{[^}]*display: flex; flex-wrap: nowrap;/);
    expect(css).toContain('.top-right { top: calc(64px + var(--safe-top)); gap: 4px; padding: 4px 2px; max-width: calc(100% - 24px - var(--safe-left) - var(--safe-right)); justify-content: flex-end; }');
    expect(css).toContain('.top-right { gap: 2px; }');
    expect(css).toMatch(/\.top-right \.btn\.primary \{ padding-left: 10px; padding-right: 10px; \}/);
    expect(css).toContain('.chrome > .rail { top: var(--panel-top); max-height: calc(100% - var(--panel-top) - 24px - var(--safe-bottom)); }');
    expect(css).toContain('.demo-board > .chrome .rail { top: var(--panel-top); max-height: calc(100% - var(--panel-top) - 24px - var(--safe-bottom)); }');
  });
});
