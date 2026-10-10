import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCargoRuntimePackages, collectHostedIconSets, collectNpmRuntimePackages, packageLicenseFiles, renderNotices } from '../scripts/third-party-notices.mjs';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('third-party notices inventory', () => {
  it('follows runtime npm edges and excludes dev-only and optional-peer-only packages', () => {
    const lock = {
      packages: {
        '': { dependencies: { app: '1.0.0' }, devDependencies: { tooling: '1.0.0' } },
        'node_modules/app': {
          name: 'app', version: '1.0.0', license: 'MIT',
          dependencies: { nested: '1.0.0' }, peerDependencies: { optional: '*', required: '*' },
          peerDependenciesMeta: { optional: { optional: true } },
        },
        'node_modules/app/node_modules/nested': { name: 'nested', version: '1.0.0', license: 'ISC' },
        'node_modules/optional': { name: 'optional', version: '1.0.0', license: 'MIT' },
        'node_modules/required': { name: 'required', version: '1.0.0', license: 'BSD-3-Clause' },
        'node_modules/tooling': { name: 'tooling', version: '1.0.0', license: 'MIT' },
      },
    } as const;

    const packages = collectNpmRuntimePackages(lock as never);
    expect(packages.map((pkg) => pkg.name)).toEqual(['app', 'nested', 'required']);
    expect(packages.find((pkg) => pkg.name === 'nested')?.installPath).toBe('node_modules/app/node_modules/nested');
  });

  it('retains duplicate npm versions at their distinct lockfile paths', () => {
    const lock = {
      packages: {
        '': { dependencies: { first: '*', second: '*' } },
        'node_modules/first': { name: 'first', version: '1.0.0', license: 'MIT', dependencies: { shared: '*' } },
        'node_modules/second': { name: 'second', version: '1.0.0', license: 'MIT', dependencies: { shared: '*' } },
        'node_modules/first/node_modules/shared': { name: 'shared', version: '1.0.0', license: 'MIT' },
        'node_modules/shared': { name: 'shared', version: '2.0.0', license: 'MIT' },
      },
    } as const;

    const shared = collectNpmRuntimePackages(lock as never).filter((pkg) => pkg.name === 'shared');
    expect(shared.map((pkg) => `${pkg.version}:${pkg.installPath}`)).toEqual([
      '1.0.0:node_modules/first/node_modules/shared',
      '2.0.0:node_modules/shared',
    ]);
  });

  it('derives scoped package names from npm v3 install paths', () => {
    const lock = {
      packages: {
        '': { dependencies: { '@scope/lib': '*' } },
        'node_modules/@scope/lib': { version: '1.0.0', license: 'MIT' },
      },
    } as const;

    expect(collectNpmRuntimePackages(lock as never).map((pkg) => pkg.name)).toEqual(['@scope/lib']);
  });

  it('follows target-specific Cargo runtime edges, excluding build and dev edges', () => {
    const metadata = {
      workspace_members: ['root'],
      packages: [
        { id: 'root', name: 'app', version: '1.0.0', source: null },
        { id: 'runtime', name: 'runtime', version: '1.0.0', source: 'registry', license: 'MIT' },
        { id: 'target', name: 'target', version: '2.0.0', source: 'registry', license: 'Unicode-3.0' },
        { id: 'build', name: 'build', version: '3.0.0', source: 'registry', license: 'MIT' },
        { id: 'dev', name: 'dev', version: '4.0.0', source: 'registry', license: 'MIT' },
      ],
      resolve: {
        root: 'root',
        nodes: [
          { id: 'root', deps: [
            { pkg: 'runtime', dep_kinds: [{ kind: null, target: null }] },
            { pkg: 'target', dep_kinds: [{ kind: null, target: 'cfg(target_os = "windows")' }] },
            { pkg: 'build', dep_kinds: [{ kind: 'build', target: null }] },
            { pkg: 'dev', dep_kinds: [{ kind: 'dev', target: null }] },
          ] },
          { id: 'runtime', deps: [{ pkg: 'target', dep_kinds: [{ kind: null, target: null }] }] },
        ],
      },
    };

    expect(collectCargoRuntimePackages(metadata).map((pkg) => pkg.name)).toEqual(['runtime', 'target']);
  });

  it('excludes proc-macro-only crates and their compile-time dependency subtrees', () => {
    const metadata = {
      workspace_members: ['root'],
      packages: [
        { id: 'root', name: 'app', version: '1.0.0', source: null },
        { id: 'runtime', name: 'runtime', version: '1.0.0', source: 'registry', license: 'MIT', targets: [{ kind: ['lib'] }] },
        { id: 'macro', name: 'macro', version: '1.0.0', source: 'registry', license: 'MIT', targets: [{ kind: ['proc-macro'] }] },
        { id: 'macro-dep', name: 'macro-dep', version: '1.0.0', source: 'registry', license: 'MIT', targets: [{ kind: ['lib'] }] },
        { id: 'runtime-dep', name: 'runtime-dep', version: '1.0.0', source: 'registry', license: 'MIT', targets: [{ kind: ['lib'] }] },
      ],
      resolve: {
        root: 'root',
        nodes: [
          { id: 'root', deps: [
            { pkg: 'runtime', dep_kinds: [{ kind: null, target: null }] },
            { pkg: 'macro', dep_kinds: [{ kind: null, target: null }] },
          ] },
          { id: 'runtime', deps: [{ pkg: 'runtime-dep', dep_kinds: [{ kind: null, target: null }] }] },
          { id: 'macro', deps: [{ pkg: 'macro-dep', dep_kinds: [{ kind: null, target: null }] }] },
        ],
      },
    };

    expect(collectCargoRuntimePackages(metadata).map((pkg) => pkg.name)).toEqual(['runtime', 'runtime-dep']);
  });

  it('uses the icon build allowlist and omits hidden, archived, excluded, and unlicensed sets', () => {
    const sets = collectHostedIconSets({
      credit: { name: 'Credit Set', category: 'General', license: { spdx: 'CC-BY-4.0' }, author: { name: 'Artist' } },
      hidden: { name: 'Hidden Set', hidden: true, license: { spdx: 'MIT' } },
      archived: { name: 'Archived Set', category: 'Archive / Unmaintained', license: { spdx: 'MIT' } },
      'fa6-solid': { name: 'Explicitly Excluded', license: { spdx: 'CC-BY-4.0' } },
      blocked: { name: 'Unlicensed Set', license: { spdx: 'CC-BY-SA-4.0' } },
    });

    expect(sets.map((set) => set.prefix)).toEqual(['credit']);
  });

  it('includes eligible set files missing from collections metadata and checks each file info record', () => {
    const sets = collectHostedIconSets({
      listed: { name: 'Listed', license: { spdx: 'MIT' } },
      blocked: { name: 'Blocked', hidden: true, license: { spdx: 'MIT' } },
    }, [
      { prefix: 'listed', info: { name: 'Listed File', license: { spdx: 'MIT' } } },
      { prefix: 'streamline-guidance', info: { name: 'Streamline Guidance', license: { spdx: 'CC-BY-4.0' } } },
      { prefix: 'blocked', info: { name: 'Blocked File', license: { spdx: 'MIT' } } },
      { prefix: 'unlicensed', info: { name: 'Unlicensed', license: { spdx: 'CC-BY-SA-4.0' } } },
    ]);

    expect(sets.map((set) => set.prefix)).toEqual(['listed', 'streamline-guidance']);
  });

  it('reads packaged license text while excluding SPDX metadata files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-notices-'));
    tempDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'LICENSE-MIT'), 'Copyright 2026 Example\r\n\r\nMIT text\r\n');
    fs.writeFileSync(path.join(directory, 'LICENSE.spdx'), 'SPDX-License-Identifier: MIT\n');
    fs.writeFileSync(path.join(directory, 'README.md'), 'Read me\n');

    expect(packageLicenseFiles(directory)).toEqual([{ name: 'LICENSE-MIT', text: 'Copyright 2026 Example\n\nMIT text\n' }]);
  });

  it('renders font review, CC BY credits, MPL, Unicode, and the release-copy follow-up', () => {
    const markdown = renderNotices({
      npmRows: [],
      cargoRows: [
        { entry: { name: 'selectors', version: '0.38.0', license: 'MPL-2.0' }, files: [] },
        { entry: { name: 'unicode-ident', version: '1.0.26', license: 'Unicode-3.0' }, files: [] },
      ],
      iconSets: [{ prefix: 'credit', name: 'Credit Set', license: { spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }, author: { name: 'Artist', url: 'https://example.test/artist' } }],
      iconifyVersion: '2.2.540',
    });

    expect(markdown).toContain('**UNDER REVIEW**');
    expect(markdown).toContain('CC-BY-4.0');
    expect(markdown).toContain('MPL-2.0');
    expect(markdown).toContain('Unicode-3.0');
    expect(markdown).toContain('separate release integration task');
  });
});
