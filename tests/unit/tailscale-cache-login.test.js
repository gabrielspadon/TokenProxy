/**
 * src/lib/tunnel/tailscale/tailscale.js — cached background-refresh getters
 * (logged-in / running / funnel URL), dual-socket probe fallback, the
 * `tailscale up` login state machine, funnel timeout/exit recovery, and the
 * root-owned statedir reclaim walk. All child_process and fs mocked; no real
 * process is ever spawned. Complements tailscale-lifecycle.test.js, which owns
 * binary resolution, strict probes and daemon start/stop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const h = vi.hoisted(() => ({
  execAsyncImpl: null, // (cmd) => Promise<{stdout, stderr}>
  execSyncMock: null,
  spawnMock: null,
  exists: new Set(),
  statSyncImpl: null,
  readdirImpl: null,
}));

vi.mock('child_process', () => {
  const execSync = (...a) => h.execSyncMock(...a);
  const spawn = (...a) => h.spawnMock(...a);
  const exec = (cmd, opts, cb) => {
    h.execAsyncImpl(cmd, opts).then(
      ({ stdout, stderr }) => cb(null, stdout, stderr),
      (err) => cb(err)
    );
  };
  exec[Symbol.for('nodejs.util.promisify.custom')] = (cmd, opts) => h.execAsyncImpl(cmd, opts);
  const mod = { execSync, exec, spawn };
  return { ...mod, default: mod };
});

vi.mock('fs', () => {
  const fsMock = {
    existsSync: (p) => h.exists.has(p),
    mkdirSync: vi.fn(),
    statSync: (p) => h.statSyncImpl(p),
    readdirSync: (p) => h.readdirImpl(p),
    unlinkSync: vi.fn(),
  };
  return { ...fsMock, default: fsMock };
});

vi.mock('@/mitm/dns/dnsConfig', () => ({ execWithPassword: vi.fn(async () => '') }));

const DATA_DIR = process.env.DATA_DIR;
const TS_DIR = path.join(DATA_DIR, 'tailscale');
const SOCKET = path.join(TS_DIR, 'tailscaled.sock');
const SYSTEM_SOCKET = '/var/run/tailscale/tailscaled.sock';
const BIN = '/usr/bin/tailscale';

const load = () => import('@/lib/tunnel/tailscale/tailscale.js');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.unref = vi.fn();
  child.kill = vi.fn();
  return child;
}

// Flush microtask chains without advancing timers.
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.resetModules();
  h.exists.clear();
  h.execAsyncImpl = vi.fn(() => Promise.reject(new Error('exec not stubbed')));
  h.execSyncMock = vi.fn(() => {
    throw new Error('execSync not stubbed');
  });
  h.spawnMock = vi.fn(() => fakeChild());
  h.statSyncImpl = () => {
    throw new Error('ENOENT');
  };
  h.readdirImpl = () => [];
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('cached non-blocking getters', () => {
  it('isTailscaleLoggedIn: stale-cache miss now, truth after the background probe lands', async () => {
    h.exists.add(BIN);
    h.execAsyncImpl = vi.fn(async () => ({
      stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true } }),
      stderr: '',
    }));
    const ts = await load();
    expect(ts.isTailscaleLoggedIn()).toBe(false); // first call returns cached default
    await flush();
    expect(ts.isTailscaleLoggedIn()).toBe(true); // within TTL: cached, no new probe
    const probes = h.execAsyncImpl.mock.calls.filter(([c]) => c.includes('status --json'));
    expect(probes).toHaveLength(1);
  });

  it('isTailscaleLoggedIn falls back to the SYSTEM socket when the custom one is dead', async () => {
    h.exists.add(BIN);
    h.execAsyncImpl = vi.fn(async (cmd) => {
      if (!cmd.includes('status --json')) return { stdout: '', stderr: '' };
      if (cmd.includes(SOCKET)) throw new Error('connection refused');
      expect(cmd).toContain(SYSTEM_SOCKET);
      return {
        stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true } }),
        stderr: '',
      };
    });
    const ts = await load();
    ts.isTailscaleLoggedIn();
    await flush();
    expect(ts.isTailscaleLoggedIn()).toBe(true);
  });

  it('isTailscaleLoggedIn: no binary anywhere settles false without a status probe', async () => {
    h.execAsyncImpl = vi.fn(() => Promise.reject(new Error('which: not found')));
    const ts = await load();
    expect(ts.isTailscaleLoggedIn()).toBe(false);
    await flush();
    expect(ts.isTailscaleLoggedIn()).toBe(false);
    // Only the background `which tailscale` bin refresh may fire, never status.
    const probes = h.execAsyncImpl.mock.calls.filter(([c]) => c.includes('status'));
    expect(probes).toHaveLength(0);
  });

  it('isTailscaleRunning reflects AllowFunnel after the background refresh', async () => {
    h.exists.add(BIN);
    h.execAsyncImpl = vi.fn(async (cmd) => {
      if (cmd.includes('funnel status --json'))
        return { stdout: JSON.stringify({ AllowFunnel: { 'x:443': true } }), stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const ts = await load();
    expect(ts.isTailscaleRunning()).toBe(false);
    await flush();
    expect(ts.isTailscaleRunning()).toBe(true);
  });

  it('isTailscaleRunning: unparseable funnel output settles false, and no binary means no probe', async () => {
    h.exists.add(BIN);
    h.execAsyncImpl = vi.fn(async () => ({ stdout: 'not json', stderr: '' }));
    let ts = await load();
    ts.isTailscaleRunning();
    await flush();
    expect(ts.isTailscaleRunning()).toBe(false);

    vi.resetModules();
    h.exists.clear();
    h.execAsyncImpl = vi.fn(() => Promise.reject(new Error('which: not found')));
    ts = await load();
    expect(ts.isTailscaleRunning()).toBe(false);
    await flush();
    const funnelProbes = h.execAsyncImpl.mock.calls.filter(([c]) => c.includes('funnel'));
    expect(funnelProbes).toHaveLength(0);
  });

  it('isTailscaleRunningStrict returns false when the probe itself fails', async () => {
    h.exists.add(BIN);
    h.execAsyncImpl = vi.fn(() => Promise.reject(new Error('dead daemon')));
    const ts = await load();
    expect(await ts.isTailscaleRunningStrict()).toBe(false);
  });

  it('getTailscaleFunnelUrl resolves Self.DNSName (dot stripped) and refreshes on port change', async () => {
    h.exists.add(BIN);
    h.execAsyncImpl = vi.fn(async (cmd) => {
      if (cmd.includes('status --json'))
        return { stdout: JSON.stringify({ Self: { DNSName: 'box.tail1.ts.net.' } }), stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const ts = await load();
    expect(ts.getTailscaleFunnelUrl(20128)).toBeNull(); // first call: cache empty
    await flush();
    expect(ts.getTailscaleFunnelUrl(20128)).toBe('https://box.tail1.ts.net');
    const before = h.execAsyncImpl.mock.calls.length;
    ts.getTailscaleFunnelUrl(9999); // port mismatch → refresh fires again
    await flush();
    expect(h.execAsyncImpl.mock.calls.length).toBeGreaterThan(before);
  });

  it('getTailscaleFunnelUrl keeps the previous value when the probe errors or returns junk', async () => {
    h.exists.add(BIN);
    h.execAsyncImpl = vi.fn(async () => ({ stdout: 'junk', stderr: '' }));
    const ts = await load();
    ts.getTailscaleFunnelUrl(20128);
    await flush();
    expect(ts.getTailscaleFunnelUrl(20128)).toBeNull(); // junk parse → prev kept (null)
  });
});

describe('statedir ownership reclaim (startDaemonWithPassword restart path)', () => {
  it('walks the statedir and attempts chown then sudo -n chown when a root-owned file is found', async () => {
    vi.useFakeTimers();
    h.exists.add(TS_DIR);
    h.statSyncImpl = (p) => ({
      uid: p === TS_DIR ? process.getuid() : 0, // a root-owned entry inside
      isDirectory: () => p === TS_DIR,
    });
    h.readdirImpl = () => ['tailscaled.state'];
    const chowns = [];
    h.execSyncMock = vi.fn((cmd) => {
      if (cmd.includes('chown')) {
        chowns.push(cmd);
        throw new Error('not permitted'); // both attempts fail, swallowed
      }
      throw new Error(`fail: ${cmd}`);
    });
    const ts = await load();
    const p = ts.startDaemonWithPassword('');
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(chowns).toHaveLength(2);
    expect(chowns[0]).toContain(`chown -R ${process.getuid()}:${process.getgid()} "${TS_DIR}"`);
    expect(chowns[1]).toMatch(/^sudo -n chown -R /);
    expect(h.spawnMock).toHaveBeenCalledTimes(1); // daemon still spawned afterwards
  });

  it('skips chown entirely when everything is already user-owned', async () => {
    vi.useFakeTimers();
    h.exists.add(TS_DIR);
    h.statSyncImpl = () => ({ uid: process.getuid(), isDirectory: () => false });
    h.execSyncMock = vi.fn((cmd) => {
      throw new Error(`fail: ${cmd}`);
    });
    const ts = await load();
    const p = ts.startDaemonWithPassword('');
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(h.execSyncMock.mock.calls.filter(([c]) => c.includes('chown'))).toHaveLength(0);
  });
});

describe('startLogin', () => {
  const loginUrl = 'https://login.tailscale.com/a/abc123DEF';

  function notLoggedIn() {
    h.execAsyncImpl = vi.fn(() => Promise.reject(new Error('no daemon')));
  }

  // Returns { p } (an object, not the promise itself) so `await begin(...)`
  // does not adopt the still-pending login promise and deadlock the test.
  async function begin(ts, hostname) {
    const p = ts.startLogin(hostname);
    p.catch(() => {}); // rejection is asserted by the caller
    await vi.advanceTimersByTimeAsync(0); // flush the strict pre-check microtasks
    return { p };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    h.exists.add(BIN);
  });

  it('rejects when tailscale is not installed', async () => {
    h.exists.clear();
    const ts = await load();
    await expect(ts.startLogin('h')).rejects.toThrow('Tailscale not installed');
  });

  it('short-circuits with alreadyLoggedIn when the strict pre-check passes', async () => {
    h.execAsyncImpl = vi.fn(async () => ({
      stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true } }),
      stderr: '',
    }));
    const ts = await load();
    const { p } = await begin(ts, 'h');
    await expect(p).resolves.toEqual({ alreadyLoggedIn: true });
    expect(h.spawnMock).not.toHaveBeenCalled(); // no `tailscale up` spawned
  });

  it('spawns `up` with the module-built args and resolves the auth URL from stdout', async () => {
    notLoggedIn();
    const ts = await load();
    const { p } = await begin(ts, 'myhost');
    const [bin, args] = h.spawnMock.mock.calls[0];
    expect(bin).toBe(BIN);
    expect(args).toEqual(ts.buildTailscaleUpArgs('myhost'));
    const child = h.spawnMock.mock.results[0].value;
    child.stdout.emit('data', Buffer.from(`To authenticate, visit:\n\n\t${loginUrl}\n`));
    await expect(p).resolves.toEqual({ authUrl: loginUrl });
    expect(child.unref).toHaveBeenCalled();
  });

  it('the 500ms status poll picks the AuthURL up when stdout never prints it (Windows shape)', async () => {
    notLoggedIn();
    h.execSyncMock = vi.fn((cmd) => {
      if (cmd.includes('status --json')) return JSON.stringify({ AuthURL: loginUrl });
      throw new Error(`fail: ${cmd}`);
    });
    const ts = await load();
    const { p } = await begin(ts, 'h');
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toEqual({ authUrl: loginUrl });
  });

  it('a login that completes without printing a URL resolves alreadyLoggedIn via the poll', async () => {
    let calls = 0;
    h.execAsyncImpl = vi.fn(async (cmd) => {
      if (!cmd.includes('status --json')) return { stdout: '', stderr: '' };
      calls += 1;
      if (calls === 1) throw new Error('not yet'); // pre-check: not logged in
      return {
        stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true } }),
        stderr: '',
      };
    });
    const ts = await load();
    const { p } = await begin(ts, 'h');
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toEqual({ alreadyLoggedIn: true });
  });

  it('on child exit, the AuthURL published in status is still honoured', async () => {
    notLoggedIn();
    h.execSyncMock = vi.fn((cmd) => {
      if (cmd.includes('status --json')) return JSON.stringify({ AuthURL: loginUrl });
      throw new Error(`fail: ${cmd}`);
    });
    const ts = await load();
    const { p } = await begin(ts, 'h');
    const child = h.spawnMock.mock.results[0].value;
    child.emit('exit', 0);
    await expect(p).resolves.toEqual({ authUrl: loginUrl });
  });

  it('times out after 15s with the no-output diagnosis when nothing ever arrives', async () => {
    notLoggedIn();
    const ts = await load();
    const { p } = await begin(ts, 'h');
    const assertion = expect(p).rejects.toThrow(/printed nothing within 15s/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('a second login attempt retires the first unfinished child before spawning', async () => {
    notLoggedIn();
    const ts = await load();
    const { p: p1 } = await begin(ts, 'h');
    const child1 = h.spawnMock.mock.results[0].value;
    const { p: p2 } = await begin(ts, 'h');
    expect(child1.kill).toHaveBeenCalled();
    expect(h.spawnMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const child2 = h.spawnMock.mock.results[h.spawnMock.mock.results.length - 1].value;
    child1.stdout.emit('data', Buffer.from(loginUrl));
    child2.stdout.emit('data', Buffer.from(loginUrl));
    await expect(Promise.all([p1, p2])).resolves.toBeDefined();
  });

  it('a spawn error rejects with the original error', async () => {
    notLoggedIn();
    const ts = await load();
    const { p } = await begin(ts, 'h');
    const child = h.spawnMock.mock.results[0].value;
    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    await expect(p).rejects.toThrow('spawn EACCES');
  });
});

describe('startFunnel recovery paths', () => {
  it('rejects after the 30s ceiling when no URL ever becomes resolvable', async () => {
    vi.useFakeTimers();
    h.exists.add(BIN);
    h.execSyncMock = vi.fn(() => {
      throw new Error('no status');
    });
    h.execAsyncImpl = vi.fn(() => Promise.reject(new Error('no status')));
    const ts = await load();
    const p = ts.startFunnel(20128);
    const assertion = expect(p).rejects.toThrow(/Tailscale funnel timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('a clean --bg exit resolves via the authoritative Self.DNSName lookup', async () => {
    h.exists.add(BIN);
    h.execSyncMock = vi.fn((cmd) => {
      if (cmd.includes('funnel --bg reset')) return '';
      if (cmd.includes('status --json'))
        return JSON.stringify({ Self: { DNSName: 'box.tail1.ts.net.' } });
      throw new Error(`unexpected: ${cmd}`);
    });
    const child = fakeChild();
    h.spawnMock = vi.fn(() => child);
    const ts = await load();
    const p = ts.startFunnel(20128);
    child.emit('exit', 0); // --bg setup done, no data events at all
    await expect(p).resolves.toEqual({ tunnelUrl: 'https://box.tail1.ts.net' });
  });
});

describe('provisionCert guard', () => {
  it('is a no-op without a hostname or without a binary', async () => {
    h.exists.add(BIN);
    h.execAsyncImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const ts = await load();
    await ts.provisionCert('');
    const certCalls = h.execAsyncImpl.mock.calls.filter(([c]) => c.includes(' cert '));
    expect(certCalls).toHaveLength(0);
  });
});
