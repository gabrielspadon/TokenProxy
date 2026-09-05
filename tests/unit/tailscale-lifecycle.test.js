/**
 * src/lib/tunnel/tailscale/tailscale.js — binary resolution, status probes,
 * daemon start/stop, funnel start/stop. All child_process and fs mocked; no
 * real process is ever spawned. describeLoginFailure and the auth-key login
 * flow are already covered by tunnel-start-diagnostics-896.test.js and
 * tailscale-authkey.test.js and are not repeated here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const h = vi.hoisted(() => ({
  execAsyncImpl: null, // (cmd) => Promise<{stdout, stderr}>
  execSyncMock: null, // set in beforeEach (vi.fn)
  spawnMock: null,
  exists: new Set(), // paths fs.existsSync answers true for
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
    statSync: vi.fn(() => {
      throw new Error('ENOENT');
    }),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
  };
  return { ...fsMock, default: fsMock };
});

vi.mock('@/mitm/dns/dnsConfig', () => ({ execWithPassword: vi.fn(async () => '') }));

import { execWithPassword } from '@/mitm/dns/dnsConfig';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR;
const MANAGED_BIN = path.join(DATA_DIR, 'bin', 'tailscale');
const TS_DIR = path.join(DATA_DIR, 'tailscale');
const SOCKET = path.join(TS_DIR, 'tailscaled.sock');
const SYSTEM_SOCKET = '/var/run/tailscale/tailscaled.sock';

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

beforeEach(() => {
  vi.resetModules();
  h.exists.clear();
  h.execAsyncImpl = vi.fn(() => Promise.reject(new Error('exec not stubbed')));
  h.execSyncMock = vi.fn(() => {
    throw new Error('execSync not stubbed');
  });
  h.spawnMock = vi.fn(() => fakeChild());
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('binary resolution', () => {
  it('prefers the managed DATA_DIR binary over system candidates', async () => {
    h.exists.add(MANAGED_BIN).add('/usr/bin/tailscale');
    const ts = await load();
    expect(ts.getTailscaleBin()).toBe(MANAGED_BIN);
    expect(ts.isTailscaleInstalled()).toBe(true);
  });

  it('falls back to a well-known unix candidate', async () => {
    h.exists.add('/usr/bin/tailscale');
    const ts = await load();
    expect(ts.getTailscaleBin()).toBe('/usr/bin/tailscale');
  });

  it('returns null (not installed) when no binary exists anywhere', async () => {
    const ts = await load();
    expect(ts.getTailscaleBin()).toBeNull();
    expect(ts.isTailscaleInstalled()).toBe(false);
  });

  it('getTailscaledBin prefers the daemon sitting beside the resolved CLI', async () => {
    h.exists.add('/usr/bin/tailscale').add('/usr/bin/tailscaled').add('/usr/sbin/tailscaled');
    const ts = await load();
    expect(ts.getTailscaledBin()).toBe('/usr/bin/tailscaled');
  });

  it('getTailscaledBin falls through candidates, then bare name', async () => {
    h.exists.add('/usr/bin/tailscale').add('/usr/sbin/tailscaled');
    const ts = await load();
    expect(ts.getTailscaledBin()).toBe('/usr/sbin/tailscaled');
    h.exists.delete('/usr/sbin/tailscaled');
    expect(ts.getTailscaledBin()).toBe('tailscaled');
  });
});

describe('status probes', () => {
  it('isTailscaleLoggedInStrict: Running + Self.Online over the custom socket', async () => {
    h.exists.add('/usr/bin/tailscale');
    h.execAsyncImpl = vi.fn(async (cmd) => {
      expect(cmd).toContain(`--socket ${SOCKET}`);
      expect(cmd).toContain('status --json');
      return {
        stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true } }),
        stderr: '',
      };
    });
    const ts = await load();
    expect(await ts.isTailscaleLoggedInStrict()).toBe(true);
  });

  it('isTailscaleLoggedInStrict: Stopped backend, probe failure, and no binary are all false', async () => {
    h.exists.add('/usr/bin/tailscale');
    h.execAsyncImpl = vi.fn(async () => ({
      stdout: JSON.stringify({ BackendState: 'Stopped' }),
      stderr: '',
    }));
    let ts = await load();
    expect(await ts.isTailscaleLoggedInStrict()).toBe(false);

    h.execAsyncImpl = vi.fn(() => Promise.reject(new Error('no daemon')));
    expect(await ts.isTailscaleLoggedInStrict()).toBe(false);

    vi.resetModules();
    h.exists.clear();
    ts = await load();
    expect(await ts.isTailscaleLoggedInStrict()).toBe(false);
    // no binary → probe never fired
  });

  it('isTailscaleRunningStrict: true only when AllowFunnel has entries', async () => {
    h.exists.add('/usr/bin/tailscale');
    h.execAsyncImpl = vi.fn(async () => ({
      stdout: JSON.stringify({ AllowFunnel: { 'host:443': true } }),
      stderr: '',
    }));
    const ts = await load();
    expect(await ts.isTailscaleRunningStrict()).toBe(true);

    h.execAsyncImpl = vi.fn(async () => ({
      stdout: JSON.stringify({ AllowFunnel: {} }),
      stderr: '',
    }));
    expect(await ts.isTailscaleRunningStrict()).toBe(false);
  });

  it('isSystemDaemonRunning: needs the system socket file, a binary, and BackendState=Running', async () => {
    const ts = await load();
    // socket file absent → false without any exec
    expect(ts.isSystemDaemonRunning()).toBe(false);
    expect(h.execSyncMock).not.toHaveBeenCalled();
  });

  it('isSystemDaemonRunning: probes the SYSTEM socket and parses Running', async () => {
    h.exists.add(SYSTEM_SOCKET).add('/usr/bin/tailscale');
    h.execSyncMock = vi.fn((cmd) => {
      expect(cmd).toContain(`--socket ${SYSTEM_SOCKET}`);
      return JSON.stringify({ BackendState: 'Running' });
    });
    const ts = await load();
    expect(ts.isSystemDaemonRunning()).toBe(true);

    h.execSyncMock = vi.fn(() => {
      throw new Error('connection refused');
    });
    expect(ts.isSystemDaemonRunning()).toBe(false);
  });

  it('isDaemonAlive reads pgrep for a daemon on OUR socket', async () => {
    h.execSyncMock = vi.fn((cmd) => {
      expect(cmd).toContain('pgrep');
      expect(cmd).toContain(SOCKET);
      return `123 tailscaled --socket=${SOCKET}\n`;
    });
    const ts = await load();
    expect(ts.isDaemonAlive()).toBe(true);

    h.execSyncMock = vi.fn(() => {
      throw new Error('no match');
    });
    expect(ts.isDaemonAlive()).toBe(false);
  });
});

describe('startDaemonWithPassword', () => {
  it('reuses a healthy TUN daemon instead of restarting it (idempotent)', async () => {
    h.exists.add('/usr/bin/tailscale');
    h.execSyncMock = vi.fn((cmd) => {
      if (cmd.includes('pgrep')) return `99 tailscaled --socket=${SOCKET} --statedir=${TS_DIR}`;
      if (cmd.includes('status --json')) return '';
      throw new Error(`unexpected: ${cmd}`);
    });
    const ts = await load();
    await ts.startDaemonWithPassword(''); // no password, healthy TUN → keep
    expect(h.spawnMock).not.toHaveBeenCalled();
    const killed = h.execSyncMock.mock.calls.filter(([c]) => c.includes('pkill'));
    expect(killed).toEqual([]);
  });

  it('spawns a detached userspace daemon when nothing runs and no sudo password', async () => {
    vi.useFakeTimers();
    h.execSyncMock = vi.fn((cmd) => {
      throw new Error(`fail: ${cmd}`);
    }); // pgrep/pkill all fail
    const ts = await load();
    const p = ts.startDaemonWithPassword('');
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(h.spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = h.spawnMock.mock.calls[0];
    expect(cmd).toBe('tailscaled'); // no binary found anywhere → bare PATH name
    expect(args).toEqual([
      `--socket=${SOCKET}`,
      `--statedir=${TS_DIR}`,
      '--tun=userspace-networking',
    ]);
    expect(opts.detached).toBe(true);
  });

  it('spawns via sudo -S in TUN mode and feeds the password on stdin', async () => {
    vi.useFakeTimers();
    h.exists.add('/usr/bin/tailscale').add('/usr/bin/tailscaled');
    h.execSyncMock = vi.fn((cmd) => {
      throw new Error(`fail: ${cmd}`);
    });
    const child = fakeChild();
    h.spawnMock = vi.fn(() => child);
    const ts = await load();
    const p = ts.startDaemonWithPassword('hunter2');
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    const [cmd, args] = h.spawnMock.mock.calls[0];
    expect(cmd).toBe('sudo');
    expect(args).toEqual([
      '-S',
      '/usr/bin/tailscaled',
      `--socket=${SOCKET}`,
      `--statedir=${TS_DIR}`,
    ]);
    expect(child.stdin.write).toHaveBeenCalledWith('hunter2\n');
    expect(child.stdin.end).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
    // kills any mode-mismatched daemon on our socket first
    expect(execWithPassword).toHaveBeenCalledWith(expect.stringContaining('pkill'), 'hunter2');
  });
});

describe('startFunnel', () => {
  it('resolves the real hostname from Self.DNSName once the funnel is up', async () => {
    h.exists.add('/usr/bin/tailscale');
    h.execSyncMock = vi.fn((cmd) => {
      if (cmd.includes('funnel --bg reset')) return '';
      if (cmd.includes('status --json'))
        return JSON.stringify({ Self: { DNSName: 'box.tail1234.ts.net.' } });
      throw new Error(`unexpected: ${cmd}`);
    });
    const child = fakeChild();
    h.spawnMock = vi.fn(() => child);
    const ts = await load();
    const p = ts.startFunnel(20128);
    child.stdout.emit('data', Buffer.from('Available on the internet\n'));
    const res = await p;
    expect(res).toEqual({ tunnelUrl: 'https://box.tail1234.ts.net' }); // trailing dot stripped
    expect(h.spawnMock.mock.calls[0][1]).toEqual(['--socket', SOCKET, 'funnel', '--bg', '20128']);
  });

  it('surfaces the enable URL when Funnel is not enabled on the tailnet', async () => {
    h.exists.add('/usr/bin/tailscale');
    h.execSyncMock = vi.fn(() => {
      throw new Error('no status');
    }); // DNSName probe yields null
    const child = fakeChild();
    h.spawnMock = vi.fn(() => child);
    const ts = await load();
    const p = ts.startFunnel(20128);
    child.stderr.emit('data', Buffer.from('Funnel is not enabled on your tailnet.\n'));
    child.stderr.emit(
      'data',
      Buffer.from('To enable, visit: https://login.tailscale.com/f/funnel?node=x\n')
    );
    const res = await p;
    expect(res).toEqual({
      funnelNotEnabled: true,
      enableUrl: 'https://login.tailscale.com/f/funnel?node=x',
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it('rejects with the collected output when the funnel child exits without a URL', async () => {
    h.exists.add('/usr/bin/tailscale');
    h.execSyncMock = vi.fn(() => {
      throw new Error('no status');
    });
    const child = fakeChild();
    h.spawnMock = vi.fn(() => child);
    const ts = await load();
    const p = ts.startFunnel(20128);
    child.stderr.emit('data', Buffer.from('client version too old\n'));
    child.emit('exit', 1);
    await expect(p).rejects.toThrow(/code 1.*client version too old/s);
  });

  it('throws immediately when tailscale is not installed', async () => {
    const ts = await load();
    await expect(ts.startFunnel(20128)).rejects.toThrow('Tailscale not installed');
    expect(h.spawnMock).not.toHaveBeenCalled();
  });
});

describe('stopFunnel / stopDaemon', () => {
  it('stopFunnel resets the funnel via the custom socket, and no-ops without a binary', async () => {
    h.exists.add('/usr/bin/tailscale');
    h.execSyncMock = vi.fn(() => '');
    let ts = await load();
    ts.stopFunnel();
    expect(h.execSyncMock.mock.calls[0][0]).toContain('funnel --bg reset');
    expect(h.execSyncMock.mock.calls[0][0]).toContain(`--socket ${SOCKET}`);

    vi.resetModules();
    h.exists.clear();
    h.execSyncMock = vi.fn();
    ts = await load();
    ts.stopFunnel();
    expect(h.execSyncMock).not.toHaveBeenCalled();
  });

  it('stopDaemon stops after plain pkill succeeds (pgrep finds nothing)', async () => {
    h.execSyncMock = vi.fn((cmd) => {
      if (cmd.startsWith('pkill')) return '';
      if (cmd.startsWith('pgrep')) throw new Error('no process'); // dead
      throw new Error(`unexpected: ${cmd}`);
    });
    h.exists.add(SOCKET);
    const ts = await load();
    await ts.stopDaemon('pw');
    expect(execWithPassword).not.toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledWith(SOCKET);
  });

  it('stopDaemon escalates to sudo when the daemon survives plain pkill', async () => {
    h.execSyncMock = vi.fn((cmd) => {
      if (cmd.startsWith('pkill')) throw new Error('not permitted'); // root-owned
      if (cmd.startsWith('pgrep')) return '123'; // still alive
      throw new Error(`unexpected: ${cmd}`);
    });
    const ts = await load();
    await ts.stopDaemon('pw');
    expect(execWithPassword).toHaveBeenCalledWith('pkill -x tailscaled', 'pw');
  });
});

describe('provisionCert', () => {
  it('requests the cert into DATA_DIR/tailscale/certs and never throws on failure', async () => {
    h.exists.add('/usr/bin/tailscale');
    h.execAsyncImpl = vi.fn(async (cmd) => {
      if (!cmd.includes(' cert ')) return { stdout: '', stderr: '' }; // `which tailscale` probe
      expect(cmd).toContain(`--cert-file "${path.join(TS_DIR, 'certs', 'box.ts.net.crt')}"`);
      expect(cmd).toContain(`--key-file "${path.join(TS_DIR, 'certs', 'box.ts.net.key')}"`);
      expect(cmd).toContain('"box.ts.net"');
      return { stdout: '', stderr: '' };
    });
    const ts = await load();
    await ts.provisionCert('box.ts.net');
    // getTailscaleBin() probes with `which tailscale` first, so the cert call is the last one.
    const certCalls = h.execAsyncImpl.mock.calls.filter(([cmd]) => cmd.includes(' cert '));
    expect(certCalls).toHaveLength(1);

    h.execAsyncImpl = vi.fn(() => Promise.reject(new Error('cert denied')));
    await expect(ts.provisionCert('box.ts.net')).resolves.toBeUndefined(); // best-effort
  });
});
