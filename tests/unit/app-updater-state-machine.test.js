import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  execSync: vi.fn(),
}));
vi.mock('fs', () => {
  const mocked = {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 1 })),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  };
  return { default: mocked, ...mocked };
});

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import { UPDATER_CONFIG } from '@/shared/constants/config';
import { isUpdateDisabled, killAppProcesses, spawnUpdaterAndExit } from '@/lib/appUpdater.js';

const realPlatform = process.platform;
function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.existsSync.mockReturnValue(false);
  vi.useFakeTimers();
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('isUpdateDisabled (#1563 opt-out)', () => {
  it("is off when the flag is unset, '0', or 'false', on for any other value", () => {
    vi.stubEnv('TOKENPROXY_NO_UPDATE', '');
    expect(isUpdateDisabled()).toBe(false);
    vi.stubEnv('TOKENPROXY_NO_UPDATE', '0');
    expect(isUpdateDisabled()).toBe(false);
    vi.stubEnv('TOKENPROXY_NO_UPDATE', 'false');
    expect(isUpdateDisabled()).toBe(false);
    vi.stubEnv('TOKENPROXY_NO_UPDATE', '1');
    expect(isUpdateDisabled()).toBe(true);
  });
});

describe('killAppProcesses on POSIX', () => {
  it('kills the MITM pid from the pid file and every matching app process, then waits', async () => {
    setPlatform('linux');
    const mitmPidFile = path.join(process.env.HOME || '', '.tokenproxy', 'mitm', '.mitm.pid');
    fs.existsSync.mockImplementation((p) => String(p).endsWith('.mitm.pid') || p === mitmPidFile);
    fs.readFileSync.mockReturnValue('4242\n');
    execSync.mockImplementation((cmd) => {
      if (String(cmd).startsWith('ps aux')) {
        return [
          `user 5001 0.0 0.0 0 0 ? S 0:00 node next-server`,
          `user ${process.pid} 0.0 0.0 0 0 ? S 0:00 node tokenproxy self`,
          `user 5002 0.0 0.0 0 0 ? S 0:00 external-helper`,
          `user 5003 0.0 0.0 0 0 ? S 0:00 unrelated process`,
        ].join('\n');
      }
      return '';
    });

    const done = killAppProcesses();
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    const cmds = execSync.mock.calls.map((c) => String(c[0]));
    expect(cmds.some((c) => c.includes('kill -9 4242'))).toBe(true);
    expect(cmds.some((c) => c.includes('kill -9 5001'))).toBe(true);
    expect(cmds.some((c) => c.includes('kill -9 5002'))).toBe(false);
    // never its own pid, never the unmatched process
    expect(cmds.some((c) => c.includes(`kill -9 ${process.pid}`))).toBe(false);
    expect(cmds.some((c) => c.includes('kill -9 5003'))).toBe(false);
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('falls back to process.kill when sudo kill is refused, and survives ps failure', async () => {
    setPlatform('linux');
    fs.existsSync.mockImplementation((p) => String(p).endsWith('.mitm.pid'));
    fs.readFileSync.mockReturnValue('4242');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    execSync.mockImplementation(() => {
      throw new Error('refused');
    });

    await killAppProcesses();
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
    killSpy.mockRestore();
  });

  it('does nothing when the pid file is absent or holds no pid', async () => {
    setPlatform('linux');
    execSync.mockReturnValue('');
    await killAppProcesses();
    expect(fs.readFileSync).not.toHaveBeenCalled();

    fs.existsSync.mockImplementation((p) => String(p).endsWith('.mitm.pid'));
    fs.readFileSync.mockReturnValue('not-a-pid');
    await killAppProcesses();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('killAppProcesses on Windows', () => {
  it('uses taskkill with the PowerShell fallback and collects node + helper pids', async () => {
    setPlatform('win32');
    vi.stubEnv('APPDATA', 'C:\\Users\\u\\AppData\\Roaming');
    fs.existsSync.mockImplementation((p) => String(p).endsWith('.mitm.pid'));
    fs.readFileSync.mockReturnValue('777');
    execSync.mockImplementation((cmd) => {
      const c = String(cmd);
      if (c.includes('taskkill /F /T /PID 777')) throw new Error('access denied');
      if (c.includes('Win32_Process')) {
        return [
          '"ProcessId","CommandLine"',
          '"9001","node.exe C:\\tokenproxy\\cli.js"',
          '"9002","node.exe other"',
        ].join('\n');
      }
      if (c.includes('Get-Process tray_windows_release')) return '9101\n';
      return '';
    });

    const done = killAppProcesses();
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    const cmds = execSync.mock.calls.map((c) => String(c[0]));
    expect(cmds.some((c) => c.includes('Stop-Process -Id 777'))).toBe(true);
    expect(cmds.some((c) => c.includes('taskkill /F /PID 9001'))).toBe(true);
    expect(cmds.some((c) => c.includes('taskkill /F /PID 9101'))).toBe(true);
    expect(cmds.some((c) => c.includes('taskkill /F /PID 9002'))).toBe(false);
  });
});

describe('spawnUpdaterAndExit', () => {
  const updaterScript = '/tmp/fake-updater/updater.js';

  function spawnEnv() {
    return spawn.mock.calls[0][2].env;
  }

  beforeEach(() => {
    vi.stubEnv('UPDATER_SCRIPT_PATH', updaterScript);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  it('spawns the detached updater with the full config contract and unrefs it', () => {
    fs.existsSync.mockImplementation((p) => p === updaterScript);
    vi.stubEnv('TRAY_MODE', '');
    vi.stubEnv('TOKENPROXY_CLI_PATH', '');
    vi.stubEnv('PORT', '');

    spawnUpdaterAndExit();

    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    // ensureRuntimeUpdater copies the bundled script into DATA_DIR and spawns that copy
    expect(args).toEqual([path.join(process.env.DATA_DIR, 'runtime', 'updater', 'updater.js')]);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(spawn.mock.results[0].value.unref).toHaveBeenCalled();

    const env = spawnEnv();
    expect(env.UPDATER_PKG_NAME).toBe(UPDATER_CONFIG.npmPackageName);
    expect(env.UPDATER_PORT).toBe(String(UPDATER_CONFIG.statusPort));
    expect(env.UPDATER_APP_PORT).toBe(String(UPDATER_CONFIG.appPort));
    expect(env.UPDATER_RELAUNCH).toBe('1');
    // no CLI path handed down -> package-runner fallback that refuses to fetch
    expect(JSON.parse(env.UPDATER_RELAUNCH_ARGS)).toEqual([
      '--no',
      UPDATER_CONFIG.npmPackageName,
      '--skip-update',
    ]);
  });

  it("relaunches the launcher's own path when it exists (#2186) and honors the live PORT (#2575)", () => {
    const cliPath = '/opt/tokenproxy/cli.js';
    fs.existsSync.mockImplementation((p) => p === updaterScript || p === cliPath);
    vi.stubEnv('TOKENPROXY_CLI_PATH', cliPath);
    vi.stubEnv('TRAY_MODE', '');
    vi.stubEnv('PORT', '12345');

    spawnUpdaterAndExit('custom-pkg');

    const env = spawnEnv();
    expect(env.UPDATER_PKG_NAME).toBe('custom-pkg');
    expect(env.UPDATER_RELAUNCH_CMD).toBe(process.execPath);
    expect(env.UPDATER_APP_PORT).toBe('12345');
    expect(JSON.parse(env.UPDATER_RELAUNCH_ARGS)).toEqual([cliPath, '--skip-update']);
  });

  it('preserves tray mode in the relaunch arguments', () => {
    fs.existsSync.mockImplementation((p) => p === updaterScript);
    vi.stubEnv('TRAY_MODE', '1');
    vi.stubEnv('TOKENPROXY_CLI_PATH', '');

    spawnUpdaterAndExit();
    expect(JSON.parse(spawnEnv().UPDATER_RELAUNCH_ARGS)).toContain('--tray');
  });

  it('copies the bundled updater into DATA_DIR runtime so npm -g can overwrite node_modules', () => {
    const runtimePath = path.join(process.env.DATA_DIR, 'runtime', 'updater', 'updater.js');
    fs.existsSync.mockImplementation((p) => p === updaterScript);
    vi.stubEnv('TOKENPROXY_CLI_PATH', '');

    spawnUpdaterAndExit();
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(runtimePath), { recursive: true });
    expect(fs.copyFileSync).toHaveBeenCalledWith(updaterScript, runtimePath);
    expect(spawn.mock.calls[0][1]).toEqual([runtimePath]);
  });

  it('reuses an existing runtime copy of the same size instead of recopying', () => {
    const runtimePath = path.join(process.env.DATA_DIR, 'runtime', 'updater', 'updater.js');
    fs.existsSync.mockImplementation((p) => p === updaterScript || p === runtimePath);
    fs.statSync.mockReturnValue({ size: 42 });
    vi.stubEnv('TOKENPROXY_CLI_PATH', '');

    spawnUpdaterAndExit();
    expect(fs.copyFileSync).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][1]).toEqual([runtimePath]);
  });

  it('falls back to cwd-relative updater paths when no override is set', () => {
    vi.stubEnv('UPDATER_SCRIPT_PATH', '');
    const fromCwd = path.join(process.cwd(), 'src', 'lib', 'updater', 'updater.js');
    fs.existsSync.mockImplementation((p) => p === fromCwd);
    vi.stubEnv('TOKENPROXY_CLI_PATH', '');

    spawnUpdaterAndExit();
    // ensureRuntimeUpdater copies it into DATA_DIR; the source must be the cwd path
    expect(fs.copyFileSync.mock.calls[0][0]).toBe(fromCwd);
  });

  it('schedules the server exit after the configured delay', () => {
    fs.existsSync.mockImplementation((p) => p === updaterScript);
    vi.stubEnv('TOKENPROXY_CLI_PATH', '');

    spawnUpdaterAndExit();
    expect(process.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(UPDATER_CONFIG.exitDelayMs + 1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
