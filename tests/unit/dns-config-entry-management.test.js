// src/mitm/dns/dnsConfig.js — hosts-file entry management on POSIX.
// A wrong line written here redirects a tool's traffic to a dead loopback (or
// fails to redirect it at all, silently bypassing MITM usage tracking).
//
// dnsConfig is CJS and destructures `spawn`/`exec`/`execSync` from the builtin
// at import time, so vi.mock("child_process") never reaches it (verified: the
// factory mock left the real spawn in place and a run executed a real
// `sudo tee /etc/hosts`). vi.spyOn on the shared builtin exports object DOES
// reach it, provided the spies exist before the module is imported. Nothing
// here touches the real /etc/hosts: reads are faked, writes intercepted,
// spawn/exec/execSync fully mocked.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import cp from 'node:child_process';
import fs from 'node:fs';

const HOSTS = '/etc/hosts';
const realReadFileSync = fs.readFileSync.bind(fs);
const realExistsSync = fs.existsSync.bind(fs);

const spawnSpy = vi.spyOn(cp, 'spawn');
const execSpy = vi.spyOn(cp, 'exec');
const execSyncSpy = vi.spyOn(cp, 'execSync');
const readSpy = vi.spyOn(fs, 'readFileSync');
const writeSpy = vi.spyOn(fs, 'writeFileSync');
const existsSpy = vi.spyOn(fs, 'existsSync');

let hostsContent; // what fs.readFileSync("/etc/hosts") returns; Error instance = throw
let hostsWrites; // captured writeFileSync calls against /etc/hosts

function fakeChild({ code = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    written: '',
    write(d) {
      this.written += d;
    },
    end: vi.fn(),
  };
  process.nextTick(() => {
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code);
  });
  return child;
}

const HOSTS_HEADER = '127.0.0.1 localhost\n::1 localhost\n';

let dns;
beforeEach(async () => {
  hostsContent = HOSTS_HEADER;
  hostsWrites = [];
  spawnSpy.mockReset().mockImplementation(() => fakeChild());
  execSpy.mockReset().mockImplementation((cmd, opts, cb) => {
    (typeof opts === 'function' ? opts : cb)?.(null, '', '');
  });
  execSyncSpy.mockReset().mockReturnValue(''); // `command -v sudo` succeeds → sudo path
  readSpy.mockReset().mockImplementation((p, ...rest) => {
    if (String(p) !== HOSTS) return realReadFileSync(p, ...rest);
    if (hostsContent instanceof Error) throw hostsContent;
    return hostsContent;
  });
  writeSpy.mockReset().mockImplementation((p, data, ...rest) => {
    if (String(p) === HOSTS) {
      hostsWrites.push(data);
      return;
    }
    throw new Error(`unexpected writeFileSync in dnsConfig test: ${p}`);
  });
  existsSpy
    .mockReset()
    .mockImplementation((p) =>
      String(p) === HOSTS ? !(hostsContent instanceof Error) : realExistsSync(p)
    );
  vi.resetModules();
  dns = await import('@/mitm/dns/dnsConfig.js');
});
afterAll(() => vi.restoreAllMocks());

describe('execWithPassword', () => {
  it('pipes the password to `sudo -S sh -c <cmd>` and resolves stdout', async () => {
    const child = fakeChild();
    spawnSpy.mockReturnValueOnce(child);
    await dns.execWithPassword('echo hi', 's3cret');
    expect(spawnSpy).toHaveBeenCalledWith(
      'sudo',
      ['-S', 'sh', '-c', 'echo hi'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
    expect(child.stdin.written).toBe('s3cret\n');
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("rejects with the child's stderr on nonzero exit", async () => {
    spawnSpy.mockReturnValueOnce(fakeChild({ code: 1, stderr: 'Sorry, try again.\n' }));
    await expect(dns.execWithPassword('true', 'bad')).rejects.toThrow(/Sorry, try again/);
  });

  it('rejects with the exit code when the child wrote nothing', async () => {
    spawnSpy.mockReturnValueOnce(fakeChild({ code: 7 }));
    await expect(dns.execWithPassword('true', 'x')).rejects.toThrow('Exit code 7');
  });

  it('falls back to plain sh (no password on stdin) when sudo is absent', async () => {
    execSyncSpy.mockImplementation((cmd) => {
      if (String(cmd).includes('sudo')) throw new Error('not found');
      return '';
    });
    const child = fakeChild();
    spawnSpy.mockReturnValueOnce(child);
    await dns.execWithPassword('id', 'ignored');
    expect(spawnSpy).toHaveBeenCalledWith(
      'sh',
      ['-c', 'id'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(child.stdin.written).toBe(''); // password must never reach a non-sudo shell
  });
});

describe('checkAllDNSStatus', () => {
  it('reports a tool active only when every one of its hosts is present', () => {
    hostsContent = `${HOSTS_HEADER}127.0.0.1 daily-cloudcode-pa.googleapis.com\n127.0.0.1 cloudcode-pa.googleapis.com\n127.0.0.1 api2.cursor.sh\n`;
    const status = dns.checkAllDNSStatus();
    expect(status.antigravity).toBe(true);
    expect(status.cursor).toBe(true);
    expect(status.copilot).toBe(false);
    expect(status.kiro).toBe(false);
  });

  it('reports every tool inactive when the hosts file is unreadable', () => {
    hostsContent = new Error('EACCES');
    const status = dns.checkAllDNSStatus();
    expect(Object.values(status).every((v) => v === false)).toBe(true);
    expect(Object.keys(status).sort()).toEqual(Object.keys(dns.TOOL_HOSTS).sort());
  });
});

describe('addDNSEntry', () => {
  it('throws on an unknown tool without touching anything', async () => {
    await expect(dns.addDNSEntry('nonsense', 'pw')).rejects.toThrow('Unknown tool: nonsense');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('appends one 127.0.0.1 line per missing host and flushes DNS', async () => {
    await dns.addDNSEntry('cursor', 'pw');
    // Call 1: tee the new hosts content. Call 2: flush caches.
    expect(spawnSpy).toHaveBeenCalledTimes(2);
    const teeCmd = spawnSpy.mock.calls[0][1][3];
    expect(teeCmd).toContain('tee /etc/hosts');
    expect(teeCmd).toContain('127.0.0.1 api2.cursor.sh');
    expect(teeCmd).toContain('127.0.0.1 localhost'); // pre-existing content preserved
    const flushCmd = spawnSpy.mock.calls[1][1][3];
    expect(flushCmd).toContain('resolvectl flush-caches');
  });

  it('is idempotent: no child process when every host is already present', async () => {
    hostsContent = `${HOSTS_HEADER}127.0.0.1 api2.cursor.sh\n`;
    await dns.addDNSEntry('cursor', 'pw');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('maps a rejected sudo password onto an actionable message', async () => {
    spawnSpy.mockReturnValueOnce(
      fakeChild({ code: 1, stderr: 'sudo: 1 incorrect password attempt\n' })
    );
    await expect(dns.addDNSEntry('cursor', 'wrong')).rejects.toThrow('Wrong sudo password');
  });

  // SUSPECTED BUG (pinned, not fixed): checkDNSEntry() matches by substring.
  // "cloudcode-pa.googleapis.com" is a substring of the line
  // "127.0.0.1 daily-cloudcode-pa.googleapis.com", so when only the daily-
  // host is present, the second antigravity host is reported as already added
  // and never written. Traffic to cloudcode-pa.googleapis.com then bypasses
  // MITM entirely — untracked usage. This test pins the CURRENT (buggy)
  // behavior so a fix will flip it visibly.
  it('pins the substring-match gap: a partial antigravity entry blocks the missing host', async () => {
    hostsContent = `${HOSTS_HEADER}127.0.0.1 daily-cloudcode-pa.googleapis.com\n`;
    await dns.addDNSEntry('antigravity', 'pw');
    // Correct behavior would spawn tee to add cloudcode-pa.googleapis.com.
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('removeDNSEntry', () => {
  it("filters the tool's lines out and flushes DNS", async () => {
    hostsContent = `${HOSTS_HEADER}127.0.0.1 api2.cursor.sh\n`;
    await dns.removeDNSEntry('cursor', 'pw');
    expect(spawnSpy).toHaveBeenCalledTimes(2);
    const teeCmd = spawnSpy.mock.calls[0][1][3];
    expect(teeCmd).toContain('tee /etc/hosts');
    expect(teeCmd).not.toContain('api2.cursor.sh');
    expect(teeCmd).toContain('127.0.0.1 localhost');
  });

  it('is idempotent: no child process when nothing matches', async () => {
    await dns.removeDNSEntry('cursor', 'pw');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('throws on an unknown tool', async () => {
    await expect(dns.removeDNSEntry('nope', 'pw')).rejects.toThrow('Unknown tool: nope');
  });
});

describe('removeAllDNSEntries', () => {
  it("keeps going when one tool's removal fails", async () => {
    hostsContent =
      `${HOSTS_HEADER}` +
      Object.values(dns.TOOL_HOSTS)
        .flat()
        .map((h) => `127.0.0.1 ${h}`)
        .join('\n') +
      '\n';
    let call = 0;
    spawnSpy.mockImplementation(() => fakeChild(call++ === 0 ? { code: 1, stderr: 'boom' } : {}));
    await expect(dns.removeAllDNSEntries('pw')).resolves.toBeUndefined();
    // First tool fails at its tee; the remaining tools still get their tee+flush.
    expect(spawnSpy.mock.calls.length).toBeGreaterThanOrEqual(Object.keys(dns.TOOL_HOSTS).length);
  });
});

describe('removeAllDNSEntriesSync', () => {
  it('rewrites the hosts file without any tool host and flushes synchronously', () => {
    const allHosts = Object.values(dns.TOOL_HOSTS).flat();
    hostsContent = `${HOSTS_HEADER}` + allHosts.map((h) => `127.0.0.1 ${h}`).join('\n') + '\n';
    dns.removeAllDNSEntriesSync();
    expect(hostsWrites).toHaveLength(1);
    const written = hostsWrites[0];
    for (const h of allHosts) expect(written).not.toContain(h);
    expect(written).toContain('127.0.0.1 localhost');
    expect(written.endsWith('\n')).toBe(true);
    expect(
      execSyncSpy.mock.calls.some(([c]) => String(c).includes('resolvectl flush-caches'))
    ).toBe(true);
  });

  it('writes nothing when the file already carries no tool host', () => {
    dns.removeAllDNSEntriesSync();
    expect(hostsWrites).toHaveLength(0);
  });

  it('is silent when the hosts file does not exist (shutdown path)', () => {
    hostsContent = new Error('ENOENT');
    expect(() => dns.removeAllDNSEntriesSync()).not.toThrow();
    expect(hostsWrites).toHaveLength(0);
  });
});
