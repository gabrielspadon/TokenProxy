// pxpipe/install.js contracts with child_process mocked: npm discovery,
// install-info detection on disk, the serialized install run and its failure
// modes, and the install log tail. All fs writes land in this file's isolated
// DATA_DIR (setup-isolate-data-dir.js), so real fs is safe and no system path
// is touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

const { execSync, spawn } = await import('child_process');
const {
  PXPIPE_DIR,
  PXPIPE_PACKAGE,
  packageRoot,
  libraryEntry,
  findNpm,
  getInstallInfo,
  isInstalling,
  installPxpipe,
  getInstallLogTail,
} = await import('../../src/lib/pxpipe/install.js');

// A fake npm child the exit of which the test controls.
function fakeChild() {
  const child = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function installPackageOnDisk(version = '1.2.3') {
  const root = packageRoot();
  fs.mkdirSync(path.dirname(libraryEntry()), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: PXPIPE_PACKAGE, version })
  );
  fs.writeFileSync(libraryEntry(), '// stub');
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(PXPIPE_DIR, { recursive: true, force: true });
});

describe('path shape', () => {
  it('PXPIPE_DIR sits inside the isolated DATA_DIR and the entry sits inside packageRoot', () => {
    expect(PXPIPE_DIR.startsWith(process.env.DATA_DIR)).toBe(true);
    expect(packageRoot()).toBe(path.join(PXPIPE_DIR, 'node_modules', PXPIPE_PACKAGE));
    expect(libraryEntry().startsWith(packageRoot())).toBe(true);
  });
});

describe('findNpm', () => {
  it('returns the first line of which/where output, trimmed', () => {
    execSync.mockReturnValue(Buffer.from('/usr/bin/npm\n/other/npm\n'));
    expect(findNpm()).toBe('/usr/bin/npm');
  });

  it('returns null when the lookup produces nothing or throws', () => {
    execSync.mockReturnValue(Buffer.from('  \n'));
    expect(findNpm()).toBeNull();
    execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(findNpm()).toBeNull();
  });
});

describe('getInstallInfo', () => {
  it('reports not installed when the package or its entry is absent', () => {
    expect(getInstallInfo()).toEqual({ installed: false, version: null, path: null });
    // package.json alone is not enough: the library entry must exist too.
    fs.mkdirSync(packageRoot(), { recursive: true });
    fs.writeFileSync(path.join(packageRoot(), 'package.json'), JSON.stringify({ version: '9' }));
    expect(getInstallInfo().installed).toBe(false);
  });

  it('reports installed with the package version when both files exist', () => {
    installPackageOnDisk('2.0.1');
    expect(getInstallInfo()).toEqual({ installed: true, version: '2.0.1', path: packageRoot() });
  });

  it('fails closed on an unreadable package.json', () => {
    installPackageOnDisk();
    fs.writeFileSync(path.join(packageRoot(), 'package.json'), '{not json');
    expect(getInstallInfo()).toEqual({ installed: false, version: null, path: null });
  });
});

describe('installPxpipe', () => {
  it('rejects with NPM_NOT_FOUND when npm is absent', async () => {
    execSync.mockImplementation(() => {
      throw new Error('nope');
    });
    await expect(installPxpipe()).rejects.toMatchObject({ code: 'NPM_NOT_FOUND' });
    expect(isInstalling()).toBe(false);
  });

  it('serializes concurrent calls, writes the host package.json and log, and resolves install info on exit 0', async () => {
    execSync.mockReturnValue(Buffer.from('/usr/bin/npm\n'));
    const child = fakeChild();
    spawn.mockReturnValue(child);

    expect(isInstalling()).toBe(false);
    const p1 = installPxpipe();
    const p2 = installPxpipe();
    expect(p2).toBe(p1); // concurrent calls await the same run
    expect(isInstalling()).toBe(true);

    // The spawned command installs the package with npm into PXPIPE_DIR.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('/usr/bin/npm');
    expect(args).toContain('install');
    expect(args.some((a) => a.startsWith(PXPIPE_PACKAGE))).toBe(true);
    expect(opts.cwd).toBe(PXPIPE_DIR);
    expect(JSON.parse(fs.readFileSync(path.join(PXPIPE_DIR, 'package.json'), 'utf8')).private).toBe(
      true
    );

    installPackageOnDisk('3.1.4'); // what a successful npm run would leave behind
    child.emit('exit', 0);
    await expect(p1).resolves.toMatchObject({ installed: true, version: '3.1.4' });
    expect(isInstalling()).toBe(false);
    expect(getInstallLogTail()).toContain(`npm install ${PXPIPE_PACKAGE}@latest`);
  });

  it('rejects when npm exits non-zero', async () => {
    execSync.mockReturnValue(Buffer.from('/usr/bin/npm\n'));
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const p = installPxpipe();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.emit('exit', 7);
    await expect(p).rejects.toThrow(/exited with code 7/);
    expect(isInstalling()).toBe(false);
  });

  it('rejects when the spawn itself errors', async () => {
    execSync.mockReturnValue(Buffer.from('/usr/bin/npm\n'));
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const p = installPxpipe();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.emit('error', new Error('EACCES'));
    await expect(p).rejects.toThrow('EACCES');
  });

  it('rejects when npm exits 0 but the package never materialized', async () => {
    execSync.mockReturnValue(Buffer.from('/usr/bin/npm\n'));
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const p = installPxpipe();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.emit('exit', 0);
    await expect(p).rejects.toThrow(/package is missing/);
  });
});

describe('getInstallLogTail', () => {
  it('returns "" with no log and the last N non-empty lines with one', () => {
    expect(getInstallLogTail()).toBe('');
    fs.mkdirSync(PXPIPE_DIR, { recursive: true });
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    fs.writeFileSync(path.join(PXPIPE_DIR, 'install.log'), lines.join('\n') + '\n\n');
    expect(getInstallLogTail(3)).toBe('line-7\nline-8\nline-9');
    expect(getInstallLogTail()).toBe(lines.join('\n'));
  });
});
