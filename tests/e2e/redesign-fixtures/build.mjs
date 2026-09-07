import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { openSync, closeSync, realpathSync } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceManifest } from '../../../scripts/redesign-preview.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = '(version 1)(allow default)(deny network*)';
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

export function verifyBuildIsolation() {
  if (process.platform !== 'darwin') throw new Error('This build wrapper requires macOS sandbox-exec; no unguarded fallback');
  const probe = 'const s=require("node:net").connect(9,"127.0.0.1");s.on("connect",()=>process.exit(1));s.on("error",e=>process.exit(e.code==="EPERM"?0:1));setTimeout(()=>process.exit(1),2000).unref();';
  execFileSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', probe], { stdio: 'pipe', timeout: 5000 });
  return { networkPolicy: 'macOS deny network* inherited by all build children', probe: 'loopback connect rejected with EPERM' };
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
      buildExit = await new Promise((accept, reject) => {
        const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, join(dirname(process.execPath), 'npm'), 'run', 'build'], {
          cwd: project, stdio: ['ignore', descriptor, descriptor],
          env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), TMPDIR: root, NODE_ENV: 'production', TZ: 'UTC', NEXT_TELEMETRY_DISABLED: '1', MODEL_CATALOG_SYNC: 'off', NEXT_PHASE: 'phase-production-build', DATA_DIR: join(root, 'build-data'), TOKENPROXY_BUILD_SHA: before.revision, INITIAL_PASSWORD: randomBytes(24).toString('hex'), JWT_SECRET: randomBytes(32).toString('hex'), DB_ENCRYPTION_KEY: randomBytes(32).toString('hex'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
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
