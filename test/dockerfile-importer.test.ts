import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
const IMPORTER_FILES = ['scripts/linear-import.mjs', 'scripts/linear-verify.mjs', 'scripts/lib/linear-source.mjs'];

/** Relative `.mjs` imports of a file, resolved to repo-relative paths. */
function localImports(file: string): string[] {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)]
    .map((match) => path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
}

describe('the importer in the Docker image', () => {
  it('copies the importer scripts into the final stage and no other script', () => {
    const copies = [...finalStage.matchAll(/^COPY\s+(?!--from)(.+)$/gm)].map((match) => match[1].trim());
    const scriptSources = copies.flatMap((line) => line.split(/\s+/).slice(0, -1)).filter((source) => source.startsWith('scripts'));
    expect([...scriptSources].sort()).toEqual([...IMPORTER_FILES].sort());
    expect(finalStage).toMatch(/COPY scripts\/linear-import\.mjs scripts\/linear-verify\.mjs \.\/scripts\//);
    expect(finalStage).toMatch(/COPY scripts\/lib\/linear-source\.mjs \.\/scripts\/lib\//);
  });

  it('ships every file the importer imports (server, shared and the three scripts), as the image copies them', () => {
    const shipped = (file: string) => IMPORTER_FILES.includes(file) || file.startsWith('server/') || file.startsWith('shared/');
    const seen = new Set<string>();
    const queue = [...IMPORTER_FILES];
    while (queue.length) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      expect(shipped(file), `${file} is not copied into the image`).toBe(true);
      if (file.endsWith('.mjs') || file.endsWith('.ts')) queue.push(...localImports(file));
    }
  });

  it('starts and prints its usage from only the files the image copies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'importer-image-'));
    try {
      fs.cpSync(path.join(root, 'server'), path.join(dir, 'server'), { recursive: true });
      fs.cpSync(path.join(root, 'shared'), path.join(dir, 'shared'), { recursive: true });
      for (const file of IMPORTER_FILES) {
        fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
        fs.copyFileSync(path.join(root, file), path.join(dir, file));
      }
      fs.writeFileSync(path.join(dir, 'package.json'), fs.readFileSync(path.join(root, 'package.json')));
      // The image installs the production dependencies (npm ci --omit=dev); the repo's node_modules stands in for them.
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const env = { PATH: process.env.PATH ?? '', HOME: dir };
      const out = execFileSync(process.execPath, ['scripts/linear-import.mjs', '--help'], { cwd: dir, env, encoding: 'utf8' });
      expect(out).toMatch(/linear-import/);
      expect(out).toMatch(/dry-run/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
