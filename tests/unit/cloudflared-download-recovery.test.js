/**
 * src/lib/tunnel/cloudflare/cloudflared.js — the download path (progress state,
 * redirects, HTTP failures, captive-portal payload rejection), platform/arch
 * URL mapping, and the timeout / exit-code / intentional-kill recovery branches
 * of both tunnel modes. child_process, https and pid.js mocked; fs is real but
 * every write lands in the per-file DATA_DIR temp dir. Complements
 * cloudflared-lifecycle.test.js, which owns binary resolution and the happy
 * paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const h = vi.hoisted(() => ({ execSyncMock: null, spawnMock: null, httpsGetMock: null }));

vi.mock('child_process', () => {
  const execSync = (...a) => h.execSyncMock(...a);
  const spawn = (...a) => h.spawnMock(...a);
  const mod = { execSync, spawn };
  return { ...mod, default: mod };
});

vi.mock('https', () => {
  const get = (...a) => h.httpsGetMock(...a);
  const mod = { get };
  return { ...mod, default: mod };
});

vi.mock('@/lib/tunnel/cloudflare/pid.js', () => ({
  savePid: vi.fn(),
  loadPid: vi.fn(() => null),
  clearPid: vi.fn(),
}));

import { loadPid, clearPid } from '@/lib/tunnel/cloudflare/pid.js';

const DATA_DIR = process.env.DATA_DIR;
const BIN_PATH = path.join(DATA_DIR, 'bin', 'cloudflared');
const load = () => import('@/lib/tunnel/cloudflare/cloudflared.js');

// Payload with the right magic for THIS platform, past the 1MB size floor —
// derived from the same platform check the module itself applies.
function validPayload() {
  const buf = Buffer.alloc(1024 * 1024 + 16);
  if (os.platform() === 'darwin') buf.writeUInt32BE(0xcffaedfe, 0);
  else if (os.platform() === 'win32') buf.write('MZ', 0, 'binary');
  else buf.write('\x7fELF', 0, 'binary');
  return buf;
}

function fakeChild(pid = 5100) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

// One HTTP exchange: cb(response), then payload piped into the dest stream.
// Deferred by a real timer, not a microtask: the module's createWriteStream(dest)
// opens the file asynchronously, and the non-200/redirect branches unlinkSync(dest)
// as soon as the response arrives, so the response must land after the open.
function respondWith({ statusCode = 200, headers = {}, body = null }) {
  return (url, cb) => {
    const req = new EventEmitter();
    setTimeout(() => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = { 'content-length': body ? String(body.length) : '0', ...headers };
      res.pipe = (file) => {
        file.end(body ?? Buffer.alloc(0));
      };
      cb(res);
      if (body) res.emit('data', body); // progress accounting
    }, 10);
    return req;
  };
}

function writeValidBinary(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, validPayload());
  fs.chmodSync(p, 0o755);
}

let savedPath;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.execSyncMock = vi.fn(() => '');
  h.spawnMock = vi.fn(() => fakeChild());
  h.httpsGetMock = vi.fn(() => {
    throw new Error('network must be mocked');
  });
  loadPid.mockReturnValue(null);
  fs.rmSync(path.join(DATA_DIR, 'bin'), { recursive: true, force: true });
  delete process.env.CLOUDFLARED_BIN;
  delete process.env.TUNNEL_TRANSPORT_PROTOCOL;
  delete process.env.CLOUDFLARED_PROTOCOL;
  // Empty PATH so findCloudflaredOnPath never resolves a host binary.
  savedPath = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-empty-path-'));
});

afterEach(() => {
  fs.rmSync(process.env.PATH, { recursive: true, force: true });
  process.env.PATH = savedPath;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('download path', () => {
  it('downloads, tracks progress to 100, validates magic, chmods, and returns BIN_PATH', async () => {
    h.httpsGetMock = vi.fn(respondWith({ body: validPayload() }));
    const cf = await load();
    expect(cf.getDownloadStatus()).toEqual({ downloading: false, progress: 0 });
    const got = await cf.ensureCloudflared();
    expect(got).toBe(BIN_PATH);
    expect(cf.getDownloadStatus()).toEqual({ downloading: false, progress: 100 });
    expect(fs.statSync(BIN_PATH).mode & 0o111).not.toBe(0);
    // Requested URL comes from the module's platform/arch mapping, not a guess.
    const url = h.httpsGetMock.mock.calls[0][0];
    expect(url).toMatch(
      /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/latest\/download\//
    );
  });

  it('follows a 302 redirect to the final artifact', async () => {
    let call = 0;
    h.httpsGetMock = vi.fn((url, cb) => {
      call += 1;
      const impl =
        call === 1
          ? respondWith({ statusCode: 302, headers: { location: 'https://mirror.example/cf' } })
          : respondWith({ body: validPayload() });
      return impl(url, cb);
    });
    const cf = await load();
    expect(await cf.ensureCloudflared()).toBe(BIN_PATH);
    expect(h.httpsGetMock.mock.calls[1][0]).toBe('https://mirror.example/cf');
  });

  it('a non-200 status rejects with the status code and the escape-hatch hint', async () => {
    h.httpsGetMock = vi.fn(respondWith({ statusCode: 404 }));
    const cf = await load();
    await expect(cf.ensureCloudflared()).rejects.toThrow(
      /Could not download cloudflared from .*Download failed with status 404.*CLOUDFLARED_BIN/s
    );
    expect(fs.existsSync(BIN_PATH)).toBe(false);
  });

  it('rejects a captive-portal HTML payload after download and deletes it', async () => {
    h.httpsGetMock = vi.fn(
      respondWith({ body: Buffer.from('<html>portal</html>'.repeat(100_000)) }) // big but wrong magic
    );
    const cf = await load();
    await expect(cf.ensureCloudflared()).rejects.toThrow(/not a valid .*proxy or captive portal/s);
    expect(fs.existsSync(BIN_PATH)).toBe(false);
  });

  it('removes a stale .tmp leftover from a previous crashed download', async () => {
    fs.mkdirSync(path.dirname(BIN_PATH), { recursive: true });
    fs.writeFileSync(`${BIN_PATH}.tmp`, 'partial');
    h.httpsGetMock = vi.fn(respondWith({ body: validPayload() }));
    const cf = await load();
    await cf.ensureCloudflared();
    expect(fs.existsSync(`${BIN_PATH}.tmp`)).toBe(false);
  });

  it('an unmapped arch falls back to the platform default artifact', async () => {
    const archSpy = vi.spyOn(os, 'arch').mockReturnValue('mips');
    h.httpsGetMock = vi.fn(respondWith({ statusCode: 500 }));
    const cf = await load();
    // The rejection message names the URL the module actually built.
    await expect(cf.ensureCloudflared()).rejects.toThrow(
      /Could not download cloudflared from https:/
    );
    const url = h.httpsGetMock.mock.calls[0][0];
    // Fallback artifact for the current platform, straight from the module's table.
    expect(url).not.toContain('mips');
    expect(url).toContain(os.platform() === 'win32' ? 'windows' : os.platform());
    archSpy.mockRestore();
  });

  it('an unsupported platform throws before any network call', async () => {
    const platSpy = vi.spyOn(os, 'platform').mockReturnValue('freebsd');
    try {
      const cf = await load();
      await expect(cf.ensureCloudflared()).rejects.toThrow('Unsupported platform: freebsd');
      expect(h.httpsGetMock).not.toHaveBeenCalled();
    } finally {
      platSpy.mockRestore();
    }
  });
});

describe('spawnCloudflared recovery', () => {
  async function start(child, token = 'tok') {
    writeValidBinary(BIN_PATH);
    h.spawnMock = vi.fn(() => child);
    const cf = await load();
    return { cf, promise: cf.spawnCloudflared(token) };
  }

  it('resolves the child at the 90s ceiling even without 4 registered connections', async () => {
    vi.useFakeTimers();
    const child = fakeChild(5001);
    const { promise } = await start(child);
    await vi.advanceTimersByTimeAsync(0); // let ensureCloudflared settle
    expect(h.spawnMock).toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('Registered tunnel connection\n')); // only 1 of 4
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(promise).resolves.toBe(child);
  });

  it('exit code 2 rejects with the arguments hint', async () => {
    const child = fakeChild(5002);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.emit('exit', 2, null);
    await expect(promise).rejects.toThrow(/exited with code 2.*arguments are correct/s);
    expect(clearPid).toHaveBeenCalledWith(5002);
  });

  it('any other exit code rejects with the bare code', async () => {
    const child = fakeChild(5003);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.emit('exit', 137, 'SIGKILL');
    await expect(promise).rejects.toThrow(/exited with code 137/);
  });
});

describe('spawnQuickTunnel recovery', () => {
  async function start(child, onUrlUpdate) {
    writeValidBinary(BIN_PATH);
    h.spawnMock = vi.fn(() => child);
    const cf = await load();
    return { cf, promise: cf.spawnQuickTunnel(20128, onUrlUpdate) };
  }

  it('rejects at the 90s ceiling with the log tail and cleans the temp config dir', async () => {
    vi.useFakeTimers();
    const child = fakeChild(5101);
    const { promise } = await start(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawnMock).toHaveBeenCalled();
    const args = h.spawnMock.mock.calls[0][1];
    const configPath = args[args.indexOf('--config') + 1];
    child.stderr.emit('data', Buffer.from('INF still dialing edge\n'));
    const assertion = expect(promise).rejects.toThrow(
      /Quick tunnel timed out.*still dialing edge/s
    );
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('a spawn error rejects with the original error and cleans up', async () => {
    const child = fakeChild(5102);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    const args = h.spawnMock.mock.calls[0][1];
    const configPath = args[args.indexOf('--config') + 1];
    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    await expect(promise).rejects.toThrow('spawn EACCES');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('a deliberate kill before the URL rejects "cloudflared killed" without the exit-code noise', async () => {
    const child = fakeChild(5103);
    const { cf, promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    const onExit = vi.fn();
    cf.setUnexpectedExitHandler(onExit);
    cf.killCloudflared(); // no port → port-kill branch is a no-op
    child.emit('exit', null, 'SIGTERM');
    await expect(promise).rejects.toThrow('cloudflared killed');
    expect(onExit).not.toHaveBeenCalled();
    // killCloudflaredByPort(undefined) must not shell out a pkill
    const pkills = h.execSyncMock.mock.calls.filter(([c]) => String(c).includes('pkill'));
    expect(pkills).toHaveLength(0);
  });

  it('exit code 2 before a URL rejects with the bad-arguments diagnosis', async () => {
    const child = fakeChild(5104);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('flag provided but not defined\n'));
    child.emit('exit', 2, null);
    await expect(promise).rejects.toThrow(/code 2.*Bad arguments.*flag provided/s);
  });

  it('any other exit code before a URL rejects with the code and tail', async () => {
    const child = fakeChild(5105);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.emit('exit', 137, 'SIGKILL');
    await expect(promise).rejects.toThrow(/exited \(code 137\).*\(empty\)/s);
  });

  it('an unexpected exit AFTER the URL fires the registered handler', async () => {
    const child = fakeChild(5106);
    const { cf, promise } = await start(child);
    const onExit = vi.fn();
    cf.setUnexpectedExitHandler(onExit);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('https://up-and-running.trycloudflare.com\n'));
    await promise;
    child.emit('exit', 1, null);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(clearPid).toHaveBeenCalledWith(5106);
  });
});
