// Coverage for src/lib/pxpipe/loader.js: load/cache/unload lifecycle,
// version cache-busting, getTransform fail-open, and the selfTest contract.
// install.js is module-mocked; the dynamically imported "package" is a real
// stub module written into this file's isolated DATA_DIR, so no real install
// and no network are involved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/pxpipe/install.js', () => ({
  getInstallInfo: vi.fn(),
  libraryEntry: vi.fn(),
}));

const stubDir = path.join(process.env.DATA_DIR, 'pxpipe-loader-stub');

// Write a stub pxpipe entry module. Distinct filenames per shape so Node's
// module cache cannot bleed one stub into another test.
function writeStub(name, source) {
  fs.mkdirSync(stubDir, { recursive: true });
  const file = path.join(stubDir, name);
  fs.writeFileSync(file, source);
  return file;
}

const goodStub = () =>
  writeStub(
    'good.mjs',
    `export async function transformAnthropicMessages({ body }) {
       return { applied: true, reason: "stub-ok", body };
     }`
  );

let loader;
let install;

async function freshLoader({ installed = true, version = '1.0.0', entry } = {}) {
  vi.resetModules();
  install = await import('@/lib/pxpipe/install.js');
  install.getInstallInfo.mockReturnValue(
    installed ? { installed: true, version } : { installed: false }
  );
  if (entry) install.libraryEntry.mockReturnValue(entry);
  loader = await import('@/lib/pxpipe/loader.js');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadPxpipe', () => {
  it('throws NOT_INSTALLED when no package is installed', async () => {
    await freshLoader({ installed: false });
    await expect(loader.loadPxpipe()).rejects.toMatchObject({
      message: 'PXPIPE is not installed',
      code: 'NOT_INSTALLED',
    });
    expect(loader.getLoadedInfo()).toEqual({ loaded: false });
  });

  it('loads the installed entry, caches it, and reports version and loadedAt', async () => {
    await freshLoader({ version: '2.3.4', entry: goodStub() });
    const before = Date.now();
    const out = await loader.loadPxpipe();
    expect(typeof out.module.transformAnthropicMessages).toBe('function');
    expect(out.version).toBe('2.3.4');
    expect(out.loadedAt).toBeGreaterThanOrEqual(before);

    const info = loader.getLoadedInfo();
    expect(info).toEqual({ loaded: true, version: '2.3.4', loadedAt: out.loadedAt });

    // Cached: a second call returns the same object without re-reading install info.
    install.getInstallInfo.mockClear();
    await expect(loader.loadPxpipe()).resolves.toBe(out);
    expect(install.getInstallInfo).not.toHaveBeenCalled();
  });

  it('coalesces concurrent loads into one in-flight promise', async () => {
    await freshLoader({ entry: goodStub() });
    const [a, b] = await Promise.all([loader.loadPxpipe(), loader.loadPxpipe()]);
    expect(a).toBe(b);
    expect(install.getInstallInfo).toHaveBeenCalledTimes(1);
  });

  it('rejects a package that does not export transformAnthropicMessages', async () => {
    const entry = writeStub('bad.mjs', 'export const nothing = 1;');
    await freshLoader({ entry });
    await expect(loader.loadPxpipe()).rejects.toThrow(
      'installed pxpipe package does not export transformAnthropicMessages'
    );
    expect(loader.getLoadedInfo()).toEqual({ loaded: false });
  });

  it('cache-busts by version so an upgrade reloads without a restart', async () => {
    const entry = writeStub(
      'versioned.mjs',
      'export function transformAnthropicMessages() { return { v: 1 }; }'
    );
    await freshLoader({ version: '1.0.0', entry });
    const first = await loader.loadPxpipe();

    loader.unloadPxpipe();
    fs.writeFileSync(entry, 'export function transformAnthropicMessages() { return { v: 2 }; }');
    install.getInstallInfo.mockReturnValue({ installed: true, version: '2.0.0' });
    const second = await loader.loadPxpipe();

    expect(first.module.transformAnthropicMessages()).toEqual({ v: 1 });
    expect(second.module.transformAnthropicMessages()).toEqual({ v: 2 });
    expect(second.version).toBe('2.0.0');
  });

  it('defaults the cache-bust key when the version is missing', async () => {
    await freshLoader({ version: null, entry: goodStub() });
    const out = await loader.loadPxpipe();
    expect(out.version).toBeNull();
    expect(loader.getLoadedInfo().loaded).toBe(true);
  });
});

describe('unloadPxpipe', () => {
  it('returns whether a module was loaded and clears the cache', async () => {
    await freshLoader({ entry: goodStub() });
    expect(loader.unloadPxpipe()).toBe(false);
    await loader.loadPxpipe();
    expect(loader.unloadPxpipe()).toBe(true);
    expect(loader.getLoadedInfo()).toEqual({ loaded: false });
    expect(loader.unloadPxpipe()).toBe(false);
  });
});

describe('getTransform', () => {
  it('returns the transform function when loadable', async () => {
    await freshLoader({ entry: goodStub() });
    const transform = await loader.getTransform();
    const { module: mod } = await loader.loadPxpipe();
    expect(transform).toBe(mod.transformAnthropicMessages);
  });

  it('returns null on a cold cache when autoLoad is off, without loading', async () => {
    await freshLoader({ entry: goodStub() });
    await expect(loader.getTransform({ autoLoad: false })).resolves.toBeNull();
    expect(install.getInstallInfo).not.toHaveBeenCalled();
    expect(loader.getLoadedInfo()).toEqual({ loaded: false });
  });

  it('returns the cached transform when warm even with autoLoad off', async () => {
    await freshLoader({ entry: goodStub() });
    await loader.loadPxpipe();
    const transform = await loader.getTransform({ autoLoad: false });
    expect(typeof transform).toBe('function');
  });

  it('fails open to null when the load throws', async () => {
    await freshLoader({ installed: false });
    await expect(loader.getTransform()).resolves.toBeNull();
  });
});

describe('selfTest', () => {
  it('passes a synthetic Claude request through and reports ok with a reason', async () => {
    const entry = writeStub(
      'selftest.mjs',
      `export async function transformAnthropicMessages({ body, model }) {
         const parsed = JSON.parse(new TextDecoder().decode(body));
         if (!parsed.model || parsed.model !== model) throw new Error("bad synthetic request");
         return { applied: false, reason: "below_threshold", body };
       }`
    );
    await freshLoader({ entry });
    const out = await loader.selfTest();
    expect(out.ok).toBe(true);
    expect(out.reason).toBe('below_threshold');
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('throws when the transform returns an unexpected shape', async () => {
    const entry = writeStub(
      'badshape.mjs',
      "export async function transformAnthropicMessages() { return { applied: 'yes' }; }"
    );
    await freshLoader({ entry });
    await expect(loader.selfTest()).rejects.toThrow('transform returned an unexpected shape');
  });

  it('propagates NOT_INSTALLED instead of masking it', async () => {
    await freshLoader({ installed: false });
    await expect(loader.selfTest()).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });
});
