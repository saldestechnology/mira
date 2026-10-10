import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'visual-check.mjs');

describe('visual-check states', () => {
  it('lists the real-server tracker state and restricts it to accounts mode', () => {
    const help = execFileSync(process.execPath, [script, '--help'], { cwd: root, encoding: 'utf8' });
    expect(help).toContain('tracker-real-server');

    const openMode = spawnSync(process.execPath, [script, '--id', 'cdx-10', '--mode', 'open', '--states', 'tracker-real-server'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(openMode.status).toBe(2);
    expect(openMode.stderr).toContain('state "tracker-real-server" needs --mode accounts');
  });
  it('lists guest-cursors as a visual state', () => {
    const help = execFileSync(process.execPath, [script, '--help'], { cwd: root, encoding: 'utf8' });
    expect(help).toContain('guest-cursors');
  });
});
