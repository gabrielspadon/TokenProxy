import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, realpathSync, utimesSync } from 'node:fs';
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

// Next's dev bundler resolves its startup promise on Watchpack's FIRST aggregation
// (setup-dev-bundler.js:852) and never re-arms. With Next's aggregateTimeout of 5ms
// (setup-dev-bundler.js:291) that aggregation is routinely partial. Its handler clears
// and repopulates the route sets on every aggregation (setup-dev-bundler.js:325-329),
// so the table is never permanently truncated: it is whatever the LAST aggregation saw,
// and on a quiet tree the startup one is the only aggregation there is. A partial one
// leaves a deep route answering with Next's /_not-found HTML exactly as a nonexistent
// path does. Touching a watched route file forces a fresh aggregation, repairing the
// table in place. That touch is an mtime write to the shared tracked tree: it changes no
// content, so source-manifest provenance is unaffected, but every other watcher on this
// tree recompiles, which is why this launcher owns the touch rather than each caller. That
// recompile is not by itself a wedge: three concurrent two-preview starts on this host all
// reached the canary 405 (attempts 1-2), because each preview compiles into its own
// NEXT_DIST_DIR and the probe's retry budget absorbs a re-aggregation it did not ask for.
// Prefer one preview at a time anyway, since every extra watcher spends the same CPU twice.
const canaryRoute = '/api/admin/compatibility/runs/00000000-0000-4000-8000-000000000000/cancel';
const canaryFile = join(project, 'src/app/api/admin/compatibility/runs/[id]/cancel/route.js');
// That route exports POST only, so a routed, authenticated GET is Next's auto-implemented
// 405. Assert that positively. Scoring "anything that is not 404 HTML" as ready would
// bless an error page, and the 405 is the only answer that proves the entry resolved.
const canaryRouted = 405;
const canaryAttempts = 10;

// A child killed by a signal keeps `exitCode === null` and reports the signal in
// `signalCode`, so a guard reading exitCode alone treats an OOM-killed preview as
// still starting. That kill is not hypothetical here: rendered-acceptance-run.mjs
// documents a dev server dying on a 4 GB heap. Read both.
const childDead = child => child.exitCode !== null || child.signalCode !== null;
const childDeath = child => child.signalCode ? `killed by ${child.signalCode}` : `exited with code ${child.exitCode}`;

async function devRouteTableReady(root, receipt, child) {
  if (!existsSync(canaryFile)) throw new Error(`Dev preview route-table canary is missing; update canaryFile/canaryRoute together: ${canaryFile}`);
  // Assert the canary still exports POST only. The 405 this probe waits for is
  // Next's auto-implemented answer for an unexported method; the day someone adds
  // `export function GET` here, every dev start burns the full retry budget and
  // then reports a bundler fault that never happened.
  const canarySource = await readFile(canaryFile, 'utf8');
  if (/^\s*export\s+(async\s+)?function\s+GET\b/m.test(canarySource) || /^\s*export\s+const\s+GET\b/m.test(canarySource)) throw new Error(`Dev preview canary now exports GET, so a routed GET no longer answers ${canaryRouted}; pick another method-free route or change canaryRouted: ${canaryFile}`);
  const auth = await json(join(root, 'preview-auth.json'));
  const base = `http://127.0.0.1:${receipt.port}`;
  let last = 'no attempt completed';
  for (let attempt = 0; attempt < canaryAttempts; attempt++) {
    // Without this the probe spends its whole budget interrogating a corpse and
    // then blames the route table, which is the one diagnosis that sends the
    // reader to the bundler instead of to server.log.
    if (childDead(child)) throw new Error(`Preview died during the route-table probe (${childDeath(child)}); inspect its private server.log`);
    // Login resolves through the same truncated table as the canary, and a cold compile
    // can outrun any single timeout, so every failure in here is an observation to retry.
    // Tearing down a healthy preview because its route table is not repaired YET is the
    // one outcome this probe must never produce.
    try {
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: auth.initialPassword }), signal: AbortSignal.timeout(60000) });
      await login.arrayBuffer();
      if (!login.ok) last = `login answered ${login.status}`;
      else {
        const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        const response = await fetch(`${base}${canaryRoute}`, { headers: { cookie }, signal: AbortSignal.timeout(60000) });
        await response.arrayBuffer();
        if (response.status === canaryRouted) return { attempts: attempt + 1, canaryRoute, canaryStatus: response.status, scope: 'one deep dynamic route resolved; not an assertion that every route aggregated' };
        last = `canary answered ${response.status}`;
      }
    // undici reports a refused connection, a hang-up and a DNS failure all as
    // `TypeError`; the discriminating value is on the cause. Keep both, because
    // this string is the entire content of the terminal error below.
    } catch (error) { last = `canary request failed with ${error.cause?.code ?? error.name}`; }
    if (attempt === canaryAttempts - 1) break;
    // Removing the canary mid-probe must not become a preview kill either.
    try { const now = new Date(); utimesSync(canaryFile, now, now); }
    catch (error) { last = `${last}; forced re-aggregation failed with ${error.code || error.name}`; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Dev preview route table stayed truncated after forced re-aggregation (${last})`);
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
  // `receipt.buildId && …` would let a receipt with the field absent take the permissive path,
  // which is the wrong failure direction for the one check that ties a receipt to this build.
  // build.mjs:74-76 always populates it for a successful build, so requiring it costs nothing.
  if (buildReceipt && (buildReceipt.sourceStable === false || buildReceipt.buildId !== buildId)) throw new Error('Build receipt source drift or BUILD_ID mismatch');
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
    let ready;
    for (let attempt = 0; attempt < readinessAttempts; attempt++) {
      if (spawnError) throw spawnError;
      if (childDead(child)) throw new Error(`Preview ${childDeath(child)} before readiness; inspect its private server.log`);
      try { ready = await identity(root); break; } catch (error) { if (attempt === readinessAttempts - 1) throw error; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    // The loop leaves only two ways: `break` with `ready` set, or a rethrow on the
    // last attempt. There is no third, so no `if (!ready)` arm is reachable here.
    if (mode !== 'dev') { child.unref(); return ready; }
    const routeTable = await devRouteTableReady(root, ready, child);
    const repaired = { ...receipt, routeTable };
    await save(join(root, 'process.json'), repaired);
    child.unref();
    return { ...ready, routeTable };
  } catch (error) {
    // This ChildProcess object is from this invocation, never a PID loaded from disk.
    if (!childDead(child)) child.kill('SIGTERM');
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
  if (command === 'status') {
    const receipt = await identity(flag('--run'));
    // start() saves the receipt at :174 so the readiness probe has something to challenge, and
    // only rewrites it with routeTable at :189 once a deep dynamic route answered. A status read
    // landing in that window would otherwise report a dev preview as if its route table were
    // proven. verify-preview.mjs:16 already refuses such a receipt; fail here too, at the read.
    if (receipt.mode === 'dev' && !receipt.routeTable) throw new Error('Dev preview has no route-table receipt yet; its start probe has not completed');
    return receipt;
  }
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
  return { usage: 'node scripts/redesign-preview.mjs build-check|build; start --mode dev --scenario representative; start --mode production --dist .next --build-receipt /absolute/receipt; status|stop|recover-stopped --run /absolute/run; capture --run /absolute/run --route /dashboard --viewport 1440x900 --file /absolute/image.png; catalog', note: 'Dev compilation writes its Next cache only into its owned runtime, but its route-table probe touches the mtime of one tracked source file in the shared tree, so a second watcher on this checkout recompiles alongside it; measured concurrent starts still resolved, but prefer one at a time. Production uses an existing standalone build. Both modes block provider effects and keep disposable DATA_DIR.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
