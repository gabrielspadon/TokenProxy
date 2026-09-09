import { readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The installed native Claude Code binary on this host. The version directory
// is the vendor's own layout; the newest semantic version is the active one.
export function nativeBinary() {
  if (process.env.CLAUDE_NATIVE_BINARY) return process.env.CLAUDE_NATIVE_BINARY;
  const dir = join(homedir(), '.local/share/claude/versions');
  const versions = readdirSync(dir).filter(name => /^\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) throw new Error(`No native Claude Code binary under ${dir}`);
  return join(dir, versions.at(-1));
}

// An OS-level sandbox that denies every network path and masks the private
// home directories the native client would otherwise read (its own config
// directory and the SSH directory). macOS uses sandbox-exec; Linux uses
// bubblewrap with a detached network namespace.
export function nativeSandbox(root) {
  const masked = ['.claude', '.ssh'].map(name => join(homedir(), name));
  if (process.platform === 'darwin') {
    const policy = `(version 1) (allow default) (deny network*) ${masked.map(path => `(deny file-read* (subpath "${path}"))`).join(' ')} (deny process-exec (literal "/usr/bin/security"))`;
    writeFileSync(join(root, 'no-network.sb'), policy);
    return { command: '/usr/bin/sandbox-exec', prefix: ['-f', join(root, 'no-network.sb')], policy, description: 'macOS sandbox-exec: deny network*, private home paths unreadable' };
  }
  if (process.platform === 'linux') {
    const prefix = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--bind', root, root,
      ...masked.flatMap(path => ['--tmpfs', path]), '--unshare-net', '--unshare-pid', '--die-with-parent'];
    return { command: '/usr/bin/bwrap', prefix, policy: prefix.join(' '), description: 'Linux bubblewrap: --unshare-net, private home paths masked by tmpfs' };
  }
  throw new Error(`No supported OS sandbox for native client checks on ${process.platform}`);
}
