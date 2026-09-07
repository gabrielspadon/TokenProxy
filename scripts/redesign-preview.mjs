import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { CLOCK, VERSION, SCENARIOS } from '../tests/e2e/redesign-fixtures/catalog.mjs';
import { seed } from '../tests/e2e/redesign-fixtures/seed.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = join(project, 'tests/e2e/redesign-fixtures/guard.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
const kind = 'tokenproxy-redesign-preview-v1';

export async function sourceManifest() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  const paths = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: project, encoding: 'utf8' }).split('\0').filter(path => /^(src|open-sse|public|scripts|tests\/e2e\/redesign-fixtures)\//.test(path) || /^(package(?:-lock)?\.json|next\.config\.mjs|custom-server\.js|jsconfig\.json)$/.test(path)))].sort();
  const entries = await Promise.all(paths.map(async path => {
    try { return [path, hash(await readFile(join(project, path)))]; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  const files = Object.fromEntries(entries.filter(entry => entry !== null));
  return { revision, sourceManifestHash: hash(JSON.stringify(files)), files };
}

async function owned(root) {
  const canonical = realpathSync(root);
  const marker = await json(join(canonical, 'owner.json'));
  if (marker.kind !== kind || marker.root !== canonical || !canonical.startsWith(`${realpathSync(tmpdir())}/tokenproxy-redesign-`)) throw new Error('Refusing a directory not created by this launcher');
  return marker;
}

async function prepare(scenario, mode = 'production') {
  if (!SCENARIOS[scenario]?.persistence) throw new Error('Use a retained-schema catalog scenario; operator is browser-only');
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'tokenproxy-redesign-')));
  const runId = randomBytes(12).toString('hex');
  const clock = mode === 'dev' ? new Date(Math.floor(Date.now() / 60000) * 60000).toISOString() : CLOCK;
  await save(join(root, 'owner.json'), { kind, runId, root, realHome: homedir(), createdAt: new Date().toISOString() });
  await mkdir(join(root, 'home'), { mode: 0o700 });
  await save(join(root, 'preview-auth.json'), { syntheticOnly: 'redesign-fixture', capturedAt: clock, ownerToken: randomBytes(32).toString('hex'), initialPassword: randomBytes(24).toString('hex'), jwtSecret: randomBytes(32).toString('hex'), peerToken: randomBytes(32).toString('hex'), dbEncryptionKey: randomBytes(32).toString('hex') });
  await seed(root, scenario, { clock });
  await save(join(root, 'source-manifest.json'), await sourceManifest());
  return { root, runId, scenario, fixtureVersion: VERSION, clock };
}

function availablePort(preferred = 0) {
  if (!Number.isInteger(preferred) || preferred < 0 || preferred > 65535) throw new Error('Port must be an integer from 0 to 65535');
  return new Promise((accept, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(preferred, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : accept(port)); });
  });
}

async function identity(root, method = 'GET', pathname = '/__redesign_owner') {
  const owner = await owned(root);
  const receipt = await json(join(root, 'process.json'));
  const auth = await json(join(root, 'preview-auth.json'));
  if (receipt.runId !== owner.runId || receipt.root !== owner.root || !Number.isInteger(receipt.port) || receipt.port < 1 || receipt.port > 65535) throw new Error('Preview ownership receipt mismatch');
  const response = await fetch(`http://127.0.0.1:${receipt.port}${pathname}`, { method, headers: { 'x-redesign-owner': auth.ownerToken }, signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Preview ownership challenge failed');
  const body = await response.json();
  if (body.runId !== owner.runId || body.pid !== receipt.pid) throw new Error('Preview process identity mismatch');
  return { ...receipt, guard: body.guard };
}

async function start(root, dist, buildReceiptPath, mode = 'production', preferredPort = 0) {
  const owner = await owned(root);
  const previous = await json(join(root, 'process.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previous && !previous.stoppedAt) throw new Error('Run already has a process receipt; stop it or seed a fresh run');
  if (!['production', 'dev'].includes(mode)) throw new Error('Preview mode must be production or dev');
  if (mode === 'dev' && buildReceiptPath) throw new Error('Development source cannot use a production build receipt');
  const cwd = mode === 'dev' ? project : resolve(project, dist, 'standalone');
  if (mode === 'dev') await symlink(realpathSync(join(project, 'node_modules')), join(root, 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (mode === 'production') { await readFile(join(cwd, 'custom-server.js')); await readFile(join(cwd, 'server.js')); }
  const buildId = mode === 'dev' ? null : (await readFile(resolve(project, dist, 'BUILD_ID'), 'utf8')).trim();
  const buildReceipt = buildReceiptPath ? await json(resolve(buildReceiptPath)) : null;
  if (buildReceipt && (buildReceipt.buildExit !== 0 || !/^[a-f\d]{64}$/.test(buildReceipt.sourceManifest) || !/^[a-f\d]{40}$/.test(buildReceipt.base))) throw new Error('Build receipt must report successful build and source revision/hash');
  if (buildReceipt && (buildReceipt.sourceStable === false || buildReceipt.buildId && buildReceipt.buildId !== buildId)) throw new Error('Build receipt source drift or BUILD_ID mismatch');
  if (buildReceipt) await save(join(root, 'build-receipt.json'), { ...buildReceipt, suppliedReceipt: resolve(buildReceiptPath), buildId });
  const port = await availablePort(preferredPort);
  const descriptor = openSync(join(root, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--require', guard, mode === 'dev' ? join(project, 'tests/e2e/redesign-fixtures/dev-server.cjs') : 'custom-server.js'], {
    cwd, detached: true, stdio: ['ignore', descriptor, descriptor],
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), NODE_ENV: mode === 'dev' ? 'development' : 'production', ...(mode === 'dev' ? { NEXT_DIST_DIR: relative(project, join(root, 'next-dev')) } : {}), PORT: String(port), HOSTNAME: '127.0.0.1', DATA_DIR: join(root, 'runtime'), TOKENPROXY_PREVIEW_ISOLATED: '1', TOKENPROXY_REDESIGN_ROOT: root, TZ: 'UTC' },
  });
  closeSync(descriptor);
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const source = await json(join(root, 'source-manifest.json'));
  const fixture = await json(join(root, 'fixture-manifest.json'));
  const receipt = { root, runId: owner.runId, pid: child.pid, port, url: `http://127.0.0.1:${port}`, mode, dataDir: join(root, 'runtime'), cwd, dist: mode === 'dev' ? join(root, 'next-dev') : dist, buildId, sourceRevision: buildReceipt?.base || source.revision, sourceManifestHash: buildReceipt?.sourceManifest || source.sourceManifestHash, sourceAttribution: mode === 'dev' ? 'live dev source; seed manifest is baseline, not compiled asset attribution' : buildReceipt ? 'explicit successful build receipt' : 'seed-time source; build provenance must be supplied separately', seedSourceManifestHash: source.sourceManifestHash, startedAt: new Date().toISOString(), fixtureVersion: fixture.version, clock: fixture.capturedAt };
  await save(join(root, 'process.json'), receipt);
  try {
    const readinessAttempts = mode === 'dev' ? 240 : 80;
    for (let attempt = 0; attempt < readinessAttempts; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('Preview exited before readiness; inspect its private server.log');
      try { const live = await identity(root); child.unref(); return live; } catch (error) { if (attempt === readinessAttempts - 1) throw error; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    // This ChildProcess object is from this invocation, never a PID loaded from disk.
    if (child.exitCode === null) child.kill('SIGTERM');
    throw error;
  }
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  const flag = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  if (command === 'catalog') return SCENARIOS;
  if (command === 'build') return (await import('../tests/e2e/redesign-fixtures/build.mjs')).buildProduction();
  if (command === 'build-check') return (await import('../tests/e2e/redesign-fixtures/build.mjs')).verifyBuildIsolation();
  if (command === 'seed') return prepare(flag('--scenario', 'populated'), flag('--mode', 'production'));
  if (command === 'start') {
    const root = flag('--run') || (await prepare(flag('--scenario', 'populated'), flag('--mode', 'production'))).root;
    return start(root, flag('--dist', '.next'), flag('--build-receipt'), flag('--mode', 'production'), Number(flag('--port', 0)));
  }
  if (command === 'status') return identity(flag('--run'));
  if (command === 'recover-stopped') {
    const root = flag('--run');
    const owner = await owned(root);
    const receipt = await json(join(owner.root, 'process.json'));
    if (receipt.runId !== owner.runId || receipt.root !== owner.root || !Number.isInteger(receipt.pid) || receipt.pid < 1) throw new Error('Preview ownership receipt mismatch');
    let absent = false;
    try { process.kill(receipt.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') absent = true; else throw error; }
    if (!absent) throw new Error('Recorded PID still exists; refusing stale-receipt recovery');
    if (!Number.isInteger(receipt.port) || receipt.port < 1 || receipt.port > 65535) throw new Error('Invalid owned preview port');
    await availablePort(receipt.port);
    await save(join(owner.root, 'process.json'), { ...receipt, stoppedAt: new Date().toISOString(), unexpectedExit: true, recoveryEvidence: 'recorded PID absent and original loopback port available; no signal sent' });
    return { root: owner.root, runId: owner.runId, stopped: true, unexpectedExit: true, recoveryEvidence: 'recorded PID absent and original loopback port available; no signal sent' };
  }
  if (command === 'stop') {
    const root = flag('--run');
    await identity(root);
    const receipt = await identity(root, 'POST', '/__redesign_stop');
    let exited = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await identity(root); } catch { exited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!exited) throw new Error('Stop accepted but owned listener still responds');
    await save(join(root, 'process.json'), { ...receipt, stoppedAt: new Date().toISOString() });
    return { root, runId: receipt.runId, stopped: true, ownershipEndpointClosed: true };
  }
  if (command === 'capture') {
    const root = flag('--run');
    const live = await identity(root);
    const route = flag('--route');
    const viewport = flag('--viewport');
    const file = flag('--file');
    if (!route?.startsWith('/') || !/^\d+x\d+$/.test(viewport || '') || !file) throw new Error('Capture requires --route /path --viewport WIDTHxHEIGHT --file image.png');
    const receipt = { ...live, ...(live.mode === 'dev' ? { sourceAtCapture: await sourceManifest(), sourceCaptureCaveat: 'Read from the shared live tree; HMR compilation is not an atomic source snapshot.' } : {}), route, viewport, synthetic: true, capturedAt: new Date().toISOString(), image: resolve(file), imageSha256: hash(await readFile(resolve(file))), imageInspected: false };
    await save(`${resolve(file)}.json`, receipt);
    return receipt;
  }
  return { usage: 'node scripts/redesign-preview.mjs build-check|build; start --mode dev --scenario representative; start --mode production --dist .next --build-receipt /absolute/receipt; status|stop|recover-stopped --run /absolute/run; capture --run /absolute/run --route /dashboard --viewport 1440x900 --file /absolute/image.png; catalog', note: 'Dev compilation writes only into its owned runtime. Production uses an existing standalone build. Both modes block provider effects and keep disposable DATA_DIR.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
