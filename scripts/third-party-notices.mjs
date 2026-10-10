#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSet } from './lib/icons-build.mjs';
import { EXCLUDED_CATEGORY, EXCLUDED_SETS } from './build-icons.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outputPath = path.join(root, 'docs', 'third-party-notices.md');
const licenseFileName = /^(?:licen[cs]e|copying|notice|copyright|unlicense|patents)(?:$|[._ -].*)/i;
const licenseMetadataExtensions = new Set(['.json', '.spdx', '.toml', '.yaml', '.yml']);
const upstreamLicenseFiles = new Map([
  ['standardwebhooks@1.1.1', {
    name: 'LICENSE (upstream libraries/LICENSE at b4d2c14fc5b4ccff3ff271e3b087dff812254c59)',
    text: `The MIT License

Copyright (c) 2023 Svix (https://www.svix.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`,
  }],
]);
const npmName = (entry) => {
  if (entry.name) return entry.name;
  const installPath = entry.installPath.startsWith('node_modules/') ? entry.installPath.slice('node_modules/'.length) : entry.installPath;
  const packagePath = installPath.split('/node_modules/').at(-1).split('/');
  return packagePath[0].startsWith('@') ? `${packagePath[0]}/${packagePath[1]}` : packagePath[0];
};
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function resolveLockedPackage(packages, parentPath, name) {
  let parent = parentPath;
  while (parent) {
    const candidate = `${parent}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const nestedAt = parent.lastIndexOf('/node_modules/');
    if (nestedAt >= 0) parent = parent.slice(0, nestedAt);
    else if (parent.startsWith('node_modules/')) parent = '';
    else break;
  }
  const rootCandidate = `node_modules/${name}`;
  return packages[rootCandidate] ? rootCandidate : null;
}

function packageEdges(entry) {
  const edges = new Set([
    ...Object.keys(entry.dependencies || {}),
    ...Object.keys(entry.optionalDependencies || {}),
    ...Object.keys(entry.peerDependencies || {}),
  ]);
  return [...edges].sort();
}

/** The production closure of a v3 npm lockfile; dev-only packages and unresolved peers are excluded. */
export function collectNpmRuntimePackages(lock) {
  const packages = lock?.packages;
  if (!packages || !packages['']) throw new Error('Expected an npm package-lock v3 file with packages[""]');

  const rootEntry = packages[''];
  const queue = [
    ...Object.keys(rootEntry.dependencies || {}),
    ...Object.keys(rootEntry.optionalDependencies || {}),
  ].map((name) => `node_modules/${name}`);
  const visited = new Set();

  while (queue.length) {
    const installPath = queue.pop();
    const entry = packages[installPath];
    if (!entry || visited.has(installPath)) continue;
    visited.add(installPath);
    for (const dependency of packageEdges(entry)) {
      const resolved = resolveLockedPackage(packages, installPath, dependency);
      if (resolved) queue.push(resolved);
    }
  }

  return [...visited]
    .map((installPath) => ({ installPath, ...packages[installPath], name: npmName({ ...packages[installPath], installPath }) }))
    .sort((a, b) => compareText(npmName(a), npmName(b)) || compareText(a.version, b.version) || compareText(a.installPath, b.installPath));
}

/** Runtime edges include target-specific normal dependencies, but not build or dev dependencies. */
export function collectCargoRuntimePackages(metadata) {
  const packageById = new Map((metadata?.packages || []).map((pkg) => [pkg.id, pkg]));
  const nodeById = new Map((metadata?.resolve?.nodes || []).map((node) => [node.id, node]));
  const rootId = metadata?.resolve?.root || metadata?.workspace_members?.[0];
  if (!rootId || !packageById.has(rootId)) throw new Error('Cargo metadata did not identify the desktop workspace root');

  const isProcMacroOnly = (pkg) => {
    const kinds = (pkg?.targets || []).flatMap((target) => target.kind || []);
    return kinds.includes('proc-macro') && kinds.every((kind) => kind === 'proc-macro' || kind === 'custom-build');
  };

  const visited = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    if (id !== rootId && isProcMacroOnly(packageById.get(id))) continue;
    visited.add(id);
    for (const dependency of nodeById.get(id)?.deps || []) {
      if (dependency.dep_kinds?.some((kind) => kind.kind === null)) queue.push(dependency.pkg);
    }
  }

  return [...visited]
    .filter((id) => id !== rootId)
    .map((id) => packageById.get(id))
    .filter((pkg) => pkg?.source)
    .sort((a, b) => compareText(a.license || '', b.license || '') || compareText(a.name, b.name) || compareText(a.version, b.version));
}

/** The same filters as the all-sets icon build: one SPDX id, not hidden, not archived, and not explicitly excluded. */
/** @param {Record<string, object>} collections @param {{ prefix: string, info: object }[] | null} [availableSets] */
export function collectHostedIconSets(collections, availableSets = null) {
  const candidates = availableSets || Object.entries(collections || {}).map(([prefix, info]) => ({ prefix, info }));
  return candidates
    .filter(({ prefix, info }) => {
      if (EXCLUDED_SETS.includes(prefix)) return false;
      const listed = collections?.[prefix];
      if (listed && (!checkSet(listed).ok || listed.category === EXCLUDED_CATEGORY)) return false;
      return info?.category !== EXCLUDED_CATEGORY && checkSet(info).ok;
    })
    .map(({ prefix, info }) => ({ prefix, ...info }))
    .sort((a, b) => compareText(a.name || a.prefix, b.name || b.prefix) || compareText(a.prefix, b.prefix));
}

function licenseTextNames(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && licenseFileName.test(entry.name) && !licenseMetadataExtensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Returns package license files, including an explicit Cargo license_file and pinned upstream fallback texts. */
export function packageLicenseFiles(directory, declaredLicenseFile = null) {
  const files = new Set(licenseTextNames(directory));
  if (declaredLicenseFile) {
    const declared = path.resolve(directory, declaredLicenseFile);
    if (fs.existsSync(declared) && fs.statSync(declared).isFile()) files.add(path.relative(directory, declared));
  }
  return [...files].sort().map((name) => ({ name, text: fs.readFileSync(path.join(directory, name), 'utf8').replaceAll('\r\n', '\n').trimEnd() + '\n' }));
}

/** Include a pinned upstream license when the installed npm archive omits its text file. */
export function packageLicenseFilesFor(entry, directory) {
  const files = packageLicenseFiles(directory, entry.license_file);
  const upstream = upstreamLicenseFiles.get(`${entry.name}@${entry.version}`);
  if (upstream && !files.some(({ name }) => licenseFileName.test(name))) files.push(upstream);
  return files;
}

function cargoMetadata(rootPath) {
  const result = spawnSync('cargo', [
    'metadata', '--manifest-path', path.join(rootPath, 'desktop', 'src-tauri', 'Cargo.toml'),
    '--locked', '--format-version', '1',
  ], { cwd: rootPath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || `cargo exited ${result.status}`;
    throw new Error(`Could not read the locked Cargo runtime graph: ${detail}`);
  }
  return JSON.parse(result.stdout);
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].sort(([a], [b]) => compareText(a, b));
}

function markdownCell(value) {
  return String(value || '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function code(value) {
  return `\`${String(value).replaceAll('`', '\\`')}\``;
}

function sourceRepository(packageJson) {
  const repository = typeof packageJson?.repository === 'string' ? packageJson.repository : packageJson?.repository?.url;
  if (!repository) return '';
  return repository.replace(/^git\+/, '').replace(/\.git$/, '');
}

function packageRows(entries, rootPath, directoryFor) {
  return entries.map((entry) => {
    const directory = directoryFor(entry, rootPath);
    const files = packageLicenseFilesFor(entry, directory);
    const packageJsonPath = path.join(directory, 'package.json');
    let packageJson = null;
    try { packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')); } catch { /* Cargo crates do not use package.json. */ }
    return { entry, directory, files, repository: sourceRepository(packageJson) || entry.repository || '' };
  });
}

function renderPackageList(rows, nameFor, versionFor, locationFor = null) {
  const lines = [
    `| Package | Version | Declared licence expression | Packaged notice files${locationFor ? ' | Install path' : ''} |`,
    `| --- | --- | --- | ---${locationFor ? ' | ---' : ''} |`,
  ];
  for (const { entry, files, repository } of rows) {
    const name = nameFor(entry);
    const version = versionFor(entry);
    const license = entry.license || '(missing from metadata)';
    const noticeFiles = files.length ? files.map((file) => code(file.name)).join(', ') : `No text file in package archive${repository ? ` ([upstream source](${repository}))` : ''}`;
    const location = locationFor ? ` | ${code(locationFor(entry))}` : '';
    lines.push(`| ${code(name)} | ${code(version)} | ${code(license)} | ${noticeFiles}${location} |`);
  }
  return lines.join('\n');
}

function renderLicenseTexts(rows) {
  const texts = new Map();
  for (const { entry, files } of rows) {
    for (const file of files) {
      const digest = crypto.createHash('sha256').update(file.text).digest('hex');
      if (!texts.has(digest)) texts.set(digest, { text: file.text, sources: [] });
      const packageName = entry.installPath ? npmName(entry) : entry.name;
      texts.get(digest).sources.push(`${packageName || 'package'}@${entry.version} (${file.name})`);
    }
  }
  if (!texts.size) return '_No license or notice text was present in the source archives._';

  return [...texts.values()]
    .sort((a, b) => compareText(a.sources[0], b.sources[0]))
    .map(({ text, sources }) => {
      const longestFence = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
      const fence = '`'.repeat(longestFence + 1);
      return `#### Source files\n\n${sources.sort().map((source) => `- ${code(source)}`).join('\n')}\n\n${fence}text\n${text.trimEnd()}\n${fence}`;
    }).join('\n\n');
}

function renderNpm(rows) {
  const sections = ['## npm runtime dependencies', '',
    'The list follows `dependencies` and `optionalDependencies` from the root of `package-lock.json`, plus peer dependencies resolved to lockfile entries. This includes optional peers present in the production install, such as `zod`; development-only packages and unresolved peers are excluded. Nested install paths remain distinct in the generated data; package names and versions are shown below.', '',
    renderPackageList(rows, npmName, (entry) => entry.version, (entry) => entry.installPath), '',
    '### Packaged npm licence and notice text', '',
    renderLicenseTexts(rows), ''];
  return sections.join('\n');
}

function renderCargo(rows) {
  const mplCrates = rows
    .filter(({ entry }) => entry.license === 'MPL-2.0')
    .map(({ entry }) => `${entry.name}@${entry.version}`)
    .sort(compareText);
  const lines = [
    '## Tauri / Cargo runtime dependencies', '',
    'This inventory follows normal (`kind = null`) dependency edges from the `tabula-desktop` Cargo metadata root across all target-specific edges. Build and development dependencies and proc-macro-only crates (including their compile-time dependency subtrees) are excluded. Groups use each crate’s exact `Cargo.toml` licence expression; no expression is simplified or treated as legal advice.', '',
  ];
  if (mplCrates.length) {
    lines.push(`The following MPL-2.0 crates are unmodified and their source is available from crates.io at the listed versions: ${mplCrates.map(code).join(', ')}.`, '');
  }

  for (const [license, packages] of groupBy(rows, (row) => row.entry.license || '(missing from Cargo metadata)')) {
    lines.push(`### ${code(license)} (${packages.length})`, '');
    const names = packages.map(({ entry }) => `${entry.name}@${entry.version}`);
    for (let index = 0; index < names.length; index += 8) {
      lines.push(names.slice(index, index + 8).map(code).join(', '));
    }
    lines.push('');
    const missing = packages.filter((pkg) => pkg.files.length === 0);
    if (missing.length) {
      lines.push('Crate archives without a packaged licence or notice file:', '');
      for (const { entry, repository } of missing) {
        const registry = `https://crates.io/crates/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`;
        const upstream = repository ? ` ([upstream](${repository}))` : '';
        lines.push(`- ${code(`${entry.name}@${entry.version}`)} — [crates.io archive](${registry})${upstream}`);
      }
      lines.push('');
    }
    const texts = renderLicenseTexts(packages);
    lines.push('<details>', `<summary>Packaged license and notice text (${packages.reduce((count, row) => count + row.files.length, 0)} files)</summary>`, '', texts, '', '</details>', '');
  }
  return lines.join('\n');
}

function renderIcons(sets, version) {
  const rows = [
    '## Icon sets and attribution', '',
    `Tabula’s icon build input is <code>@iconify/json ${version}</code> (MIT; build-only). The default all-sets build applies the same allowlist, hidden-set check, archive exclusion, and explicit exclusions as <code>scripts/build-icons.mjs</code>. Candidate set files are enumerated from <code>json/*.json</code>; <code>collections.json</code> is used as an early filter when it has a record, and each candidate’s own <code>info</code> record is authoritative.`, '',
    'For Creative Commons Attribution sets, credit the named author, link the licence, and state that Tabula repackages the JSON into its own icon index and shards; alias transforms may be materialized for rendering. The icon drawings are not otherwise edited. Logo sets remain trademarks of their owners.', '',
    '| Set | Prefix | Author | Licence |',
    '| --- | --- | --- | --- |',
  ];
  for (const set of sets) {
    const author = set.author?.name ? `${markdownCell(set.author.name)}${set.author.url ? ` ([source](${set.author.url}))` : ''}` : 'Not named in set metadata';
    const license = set.license?.spdx || '(missing)';
    const linkedLicense = set.license?.url ? `[${license}](${set.license.url})` : code(license);
    const logo = set.category === 'Logos' || set.prefix.startsWith('devicon') ? ' (trademark set)' : '';
    rows.push(`| ${markdownCell(set.name || set.prefix)}${logo} | ${code(set.prefix)} | ${author} | ${linkedLicense} |`);
  }
  rows.push('', `Total hosted sets from the ${code(version)} source: ${sets.length}.`);
  return rows.join('\n');
}

function renderFontsAndAssets() {
  return [
    '## Fonts, art, and project icons', '',
    '### Fonts', '',
    '- The app loads Fontshare CSS and font files remotely. The standard families are Switzer, Cabinet Grotesk, and Satoshi; the font picker can load additional Fontshare families. Fontshare’s FFL 2.0 selectable-font terms are **UNDER REVIEW** for this editor use. See [`docs/dependency-audit.md`](dependency-audit.md) for the source review. No Fontshare font binaries are checked into this repository.',
    '- The brand guide references Bodoni Moda and Instrument Sans under SIL Open Font License 1.1. Bodoni Moda outlines also appear in the reserved Tabula wordmark and monogram marks. No source font binaries are included with those outlines; see [`docs/brand.md`](brand.md).', '',
    '### Brand art', '',
    'The `cutouts/`, `marks/`, `paper/`, `tape/`, and `board/` folders in `design/brand/assets/` are Tabula-created art under CC BY 4.0. Required credit: **“Art by Tabula, CC BY 4.0”**, with a link to [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The name, wordmark, and monograms are reserved and are not licensed under CC BY. `torn-edges.svg` and `torn-edges.css` are project code under AGPL-3.0-only. See [`design/brand/assets/LICENSE.md`](../design/brand/assets/LICENSE.md).', '',
    '### Favicon and Tauri icons', '',
    'The project-owned `public/favicon.svg` and `desktop/src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.png,icon.icns,icon.ico}` are part of Tabula and licensed as AGPL-3.0-only. The favicon is a hand-written SVG; the Tauri icons are generated from it. Their provenance is recorded in [`docs/brand.md`](brand.md#provenance-of-the-app-icons) at commit `b8f11e6` on `docs/brand-icon-provenance`. That provenance commit is not an ancestor of the base revision for this task; retain it when integrating this notice.', '',
    'The web, root, and Tauri artifact copy step for this document is a separate release integration task.',
  ].join('\n');
}

export function renderNotices({ npmRows, cargoRows, iconifyRows = [], iconSets, iconifyVersion, generatedFrom = 'package-lock.json, Cargo metadata, and @iconify/json collections' }) {
  const sections = [
    '# Third-party notices', '',
    `Generated by \`node scripts/third-party-notices.mjs\` from ${generatedFrom}; do not edit by hand. Run with \`--check\` to verify the document is current. The application’s own licence is AGPL-3.0-only.`, '',
    'If an upstream archive contains a licence or notice file, its text is included below. Where a source archive omits that text, this document preserves the declared SPDX expression and points to upstream metadata rather than inventing a copyright notice. Cargo crate source paths and the `@iconify/json` package are used as local inputs and are not serialized into the document.', '',
    renderNpm(npmRows),
    '### Build-time icon source package', '',
    `\`@iconify/json ${iconifyVersion}\` is a pinned build-time devDependency, not part of the runtime npm closure. Its package-level licence is MIT; the icon artwork remains subject to the individual set licences in the table below.`, '',
    renderPackageList(iconifyRows, npmName, (entry) => entry.version, (entry) => entry.installPath), '',
    renderLicenseTexts(iconifyRows), '',
    renderCargo(cargoRows),
    renderIcons(iconSets, iconifyVersion),
    renderFontsAndAssets(), '',
    '## Release integration', '',
    'The generated notices live in `docs/`. Copying the consolidated document into the root, web, and Tauri release artifacts remains a follow-up owned by the release integration task.', '',
  ];
  return sections.join('\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function generateNotices(rootPath = root) {
  const lock = readJson(path.join(rootPath, 'package-lock.json'));
  const npmEntries = collectNpmRuntimePackages(lock);
  const npmRows = packageRows(npmEntries, rootPath, (entry, base) => path.resolve(base, entry.installPath));
  const cargoEntries = collectCargoRuntimePackages(cargoMetadata(rootPath));
  const cargoRows = packageRows(cargoEntries, rootPath, (entry) => path.dirname(entry.manifest_path));

  const iconifyDirectory = path.join(rootPath, 'node_modules', '@iconify', 'json');
  const iconifyPackage = readJson(path.join(iconifyDirectory, 'package.json'));
  let iconCollections = {};
  try { iconCollections = readJson(path.join(iconifyDirectory, 'collections.json')); } catch { /* the set files are authoritative */ }
  const iconJsonDirectory = path.join(iconifyDirectory, 'json');
  const availableIconSets = fs.readdirSync(iconJsonDirectory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .filter((prefix) => !EXCLUDED_SETS.includes(prefix))
    .sort()
    .flatMap((prefix) => {
      const listed = iconCollections[prefix];
      if (listed && (!checkSet(listed).ok || listed.category === EXCLUDED_CATEGORY)) return [];
      const data = readJson(path.join(iconJsonDirectory, `${prefix}.json`));
      return [{ prefix, info: data.info }];
    });
  const iconSets = collectHostedIconSets(iconCollections, availableIconSets);
  const iconifyEntry = {
    name: '@iconify/json', version: iconifyPackage.version, license: iconifyPackage.license,
    installPath: 'node_modules/@iconify/json',
  };
  const iconifyRows = packageRows([iconifyEntry], rootPath, (entry, base) => path.resolve(base, entry.installPath));
  const document = renderNotices({ npmRows, cargoRows, iconifyRows, iconSets, iconifyVersion: iconifyPackage.version });
  return { document, iconSetCount: iconSets.length, cargoCount: cargoRows.length, npmCount: npmRows.length };
}

function main() {
  const { document, iconSetCount, cargoCount, npmCount } = generateNotices();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
    if (current !== document) {
      process.stderr.write('Third-party notices are out of date; run node scripts/third-party-notices.mjs to regenerate them.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Third-party notices are current (${npmCount} npm runtime packages, ${cargoCount} Cargo runtime crates, ${iconSetCount} icon sets).\n`);
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, document);
  process.stdout.write(`Wrote docs/third-party-notices.md (${npmCount} npm runtime packages, ${cargoCount} Cargo runtime crates, ${iconSetCount} icon sets).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
