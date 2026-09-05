/**
 * src/lib/tunnel/cloudflare/cloudflared.js — binary resolution (ensureCloudflared),
 * spawn arg contracts, exit/error propagation for both tunnel modes, kill and
 * PID lifecycle. child_process, https and pid.js mocked; fs is real but every
 * write lands in the per-file DATA_DIR temp dir.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { savePid, loadPid, clearPid } from '@/lib/tunnel/cloudflare/pid.js';

const DATA_DIR = process.env.DATA_DIR;
const BIN_PATH = path.join(DATA_DIR, 'bin', 'cloudflared');
const load = () => import('@/lib/tunnel/cloudflare/cloudflared.js');

// Minimal valid "binary": ELF magic + padding past the 1MB floor.
function writeValidBinary(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const buf = Buffer.alloc(1024 * 1024 + 16);
  buf.write('\x7fELF', 0, 'binary');
  fs.writeFileSync(p, buf);
  fs.chmodSync(p, 0o755);
}

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

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
});

describe('ensureCloudflared', () => {
  it('CLOUDFLARED_BIN override wins outright when valid', async () => {
    const override = path.join(DATA_DIR, 'provided-cloudflared');
    writeValidBinary(override);
    process.env.CLOUDFLARED_BIN = override;
    const cf = await load();
    expect(await cf.ensureCloudflared()).toBe(override);
    expect(h.httpsGetMock).not.toHaveBeenCalled();
  });

  it('a bogus CLOUDFLARED_BIN fails loud instead of silently downloading', async () => {
    const bogus = path.join(DATA_DIR, 'bogus');
    fs.writeFileSync(bogus, '#!/bin/sh\necho nope\n'); // tiny, wrong magic
    process.env.CLOUDFLARED_BIN = bogus;
    const cf = await load();
    await expect(cf.ensureCloudflared()).rejects.toThrow(/CLOUDFLARED_BIN is set to/);
    expect(h.httpsGetMock).not.toHaveBeenCalled();
  });

  it('reuses a valid stored binary and re-chmods it, no network', async () => {
    writeValidBinary(BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o644);
    const cf = await load();
    expect(await cf.ensureCloudflared()).toBe(BIN_PATH);
    expect(fs.statSync(BIN_PATH).mode & 0o111).not.toBe(0); // executable again
    expect(h.httpsGetMock).not.toHaveBeenCalled();
  });

  it('deletes an invalid stored binary, then prefers PATH before any download', async () => {
    fs.mkdirSync(path.dirname(BIN_PATH), { recursive: true });
    fs.writeFileSync(BIN_PATH, '<html>captive portal</html>'); // wrong magic, tiny
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-path-'));
    writeValidBinary(path.join(pathDir, 'cloudflared'));
    const oldPath = process.env.PATH;
    process.env.PATH = pathDir;
    try {
      const cf = await load();
      expect(await cf.ensureCloudflared()).toBe(path.join(pathDir, 'cloudflared'));
      expect(fs.existsSync(BIN_PATH)).toBe(false); // invalid one removed
      expect(h.httpsGetMock).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  });

  it('a failed download names the url and the CLOUDFLARED_BIN escape hatch', async () => {
    h.httpsGetMock = vi.fn(() => {
      const req = new EventEmitter();
      queueMicrotask(() =>
        req.emit('error', Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }))
      );
      return req;
    });
    const cf = await load();
    await expect(cf.ensureCloudflared()).rejects.toThrow(
      /Could not download cloudflared from https:\/\/github\.com.*ENOTFOUND.*CLOUDFLARED_BIN/s
    );
  });

  it('coalesces concurrent ensure calls into one download attempt', async () => {
    let calls = 0;
    h.httpsGetMock = vi.fn(() => {
      calls += 1;
      const req = new EventEmitter();
      queueMicrotask(() => req.emit('error', new Error('down')));
      return req;
    });
    const cf = await load();
    const [a, b] = await Promise.allSettled([cf.ensureCloudflared(), cf.ensureCloudflared()]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(calls).toBe(1);
  });
});

describe('spawnCloudflared (token tunnel)', () => {
  async function start(child) {
    writeValidBinary(BIN_PATH);
    h.spawnMock = vi.fn(() => child);
    const cf = await load();
    return { cf, promise: cf.spawnCloudflared('tok-123') };
  }

  it('spawns with the exact token args and resolves after 4 registered connections', async () => {
    const child = fakeChild(777);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    expect(h.spawnMock.mock.calls[0][0]).toBe(BIN_PATH);
    expect(h.spawnMock.mock.calls[0][1]).toEqual([
      'tunnel',
      'run',
      '--dns-resolver-addrs',
      '1.1.1.1:53',
      '--token',
      'tok-123',
    ]);
    expect(savePid).toHaveBeenCalledWith(777);
    child.stdout.emit(
      'data',
      Buffer.from('Registered tunnel connection a\nRegistered tunnel connection b\n')
    );
    child.stderr.emit(
      'data',
      Buffer.from('Registered tunnel connection c\nRegistered tunnel connection d\n')
    );
    expect(await promise).toBe(child);
  });

  it('exit code 1 before connecting rejects with the token/network hint and clears the PID', async () => {
    const child = fakeChild(778);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.emit('exit', 1, null);
    await expect(promise).rejects.toThrow(/exited with code 1.*token is valid/s);
    expect(clearPid).toHaveBeenCalledWith(778);
  });

  it('an unexpected exit AFTER connecting fires the registered handler', async () => {
    const child = fakeChild(779);
    const { cf, promise } = await start(child);
    const onExit = vi.fn();
    cf.setUnexpectedExitHandler(onExit);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('Registered tunnel connection\n'.repeat(4)));
    await promise;
    child.emit('exit', 1, null);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('spawn error (ENOENT) rejects with the original error', async () => {
    const child = fakeChild(780);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(promise).rejects.toThrow('spawn ENOENT');
  });
});

describe('spawnQuickTunnel', () => {
  async function start(child, onUrlUpdate) {
    writeValidBinary(BIN_PATH);
    h.spawnMock = vi.fn(() => child);
    const cf = await load();
    return { cf, promise: cf.spawnQuickTunnel(20128, onUrlUpdate) };
  }

  it('passes --url/--no-autoupdate args, resolves the trycloudflare URL, ignores api host', async () => {
    const child = fakeChild(801);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    const [bin, args, opts] = h.spawnMock.mock.calls[0];
    expect(bin).toBe(BIN_PATH);
    expect(args[0]).toBe('tunnel');
    expect(args).toContain('--url');
    expect(args[args.indexOf('--url') + 1]).toBe('http://127.0.0.1:20128');
    expect(args).toContain('--no-autoupdate');
    expect(opts.env.TUNNEL_TRANSPORT_PROTOCOL).toBe('http2'); // default protocol
    child.stderr.emit(
      'data',
      Buffer.from(
        'INF request to https://api.trycloudflare.com ok\nINF https://green-fox.trycloudflare.com registered\n'
      )
    );
    const { tunnelUrl } = await promise;
    expect(tunnelUrl).toBe('https://green-fox.trycloudflare.com');
  });

  it('an unrecognized CLOUDFLARED_PROTOCOL falls back to http2', async () => {
    process.env.CLOUDFLARED_PROTOCOL = 'carrier-pigeon';
    const child = fakeChild(802);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    expect(h.spawnMock.mock.calls[0][2].env.TUNNEL_TRANSPORT_PROTOCOL).toBe('http2');
    child.stdout.emit('data', Buffer.from('https://a-b.trycloudflare.com\n'));
    await promise;
  });

  it('a URL change after connect notifies onUrlUpdate exactly on change', async () => {
    const child = fakeChild(803);
    const onUrlUpdate = vi.fn();
    const { promise } = await start(child, onUrlUpdate);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('https://first-url.trycloudflare.com\n'));
    await promise;
    child.stdout.emit('data', Buffer.from('https://first-url.trycloudflare.com\n')); // same → no call
    expect(onUrlUpdate).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('https://second-url.trycloudflare.com\n'));
    expect(onUrlUpdate).toHaveBeenCalledExactlyOnceWith('https://second-url.trycloudflare.com');
  });

  it('exit code 1 before a URL rejects with the port-7844 diagnosis and the log tail', async () => {
    const child = fakeChild(804);
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('ERR failed to dial edge: 7844 blocked\n'));
    child.emit('exit', 1, null);
    await expect(promise).rejects.toThrow(/code 1.*port 7844.*7844 blocked/s);
    expect(clearPid).toHaveBeenCalledWith(804);
  });

  it('cleans up its temp config dir once the URL arrives', async () => {
    const child = fakeChild(805);
    const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('cloudflared-quick-'));
    const { promise } = await start(child);
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    const configPath =
      h.spawnMock.mock.calls[0][1][h.spawnMock.mock.calls[0][1].indexOf('--config') + 1];
    expect(fs.existsSync(configPath)).toBe(true);
    child.stdout.emit('data', Buffer.from('https://x-y.trycloudflare.com\n'));
    await promise;
    expect(fs.existsSync(configPath)).toBe(false);
    const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('cloudflared-quick-'));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});

describe('kill and PID lifecycle', () => {
  it('killCloudflared kills the tracked child, the persisted PID, and the port match', async () => {
    writeValidBinary(BIN_PATH);
    const child = fakeChild(900);
    h.spawnMock = vi.fn(() => child);
    const cf = await load();
    const p = cf.spawnCloudflared('tok');
    await vi.waitFor(() => expect(h.spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('Registered tunnel connection\n'.repeat(4)));
    await p;

    loadPid.mockReturnValue(999999); // stale persisted pid from a previous run
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    cf.killCloudflared(20128);
    expect(child.kill).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(999999);
    expect(clearPid).toHaveBeenCalled();
    const pkill = h.execSyncMock.mock.calls.find(([c]) => c.includes('pkill'));
    expect(pkill[0]).toContain(':20128([^0-9]|$)'); // boundary: :20128 not :201280

    // Deliberate kill → exit fires no unexpected-exit handler
    const onExit = vi.fn();
    cf.setUnexpectedExitHandler(onExit);
    child.emit('exit', null, 'SIGTERM');
    expect(onExit).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('isCloudflaredRunning reads the persisted PID via signal 0', async () => {
    const cf = await load();
    expect(cf.isCloudflaredRunning()).toBe(false); // no pid file
    loadPid.mockReturnValue(process.pid); // this very process → alive
    expect(cf.isCloudflaredRunning()).toBe(true);
    loadPid.mockReturnValue(2 ** 30); // nonexistent pid → ESRCH
    expect(cf.isCloudflaredRunning()).toBe(false);
  });
});
