import { defineConfig } from 'vitest/config';
import { transformWithOxc } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // Pin root to this file's own dir so `cwd` at invocation time (e.g. Stryker
  // running from the repo root instead of tests/) can't shift where relative
  // config paths like setupFiles resolve.
  root: __dirname,

  // Dashboard components use JSX in .js files. Next handles this in production,
  // while Vitest's Vite 8 import analysis needs an explicit test-only transform.
  // Test files get the same treatment so a component test can render with JSX.
  plugins: [
    {
      name: 'dashboard-jsx-test-transform',
      enforce: 'pre',
      async transform(code, id) {
        if (!id.endsWith('.js')) return null;
        const inSrc = id.startsWith(resolve(__dirname, '../src') + '/');
        const inTests = id.startsWith(__dirname) && !id.includes('/node_modules/');
        if (!inSrc && !inTests) return null;
        return transformWithOxc(code, id, { lang: 'jsx', jsx: { runtime: 'automatic' } });
      },
    },
  ],
  test: {
    // DATA_DIR ISOLATION. src/lib/dataDir.js:16 falls back to ~/.tokenproxy when
    // DATA_DIR is unset, so without this every DB-touching test wrote the LIVE
    // production database: fixture connection ids (ok, out, conn-1, kilo-2) landed
    // in quotaWindows and accountSwitches, and /api/admin/receipts reported them
    // as real model_failure switches. DATA_DIR is read at import time, so it must
    // be in the environment before any test module loads, which is what env does.
    env: { DATA_DIR: mkdtempSync(join(tmpdir(), 'tokenproxy-test-')) },

    // Node by default — most of the suite is handlers and translators. A test that
    // needs a DOM opts in per file with a `// @vitest-environment jsdom` docblock
    // on its first line (jsdom is pinned in tests/package.json).
    // Per-FILE data dir. env.DATA_DIR above is one path shared by every worker,
    // which let unrelated files write one data.sqlite concurrently; see the file
    // for why that made the failure set vary between identical runs.
    setupFiles: ['./setup-isolate-data-dir.js', './setup-real-io-guard.js'],
    environment: 'node',

    // TIMEOUTS. Vitest defaults to 5s per test and 10s per hook, and this suite
    // works right on top of both, which made the failure COUNT a function of how
    // busy the box was rather than of the tree. Measured over two full runs:
    // decision-log "the 73% line" passed at 4489ms in one and failed at 5004ms
    // in the other, and node-builtins-imports passed at 4576ms then failed at
    // 5003ms -- same tests, same tree, straddling the default. The render-heavy
    // cases sit in the same band: media-provider-key-mask and
    // providers-detail-ssr-2362 take 0.7-1.0s each when run alone and time out
    // just over 5000ms under a full-suite run. A timed-out case also poisons the
    // ones after it in its file, because the abandoned act() keeps resolving into
    // the next test's container, which is how one timeout in
    // media-provider-key-mask produced three reds.
    // These ceilings are here to catch a genuine hang, so they are set well clear
    // of the suite's own working range (patch-parity legitimately spends ~10.6s in
    // hooks) rather than inside it. Nothing about what the tests ASSERT changes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Node 22.4+ ships its own `globalThis.localStorage`, and vitest's jsdom
    // environment copies a window property onto the global only when the name is
    // absent from the global or on its own KEYS list. localStorage is on neither,
    // so Node's stub wins and every storage call fails with "is not a function".
    // Turning the Node implementation off lets jsdom's real Storage through.
    execArgv: ['--no-experimental-webstorage'],
    globals: true,
    include: ['**/*.test.js'],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/dist/**', '**/.stryker-tmp/**'],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, '../open-sse') + '/' },
      { find: 'open-sse', replacement: resolve(__dirname, '../open-sse') },
      { find: /^@\//, replacement: resolve(__dirname, '../src') + '/' },
    ],
  },
});
