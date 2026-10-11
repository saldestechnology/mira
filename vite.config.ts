import { configDefaults, defineConfig } from 'vitest/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import docs from './scripts/vite-docs.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEMO_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://api.fontshare.com/v2/css; font-src https://cdn.fontshare.com; img-src 'self' data: blob:; connect-src 'self' https://api.fontshare.com/v2/css https://cdn.fontshare.com/; base-uri 'self'; form-action 'none'";

function demoBuildPlugin() {
  let outDir = '';
  let base = '/demo/';
  return {
    name: 'tabula-demo-build',
    apply: (_config: unknown, env: { mode: string }) => env.mode === 'demo',
    configResolved(config: { root: string; base: string; build: { outDir: string } }) {
      outDir = path.resolve(config.root, config.build.outDir);
      base = config.base;
    },
    transformIndexHtml(html: string) {
      return html
        .replace(/\s*<link\b[^>]*rel=["']manifest["'][^>]*>/i, '')
        .replace(/href=["']\/favicon\.svg["']/i, `href="${base}favicon.svg"`)
        .replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${DEMO_CSP}">`);
    },
    writeBundle() {
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'public', 'favicon.svg'), path.join(outDir, 'favicon.svg'));
    },
  };
}

/** The restore drill's test files, which only `npm run drill:local` runs. */
export const DRILL_PATTERN = '**/*.drill.test.ts';

const docsPages = {
  ...docs(),
  apply: (_config: any, env: { mode: string }) => env.mode !== 'demo',
};

const demoConfigPlugin = {
  name: 'tabula-demo-config',
  config(_config: unknown, env: { mode: string }) {
    if (env.mode === 'test') return undefined;
    if (env.mode !== 'demo') return { define: { 'import.meta.env.VITE_DEMO': 'undefined' } };
    return {
      publicDir: false,
      define: { 'import.meta.env.VITE_DEMO': '"1"' },
      build: { sourcemap: false, rolldownOptions: { output: { codeSplitting: false } } },
    };
  },
};

// In dev, PORT selects the relay and VITE_PORT selects Vite; both keep their documented defaults.
const relayPort = Number(process.env.PORT) || 8787;
const vitePort = Number(process.env.VITE_PORT) || 5173;

// Vite proxies sync and API requests to the selected relay port.
export default defineConfig({
  plugins: [docsPages, demoConfigPlugin, demoBuildPlugin()],
  // Tracker and board deep links are HTML5 paths and must reach the SPA entry in development too.
  appType: 'spa',
  server: {
    port: vitePort,
    strictPort: true,
    proxy: {
      '/sync': { target: `ws://localhost:${relayPort}`, ws: true },
      '/chat': { target: `ws://localhost:${relayPort}`, ws: true },
      '/api': { target: `http://localhost:${relayPort}` },
      '/icons': { target: `http://localhost:${relayPort}` },
    },
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    // agent worktrees live under .claude/worktrees; never collect their tests. The restore drill (test/drill,
    // `npm run drill:local`, vitest.drill.config.ts) is not part of `npm test` or CI: test/drill-config.test.ts checks it.
    exclude: [...configDefaults.exclude, '.claude/**', DRILL_PATTERN],
    // Many test files spawn a relay process each. On the small CI runners (Windows and macOS above all) running
    // them all at once starves the machine and unrelated tests time out, so CI runs two files at a time and every
    // test and hook gets room to wait for a relay. Both limits stay well above RELAY_START_MS (test/relay-timing.ts), so
    // a slow start ends in the helper's error, which carries the relay's output, and not in a bare timeout.
    maxWorkers: process.env.CI ? 2 : undefined,
    // every test file's fetch avoids reused idle sockets and retries one reset GET visibly (test/http-retry.ts)
    setupFiles: ['./test/setup-http.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
