// Visual and accessibility checks for the new tracker link dialog and linked-card SVG helpers.
// This companion runner keeps the existing visual-check states and seed board untouched.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = process.env.TABULA_TRACKER_VISUAL_OUT || path.join(os.tmpdir(), 'tabula-tracker-link-visuals');
const baseWidths = [360, 390, 1280];
const themes = ['default', 'ayu', 'kanagawa', 'matrix', 'evergreen'];
const cases = [
  { state: 'link-dialog-lanes' },
  { state: 'link-dialog-review' },
  { state: 'link-dialog-error', error: 'offline', id: 'link-dialog-error-offline' },
  { state: 'link-dialog-error', error: 'server', id: 'link-dialog-error-server' },
  { state: 'unlink-confirm' },
  { state: 'linked-card-chips' },
];
const stateFilter = process.env.TABULA_TRACKER_VISUAL_STATES?.split(',').filter(Boolean);
const themeFilter = process.env.TABULA_TRACKER_VISUAL_THEMES?.split(',').filter(Boolean);
const widthFilter = process.env.TABULA_TRACKER_VISUAL_WIDTHS?.split(',').map(Number).filter(Number.isFinite);
const browserFilter = process.env.TABULA_TRACKER_VISUAL_BROWSERS?.split(',').filter(Boolean);
const selectedCases = stateFilter ? cases.filter((item) => stateFilter.includes(item.id ?? item.state)) : cases;
if (!selectedCases.length) throw new Error('No visual states match TABULA_TRACKER_VISUAL_STATES.');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not find an open port for Vite.')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(url, child) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (child.exitCode !== null) throw new Error(`Vite exited before becoming ready (code ${child.exitCode}).`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* keep polling until Vite serves the gallery */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Vite did not serve the tracker gallery within 20 seconds.');
}

async function auditPage(page, { state, width, engine }) {
  const result = await page.evaluate(({ stateName, viewportWidth }) => {
    const failures = [];
    const rgb = (value) => {
      const srgb = value.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/i);
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] === undefined ? 1 : Number(srgb[4]) };
      const numbers = value.match(/-?\d*\.?\d+/g)?.map(Number);
      if (!numbers || numbers.length < 3) return null;
      return { r: numbers[0], g: numbers[1], b: numbers[2], a: numbers.length > 3 ? numbers[3] : 1 };
    };
    const over = (top, bottom) => {
      const a = top.a + bottom.a * (1 - top.a);
      if (!a) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
        a,
      };
    };
    const background = (element) => {
      const chain = [];
      for (let node = element; node && node instanceof Element; node = node.parentElement) chain.push(node);
      let color = { r: 255, g: 255, b: 255, a: 1 };
      for (const node of chain.reverse()) {
        const layer = rgb(getComputedStyle(node).backgroundColor);
        if (layer && layer.a > 0) color = over(layer, color);
      }
      return color;
    };
    const luminance = (color) => {
      const channel = (value) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
    };
    const contrast = (one, two) => {
      const a = luminance(one), b = luminance(two);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const opacity = (element) => {
      let alpha = 1;
      for (let node = element; node && node instanceof Element; node = node.parentElement) alpha *= Number(getComputedStyle(node).opacity || '1');
      return alpha;
    };
    const visible = (element) => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const short = (element) => (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);

    if (document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1) {
      failures.push(`horizontal overflow: document ${document.documentElement.scrollWidth}, body ${document.body.scrollWidth}, viewport ${innerWidth}`);
    }

    const directText = [...document.querySelectorAll('body *')].filter((element) =>
      visible(element) && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim()),
    );
    for (const element of directText) {
      const style = getComputedStyle(element);
      const foreground = rgb(element instanceof SVGTextElement ? style.fill : style.color);
      const backdrop = background(element);
      if (foreground) {
        const effective = over({ ...foreground, a: foreground.a * opacity(element) }, backdrop);
        const ratio = contrast(effective, backdrop);
        if (ratio < 4.5) failures.push(`text contrast ${ratio.toFixed(2)}:1 for “${short(element)}”`);
      }
      const box = element.getBoundingClientRect();
      const clips = style.overflowX === 'hidden' || style.overflowX === 'clip' || style.textOverflow === 'ellipsis';
      if (clips && element.scrollWidth > element.clientWidth + 1) failures.push(`clipped text “${short(element)}”`);
      if (box.width > 0 && element.scrollWidth > element.clientWidth + 2 && clips) failures.push(`text extends past “${short(element)}”`);
    }

    const borderControls = [...document.querySelectorAll('button, input, select, textarea')].filter(visible);
    for (const element of borderControls) {
      const style = getComputedStyle(element);
      if (parseFloat(style.borderTopWidth) < 1 || style.borderTopStyle === 'none') continue;
      const edge = rgb(style.borderTopColor);
      if (!edge || edge.a === 0) continue;
      const backdrop = background(element.parentElement || element);
      const ratio = contrast(over(edge, backdrop), backdrop);
      if (ratio < 3) failures.push(`control border contrast ${ratio.toFixed(2)}:1 on ${element.tagName.toLowerCase()} “${short(element)}”`);
    }

    for (const shape of document.querySelectorAll('svg path, svg circle, svg rect, svg line')) {
      if (!visible(shape)) continue;
      const style = getComputedStyle(shape);
      if (shape.tagName.toLowerCase() === 'rect' && !shape.getAttribute('class')) continue;
      const backdrop = background(shape);
      for (const paint of [style.fill, style.stroke]) {
        if (!paint || paint === 'none') continue;
        const foreground = rgb(paint);
        if (!foreground || foreground.a === 0) continue;
        const ratio = contrast(over(foreground, backdrop), backdrop);
        if (ratio < 3) failures.push(`SVG contrast ${ratio.toFixed(2)}:1 on ${shape.tagName.toLowerCase()}.${shape.getAttribute('class') || ''} (${paint} on ${Math.round(backdrop.r)},${Math.round(backdrop.g)},${Math.round(backdrop.b)})`);
      }
    }

    const targetElements = [...document.querySelectorAll('button, [role="option"], .trk-link-create-label')].filter(visible);
    if (viewportWidth <= 390) for (const element of targetElements) {
      const box = element.getBoundingClientRect();
      if (box.height < 44 || (element.matches('button, [role="option"]') && box.width < 44)) {
        failures.push(`touch target ${Math.round(box.width)}×${Math.round(box.height)} for “${short(element)}”`);
      }
    }

    const dialog = document.querySelector('.trk-link-modal, .trk-unlink-back .modal');
    if (dialog) {
      const box = dialog.getBoundingClientRect();
      if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) failures.push('dialog is outside the viewport');
      if (stateName.startsWith('link-dialog-') && viewportWidth < 600 && (Math.abs(box.left) > 1 || Math.abs(box.right - innerWidth) > 1 || Math.abs(box.bottom - innerHeight) > 1)) {
        failures.push('phone link dialog is not a full-width bottom sheet');
      }
    }
    const popover = document.querySelector('.trk.trk-pop');
    if (popover) {
      const box = popover.getBoundingClientRect();
      if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) failures.push('state picker is outside the viewport');
    }

    if (stateName !== 'linked-card-chips') {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) failures.push(`dialog has no initial focused control (active ${(active instanceof HTMLElement ? `${active.tagName.toLowerCase()}.${active.className}` : 'unknown')})`);
      else {
        const style = getComputedStyle(active);
        const width = parseFloat(style.outlineWidth);
        const ring = rgb(style.outlineColor);
        if (width < 2 || style.outlineStyle === 'none' || !ring || contrast(ring, background(active.parentElement || active)) < 3) {
          failures.push(`focus ring is not visible on “${short(active)}”`);
        }
      }
    }
    return { failures, textCount: directText.length, targetCount: targetElements.length, viewport: `${innerWidth}×${innerHeight}` };
  }, { stateName: state.id ?? state.state, viewportWidth: width });
  if (result.failures.length) throw new Error(`${engine} ${state.id ?? state.state} ${width}px: ${result.failures.join('; ')}`);
  return result;
}

async function runConfiguration(browser, engineName, testCase, theme, width) {
  const page = await browser.newPage({ viewport: { width, height: width <= 500 ? 844 : 800 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const query = new URLSearchParams({ state: testCase.state, theme });
  if (testCase.error) query.set('error', testCase.error);
  const route = `http://127.0.0.1:${serverPort}/scripts/tracker-link-gallery.html?${query.toString()}`;
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__trackerLinkGalleryReady === true, null, { timeout: 15_000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    if (testCase.state === 'link-dialog-lanes') {
      await page.locator('.trk-picker-list').waitFor({ timeout: 5000 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const audit = await auditPage(page, { state: testCase, width, engine: engineName });
    const folder = path.join(outputRoot, engineName);
    fs.mkdirSync(folder, { recursive: true });
    const suffix = `${testCase.id ?? testCase.state}-${theme}-${width}`;
    await page.screenshot({ path: path.join(folder, `${suffix}.png`), fullPage: true });
    if (pageErrors.length) throw new Error(`${engineName} ${suffix}: browser errors: ${pageErrors.join(' | ')}`);
    return { engine: engineName, state: testCase.id ?? testCase.state, theme, width, ...audit };
  } finally {
    await page.close();
  }
}

let serverPort;
let vite;
let viteOutput = '';
const summaries = [];
try {
  fs.mkdirSync(outputRoot, { recursive: true });
  serverPort = await freePort();
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(serverPort), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vite.stdout.on('data', (chunk) => { viteOutput += chunk.toString(); });
  vite.stderr.on('data', (chunk) => { viteOutput += chunk.toString(); });
  await waitForServer(`http://127.0.0.1:${serverPort}/scripts/tracker-link-gallery.html`, vite);

  const allEnginePlans = [
    { name: 'chromium', type: chromium, fullThemes: true },
    { name: 'webkit', type: webkit, fullThemes: false },
    { name: 'firefox', type: firefox, fullThemes: false },
  ];
  const enginePlans = browserFilter ? allEnginePlans.filter((item) => browserFilter.includes(item.name)) : allEnginePlans;
  for (const enginePlan of enginePlans) {
    const browser = await enginePlan.type.launch({ headless: true });
    try {
      for (const testCase of selectedCases) {
        const allowedThemes = enginePlan.fullThemes ? themes : ['default'];
        const selectedThemes = themeFilter ? allowedThemes.filter((theme) => themeFilter.includes(theme)) : allowedThemes;
        for (const theme of selectedThemes) {
          const allowedWidths = theme === 'default' ? baseWidths : [390, 1280];
          const widths = widthFilter ? allowedWidths.filter((width) => widthFilter.includes(width)) : allowedWidths;
          for (const width of widths) {
            summaries.push(await runConfiguration(browser, enginePlan.name, testCase, theme, width));
            process.stdout.write(`pass ${enginePlan.name} ${testCase.id ?? testCase.state} ${theme} ${width}px\n`);
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  fs.writeFileSync(path.join(outputRoot, 'results.json'), `${JSON.stringify(summaries, null, 2)}\n`);
  process.stdout.write(`Visual checks passed: ${summaries.length} configurations. Screenshots: ${outputRoot}\n`);
} catch (error) {
  if (vite) {
    vite.kill('SIGTERM');
    await new Promise((resolve) => vite.once('exit', resolve));
  }
  if (vite && error instanceof Error) error.message += `\nVite output:\n${viteOutput}`;
  throw error;
} finally {
  if (vite && vite.exitCode === null) {
    vite.kill('SIGTERM');
    await new Promise((resolve) => vite.once('exit', resolve));
  }
}
