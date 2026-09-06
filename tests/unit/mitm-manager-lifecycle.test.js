import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const managerPath = fileURLToPath(new URL('../../src/mitm/manager.js', import.meta.url));
const dnsConfigPath = fileURLToPath(new URL('../../src/mitm/dns/dnsConfig.js', import.meta.url));
const certInstallPath = fileURLToPath(new URL('../../src/mitm/cert/install.js', import.meta.url));

// manager.js is CommonJS and touches the filesystem + child_process at require
// time and at call time (dns/dnsConfig.js, cert/install.js), so — same shape as
// mitm-stop-dns-order-1809.test.js — it is exercised in a fresh child process
// with both dependencies swapped in via require.cache before manager.js loads,
// never through a real sudo/exec/spawn. A guaranteed-dead pid (0x7fffffff, above
// any real pid_max) stands in for "process is gone" the same way
// mitm-stale-handle-1462.test.js does.
function run(body, { dns = {}, cert = {}, files = {}, settingsSeed = {}, platform = 'linux' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tokenproxy-mitm-lifecycle-'));
  try {
    const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const root = ${JSON.stringify(root)};
    process.env.DATA_DIR = root;
    Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
    const cp = require("node:child_process");
    for (const method of ["exec", "execSync", "spawn"]) {
      cp[method] = () => { throw new Error("Unexpected child_process." + method); };
    }
    const events = [];
    const settings = ${JSON.stringify(settingsSeed)};

    const dnsPath = require.resolve(${JSON.stringify(dnsConfigPath)});
    require.cache[dnsPath] = {
      id: dnsPath, filename: dnsPath, loaded: true,
      exports: {
        TOOL_HOSTS: { kiro: ["codewhisperer.example.invalid"] },
        addDNSEntry: async (tool) => {
          events.push("add:" + tool);
          if (${!!dns.addThrows}) throw new Error("add failed");
        },
        removeDNSEntry: async (tool) => { events.push("remove:" + tool); },
        removeAllDNSEntries: async () => { events.push("dns-removed"); },
        removeAllDNSEntriesSync: () => {},
        checkAllDNSStatus: () => (${JSON.stringify(dns.status || {})}),
        isSudoAvailable: () => ${!!dns.sudoAvailable},
        isSudoPasswordRequired: () => ${!!dns.passwordRequired},
        execWithPassword: async () => {},
      },
    };

    const certPath = require.resolve(${JSON.stringify(certInstallPath)});
    require.cache[certPath] = {
      id: certPath, filename: certPath, loaded: true,
      exports: {
        checkCertInstalled: async () => ${!!cert.trusted},
        installCert: async () => { events.push("cert-installed"); if (${!!cert.installThrows}) throw new Error("install failed"); },
        uninstallCert: async () => { events.push("cert-uninstalled"); },
      },
    };

    console.log = () => {};
    console.error = () => {};

    const manager = require(${JSON.stringify(managerPath)});
    manager.initDbHooks(
      async () => settings,
      async (u) => { Object.assign(settings, u); events.push("settings-updated"); }
    );

    const mitmDir = path.join(root, "mitm");
    fs.mkdirSync(mitmDir, { recursive: true });
    if (${!!files.pidAlive}) fs.writeFileSync(path.join(mitmDir, ".mitm.pid"), String(process.pid), "utf8");
    if (${!!files.pidDead}) fs.writeFileSync(path.join(mitmDir, ".mitm.pid"), "2147483647", "utf8");
    if (${!!files.lockAlive}) fs.writeFileSync(path.join(mitmDir, ".mitm.lock"), String(process.pid), "utf8");
    if (${!!files.rootCA}) fs.writeFileSync(path.join(mitmDir, "rootCA.crt"), "fake-cert", "utf8");

    (async () => {
      let out;
      try {
        ${body}
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      process.stdout.write(JSON.stringify({ out, events, settings, pidFileExists: fs.existsSync(path.join(mitmDir, ".mitm.pid")) }));
    })();
  `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('getMitmStatus', () => {
  it('reports running with the live pid from the pid file', () => {
    const { out } = run('out = { ok: true, ...(await manager.getMitmStatus()) };', {
      files: { pidAlive: true },
    });
    expect(out.ok).toBe(true);
    expect(out.running).toBe(true);
    expect(out.certExists).toBe(false);
  });

  it('clears a dead pid file and reports not running', () => {
    const { out, pidFileExists } = run('out = { ok: true, ...(await manager.getMitmStatus()) };', {
      files: { pidDead: true },
    });
    expect(out.running).toBe(false);
    expect(out.pid).toBeNull();
    expect(pidFileExists).toBe(false);
  });
});

describe('enableToolDNS / disableToolDNS', () => {
  it('refuses to enable DNS when the server is not running', () => {
    const { out } = run('out = { ok: true, ...(await manager.enableToolDNS("kiro", null)) };');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not running/i);
  });

  it('adds the DNS entry and persists tool state when running', () => {
    const { out, events, settings } = run(
      'out = { ok: true, ...(await manager.enableToolDNS("kiro", null)) };',
      { files: { pidAlive: true } }
    );
    expect(out.ok).toBe(true);
    expect(events).toContain('add:kiro');
    expect(settings.dnsToolEnabled).toEqual({ kiro: true });
  });

  it('removes the DNS entry and persists tool state regardless of running state', () => {
    const { out, events, settings } = run(
      'out = { ok: true, ...(await manager.disableToolDNS("kiro", null)) };'
    );
    expect(out.ok).toBe(true);
    expect(events).toContain('remove:kiro');
    expect(settings.dnsToolEnabled).toEqual({ kiro: false });
  });
});

describe('trustCert', () => {
  it('refuses when the Root CA has never been generated', () => {
    const { out } = run('out = { ok: true, ...(await manager.trustCert(null) || {}) };');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Root CA not found/);
  });

  it.each([['linux', false], ['darwin', true]])('handles system trust without sudo on %s', (platform, installs) => {
    const { out, events } = run('await manager.trustCert(null); out = { ok: true };', {
      files: { rootCA: true },
      dns: { sudoAvailable: false },
      platform,
    });
    expect(out.ok).toBe(true);
    expect(events.includes('cert-installed')).toBe(installs);
  });

  it('refuses when a sudo password is required and none is available', () => {
    const { out } = run('out = { ok: true, ...(await manager.trustCert(null) || {}) };', {
      files: { rootCA: true },
      dns: { sudoAvailable: true, passwordRequired: true },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Sudo password required/);
  });

  it('installs the cert when sudo is available and no password is required', () => {
    const { out, events } = run('await manager.trustCert(null); out = { ok: true };', {
      files: { rootCA: true },
      dns: { sudoAvailable: true, passwordRequired: false },
    });
    expect(out.ok).toBe(true);
    expect(events).toContain('cert-installed');
  });
});

describe('startServer early branches', () => {
  it('reuses an already-running process found via the pid file', () => {
    const { out, settings } = run(
      'out = { ok: true, ...(await manager.startServer("key", null)) };',
      { files: { pidAlive: true } }
    );
    expect(out.ok).toBe(true);
    expect(out.running).toBe(true);
    expect(settings.mitmEnabled).toBe(true);
  });

  it('refuses a concurrent start while the lock file is held by a live pid', () => {
    const { out } = run('out = { ok: true, ...(await manager.startServer("key", null) || {}) };', {
      files: { lockAlive: true },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/already starting.*lock contention/i);
  });
});

describe('hasDnsPrivilege', () => {
  it('grants privilege when this platform never requires a sudo password', () => {
    const { out } = run('out = { ok: true, value: await manager.hasDnsPrivilege() };', {
      dns: { passwordRequired: false },
    });
    expect(out.value).toBe(true);
  });

  it('denies privilege when a password is required and none is cached or stored', () => {
    const { out } = run('out = { ok: true, value: await manager.hasDnsPrivilege() };', {
      dns: { passwordRequired: true },
    });
    expect(out.value).toBe(false);
  });
});

describe('restoreToolDNS', () => {
  it('logs and continues past a tool whose DNS restore fails, rather than throwing', () => {
    const { out, events } = run('await manager.restoreToolDNS(null); out = { ok: true };', {
      dns: { addThrows: true },
      settingsSeed: { dnsToolEnabled: { kiro: true } },
    });
    expect(out.ok).toBe(true);
    expect(events).toContain('add:kiro');
  });
});
