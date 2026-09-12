import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { openSync, closeSync, existsSync, readlinkSync, realpathSync } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceManifest } from '../../../scripts/redesign-preview.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = '(version 1)(allow default)(deny network*)';
// iproute2 sits in /usr/sbin on Debian-family hosts and /sbin elsewhere; the
// namespace shell runs with a fixed PATH, so resolve the absolute path once.
const ipBinary = ['/usr/sbin/ip', '/sbin/ip', '/bin/ip'].find(path => existsSync(path)) || 'ip';
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });

async function retainArtifact(root) {
  const dist = join(root, 'artifact');
  await mkdir(dist, { mode: 0o700 });
  await cp(join(project, '.next/standalone'), join(dist, 'standalone'), { recursive: true, dereference: true });
  await cp(join(project, '.next/BUILD_ID'), join(dist, 'BUILD_ID'));
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push([path.slice(dist.length + 1), createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  }
  await walk(dist);
  files.sort(([a], [b]) => a.localeCompare(b));
  const artifact = { dist, fileCount: files.length, artifactManifestHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files: Object.fromEntries(files) };
  await save(join(root, 'artifact-manifest.json'), artifact);
  return { dist, artifactManifestHash: artifact.artifactManifestHash, artifactFiles: artifact.fileCount };
}

// Linux has no sandbox-exec. The equivalent process-family network denial here
// is a user+network namespace, which is the same boundary the canonical offline
// runner requires (scripts/qa/run-offline-tests.mjs:143-155): a namespace that
// differs from the parent, `lo` as the only interface, and `lo` brought up so
// the build's own loopback still works. Reuse that contract rather than invent
// a second, weaker one. A probe inside the namespace must fail to leave it.
const netnsPrefix = ['--user', '--map-root-user', '--net', '--'];

export function linuxNetworkIsolation() {
  const parent = readlinkSync('/proc/self/ns/net');
  const probe = [
    'set -eu',
    '[ "$(readlink /proc/self/ns/net)" != "$TOKENPROXY_BUILD_PARENT_NETNS" ]',
    '[ "$(awk -F: \'NR > 2 { gsub(/ /, "", $1); print $1 }\' /proc/net/dev)" = lo ]',
    `${ipBinary} link set lo up`,
    // Egress must be unreachable and loopback must work, so assert both rather
    // than only the denial: a namespace with lo down would pass a denial-only
    // probe and then fail every build that talks to its own port.
    `exec "$@" -e ${JSON.stringify(
      'const net=require("node:net");'
      + 'const egress=net.connect(9,"8.8.8.8");'
      + 'egress.on("connect",()=>process.exit(11));'
      + 'egress.on("error",e=>{if(!["ENETUNREACH","EHOSTUNREACH","ENETDOWN"].includes(e.code))process.exit(12);'
      + 'const s=net.createServer(()=>{});s.listen(0,"127.0.0.1",()=>{const c=net.connect(s.address().port,"127.0.0.1");'
      + 'c.on("connect",()=>{s.close();process.exit(0)});c.on("error",()=>process.exit(13))})});'
      + 'setTimeout(()=>process.exit(14),4000).unref();',
    )}`,
  ].join(' && ');
  execFileSync('/usr/bin/unshare', [...netnsPrefix, '/bin/sh', '-c', probe, 'tokenproxy-build-probe', process.execPath], {
    stdio: 'pipe',
    timeout: 15000,
    env: { PATH: `${dirname(process.execPath)}:/usr/sbin:/usr/bin:/bin`, TOKENPROXY_BUILD_PARENT_NETNS: parent },
  });
  return {
    networkPolicy: 'Linux user+network namespace inherited by all build children; loopback-only, no route off lo',
    probe: 'egress to 8.8.8.8:9 rejected ENETUNREACH and owned loopback connect accepted inside the namespace',
    parentNetworkNamespace: parent,
  };
}

export function verifyBuildIsolation() {
  if (process.platform === 'darwin') {
    const probe = 'const s=require("node:net").connect(9,"127.0.0.1");s.on("connect",()=>process.exit(1));s.on("error",e=>process.exit(e.code==="EPERM"?0:1));setTimeout(()=>process.exit(1),2000).unref();';
    execFileSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', probe], { stdio: 'pipe', timeout: 5000 });
    return { networkPolicy: 'macOS deny network* inherited by all build children', probe: 'loopback connect rejected with EPERM' };
  }
  if (process.platform === 'linux') return linuxNetworkIsolation();
  throw new Error(`This build wrapper requires macOS sandbox-exec or Linux network namespaces; no unguarded fallback on ${process.platform}`);
}

// The sandbox command for the build itself, derived from the isolation this
// platform actually proved. Never a bare spawn: an unverified platform threw
// above, so there is no path here without a proven boundary.
function sandboxedBuild(isolation, root) {
  const npm = join(dirname(process.execPath), 'npm');
  if (process.platform === 'darwin') return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, npm, 'run', 'build'] };
  return {
    command: '/usr/bin/unshare',
    args: [...netnsPrefix, '/bin/sh', '-c', [
      'set -eu',
      '[ "$(readlink /proc/self/ns/net)" != "$TOKENPROXY_BUILD_PARENT_NETNS" ]',
      '[ "$(awk -F: \'NR > 2 { gsub(/ /, "", $1); print $1 }\' /proc/net/dev)" = lo ]',
      `${ipBinary} link set lo up`,
      'exec "$@"',
    ].join(' && '), 'tokenproxy-build', npm, 'run', 'build'],
    extraEnv: { TOKENPROXY_BUILD_PARENT_NETNS: isolation.parentNetworkNamespace, PATH: `${dirname(process.execPath)}:/usr/sbin:/usr/bin:/bin` },
    root,
  };
}

export async function buildProduction() {
  const isolation = verifyBuildIsolation();
  // Next loads these implicitly, so an inherited credential file must fail closed.
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    try { await access(join(project, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Isolated build refuses project ${name}; use a clean source checkout`);
  }
  const lock = join(realpathSync(tmpdir()), `tokenproxy-redesign-build-lock-${createHash('sha256').update(project).digest('hex').slice(0, 16)}`);
  await mkdir(lock, { mode: 0o700 });
  let root;
  try {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'tokenproxy-redesign-build-')));
    await save(join(root, 'owner.json'), { kind: 'tokenproxy-redesign-build-v1', root, project, pid: process.pid, createdAt: new Date().toISOString() });
    await mkdir(join(root, 'home'), { mode: 0o700 });
    await mkdir(join(root, 'build-data'), { mode: 0o700 });
    const before = await sourceManifest();
    await save(join(root, 'source-before.json'), before);
    const descriptor = openSync(join(root, 'build.log'), 'a', 0o600);
    let buildExit;
    try {
      const sandbox = sandboxedBuild(isolation, root);
      buildExit = await new Promise((accept, reject) => {
        const child = spawn(sandbox.command, sandbox.args, {
          cwd: project, stdio: ['ignore', descriptor, descriptor],
          // Built from scratch, so no host credential or proxy variable is inherited.
          // XDG paths join HOME inside the disposable root for the same reason.
          env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), TMPDIR: root, XDG_CONFIG_HOME: join(root, 'home', '.config'), XDG_DATA_HOME: join(root, 'home', '.local/share'), XDG_CACHE_HOME: join(root, 'home', '.cache'), XDG_STATE_HOME: join(root, 'home', '.local/state'), NODE_ENV: 'production', TZ: 'UTC', NEXT_TELEMETRY_DISABLED: '1', MODEL_CATALOG_SYNC: 'off', NEXT_PHASE: 'phase-production-build', DATA_DIR: join(root, 'build-data'), TOKENPROXY_BUILD_SHA: before.revision, INITIAL_PASSWORD: randomBytes(24).toString('hex'), JWT_SECRET: randomBytes(32).toString('hex'), DB_ENCRYPTION_KEY: randomBytes(32).toString('hex'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_cache: join(root, 'npm-cache'), ...sandbox.extraEnv },
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => accept(code ?? `signal:${signal}`));
      });
    } finally { closeSync(descriptor); }
    const after = await sourceManifest();
    await save(join(root, 'source-after.json'), after);
    const sourceStable = before.revision === after.revision && before.sourceManifestHash === after.sourceManifestHash;
    const buildId = buildExit === 0 ? (await readFile(join(project, '.next/BUILD_ID'), 'utf8')).trim() : null;
    const artifact = buildExit === 0 && sourceStable ? await retainArtifact(root) : { dist: null };
    const receipt = { root, base: before.revision, sourceManifest: before.sourceManifestHash, sourceStable, buildExit, buildId, ...artifact, dataDir: join(root, 'build-data'), log: join(root, 'build.log'), ...isolation, completedAt: new Date().toISOString() };
    await save(join(root, 'build-receipt.json'), receipt);
    if (buildExit !== 0 || !sourceStable) throw new Error(`Build not accepted; inspect ${join(root, 'build-receipt.json')}`);
    return { ...receipt, receipt: join(root, 'build-receipt.json') };
  } finally { await rmdir(lock); }
}
