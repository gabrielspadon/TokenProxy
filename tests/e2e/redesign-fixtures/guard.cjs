'use strict';
// Explicit test-only preload. Never imported by the application entrypoint.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const preview = fs.realpathSync(process.env.TOKENPROXY_REDESIGN_ROOT || '');
const marker = JSON.parse(fs.readFileSync(path.join(preview, 'owner.json'), 'utf8'));
if (marker.kind !== 'tokenproxy-redesign-preview-v1' || marker.root !== preview) throw new Error('Owned redesign runtime required');
const runtime = path.join(preview, 'runtime');
const workerThread = !require('node:worker_threads').isMainThread;
const suppliedData = path.resolve(process.env.DATA_DIR || '');
const canonicalParent = fs.realpathSync(path.dirname(suppliedData));
const scratchWorker = workerThread && canonicalParent === fs.realpathSync(require('node:os').tmpdir())
  && /^tokenproxy-offline-shaping-[A-Za-z0-9_-]+$/.test(path.basename(suppliedData));
if (process.env.TOKENPROXY_PREVIEW_ISOLATED !== '1' || (!scratchWorker && suppliedData !== runtime)) {
  throw new Error('Preview guard requires its own isolated runtime DATA_DIR');
}
const auth = JSON.parse(fs.readFileSync(path.join(preview, 'preview-auth.json'), 'utf8'));
if (auth.syntheticOnly !== 'redesign-fixture') throw new Error('Synthetic Shaping fixture marker required');
const manifestPath = path.join(preview, 'fixture-manifest.json');
const fixtureManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
const fixtureAccounts = fixtureManifest?.accounts || [];
const fixtureIds = new Set(fixtureAccounts.map(account => account.id));
const seedReceiptPath = path.join(preview, 'seed-receipt.json');
const processLoad = fs.existsSync(seedReceiptPath) ? JSON.parse(fs.readFileSync(seedReceiptPath, 'utf8')).edges?.processLoad : null;
if (processLoad && !workerThread) {
  if (Object.keys(processLoad).some(id => !fixtureIds.has(id))) throw new Error('Synthetic load must reference fixture accounts');
  global._pendingRequests = { byAccount: processLoad, byModel: {} };
  for (const models of Object.values(processLoad)) for (const [model, count] of Object.entries(models)) {
    if (!Number.isInteger(count) || count < 0 || count > 16) throw new Error('Synthetic load exceeds fixture bounds');
    global._pendingRequests.byModel[model] = (global._pendingRequests.byModel[model] || 0) + count;
  }
}
function plaintextFixtureData(stored) {
  if (!stored.startsWith('enc1:')) return JSON.parse(stored);
  const [iv,tag,data] = stored.slice(5).split(':');
  const key=crypto.createHash('sha256').update(auth.dbEncryptionKey).digest();
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));
  decipher.setAuthTag(Buffer.from(tag,'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,'hex')),decipher.final()]).toString());
}
function containsSecret(value) {
  return value && typeof value === 'object' && Object.entries(value).some(([key,child]) =>
    /^(api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|password|cookie|client[-_]?secret|authorization)$/i.test(key) && Boolean(child)
    || containsSecret(child));
}
const fixtureDb = path.join(runtime, 'db', 'data.sqlite');
// Audit once before application startup. Opening a second SQLite implementation
// inside workers can invalidate the live better-sqlite3 WAL shared-memory map.
if (!workerThread && fs.existsSync(fixtureDb)) {
  const { DatabaseSync } = require('node:sqlite');
  const inspected = new DatabaseSync(fixtureDb, { readOnly: true });
  try {
    const table = inspected.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providerConnections'").get();
    if (table) for (const row of inspected.prepare('SELECT id,provider,name,data FROM providerConnections').all()) {
      const fixture=fixtureAccounts.find(account=>account.id===row.id);
      if (!fixture || row.provider!==fixture.provider || !row.name.startsWith('Synthetic ') || containsSecret(plaintextFixtureData(row.data)))
        throw new Error('Preview refuses unknown accounts or usable provider credentials');
    }
  } finally { inspected.close(); }
}
for (const key of Object.keys(process.env)) {
  if (/KEY|TOKEN|SECRET|PASSWORD|PROXY|OAUTH|HEADROOM|PXPIPE|EMBED.*URL/i.test(key)
      && !['TOKENPROXY_PREVIEW_ISOLATED','TOKENPROXY_REDESIGN_ROOT'].includes(key)) delete process.env[key];
}
Object.assign(process.env, {
  TOKENPROXY_BUILD_SHA: fs.existsSync(path.join(preview, 'source-manifest.json')) ? JSON.parse(fs.readFileSync(path.join(preview, 'source-manifest.json'), 'utf8')).revision : 'synthetic-preview',
  INITIAL_PASSWORD: auth.initialPassword,
  JWT_SECRET: auth.jwtSecret,
  TOKENPROXY_PEER_TOKEN: auth.peerToken,
  API_KEY_SECRET: crypto.randomBytes(32).toString('hex'),
  DB_ENCRYPTION_KEY: auth.dbEncryptionKey,
  MODEL_CATALOG_SYNC: 'off',
  NEXT_PHASE: 'phase-production-build',
  NEXT_TELEMETRY_DISABLED: '1',
  HOSTNAME: '127.0.0.1',
});
const NativeDate = Date;
const fixtureTime = NativeDate.parse(auth.capturedAt);
if (process.env.NODE_ENV !== 'development') global.Date = new Proxy(NativeDate, {
  construct(target, args, receiver) { return Reflect.construct(target, args.length ? args : [fixtureTime], receiver); },
  apply() { return new NativeDate(fixtureTime).toString(); },
  get(target, key, receiver) { return key === 'now' ? () => fixtureTime : Reflect.get(target, key, receiver); },
});
global.__appBootstrapped = true;
global.__tokenproxyPreviewGuard = { outboundBlocked: 0, processBlocked: 0, mutationBlocked: 0, privateReadBlocked: 0 };
const denied = (kind) => {
  global.__tokenproxyPreviewGuard[kind]++;
  const error = new Error('Synthetic redesign preview is isolated; this action is disabled');
  error.code = 'EPREVIEWISOLATED';
  return error;
};
const blockNetwork = () => { throw denied('outboundBlocked'); };
// Route handlers consume Request.json before performing these local writes.
// Refuse usable provider credentials and autonomous jobs even after boot.
const realRequestJson = global.Request.prototype.json;
const enablesLiveJob = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
  /(?:auto.?ping|quota.*warm|freeModelSync)/i.test(key)
  || /^(?:cloudEnabled|tunnelEnabled|tailscaleEnabled|mitmEnabled)$/i.test(key) && child !== false
  || enablesLiveJob(child));
global.Request.prototype.json = async function(...args) {
  const value = await realRequestJson.apply(this, args);
  const pathname = new URL(this.url).pathname;
  if (/^\/api\/(?:providers|provider-nodes)(?:\/|$)/.test(pathname) && containsSecret(value)
      || pathname === '/api/settings' && enablesLiveJob(value)) throw denied('mutationBlocked');
  return value;
};
net.Socket.prototype.connect = blockNetwork;
net.connect = net.createConnection = blockNetwork;
tls.connect = blockNetwork;
dgram.Socket.prototype.send = dgram.Socket.prototype.connect = blockNetwork;
http.request = http.get = https.request = https.get = blockNetwork;
global.fetch = async () => { throw denied('outboundBlocked'); };
// Node's numeric listen host still passes through lookup. Keep the native
// literal fast path so callback family/all options retain their usual shape.
const literalLoopback = hostname => hostname === '127.0.0.1' || hostname === '::1';
const realLookup = dns.lookup;
const realPromiseLookup = dns.promises.lookup;
for (const [Resolver, promiseBased] of [[dns.Resolver, false], [dns.promises.Resolver, true]]) {
  for (let prototype = Resolver.prototype; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (/^(lookup|resolve|reverse)/.test(name) && typeof prototype[name] === 'function') {
        prototype[name] = promiseBased ? async () => { throw denied('outboundBlocked'); } : blockNetwork;
      }
    }
  }
}
for (const name of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(name) && typeof dns[name] === 'function') dns[name] = blockNetwork;
for (const name of Object.keys(dns.promises)) if (/^(lookup|resolve|reverse)/.test(name) && typeof dns.promises[name] === 'function') dns.promises[name] = async () => { throw denied('outboundBlocked'); };
dns.lookup = function(hostname, ...args) {
  if (!literalLoopback(hostname)) throw denied('outboundBlocked');
  return realLookup.call(this, hostname, ...args);
};
dns.promises.lookup = async function(hostname, ...args) {
  if (!literalLoopback(hostname)) throw denied('outboundBlocked');
  return realPromiseLookup.call(this, hostname, ...args);
};
for (const name of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork']) cp[name] = () => { throw denied('processBlocked'); };
const realKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (Number(pid) !== process.pid) throw denied('processBlocked');
  return realKill(pid, signal);
};

// Refuse accidental credential discovery in the signed-in user's real home.
const privateHomes = ['.tokenproxy','.codex','.claude','.config','.aws','.azure','.ssh','.netrc','.npmrc','.curlrc','.gemini','.kimi','.kiro','.cursor','.qwen','.continue','.codeium'];
const home = marker.realHome;
const forbiddenPath = (value) => {
  if (typeof value !== 'string' && !(value instanceof URL) && !Buffer.isBuffer(value)) return false;
  const resolved = path.resolve(value instanceof URL ? require('node:url').fileURLToPath(value) : String(value));
  if (/^\.env(?:\.|$)/.test(path.basename(resolved)) && !resolved.startsWith(preview+path.sep)) return true;
  return privateHomes.some(name => resolved === path.join(home,name) || resolved.startsWith(path.join(home,name)+path.sep));
};
const privatePathError = name => {
  const error = denied('privateReadBlocked');
  if (/^(?:stat|lstat|access|readdir)/.test(name)) error.code = 'ENOENT';
  return error;
};
for (const name of ['readFileSync','readFile','createReadStream','openSync','open','readdirSync','readdir','statSync','stat','lstatSync','lstat','accessSync','access']) {
  const real = fs[name];
  fs[name] = function(file,...args) {
    if (forbiddenPath(file)) {
      const error = privatePathError(name), callback = args.at(-1);
      if (!name.endsWith('Sync') && typeof callback === 'function') { queueMicrotask(() => callback(error)); return; }
      throw error;
    }
    return real.call(this,file,...args);
  };
}
const realExists = fs.existsSync;
fs.existsSync = (file) => forbiddenPath(file) ? false : realExists(file);
for (const name of ['readFile','open','readdir','stat','lstat','access']) {
  const real = fs.promises[name];
  fs.promises[name] = async function(file,...args) {
    if (forbiddenPath(file)) throw privatePathError(name);
    return real.call(this,file,...args);
  };
}

const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : null };
  if (workerThread || !['127.0.0.1','::1','localhost'].includes(options.host) || Number(options.port) !== Number(process.env.PORT)) {
    throw new Error('Preview may listen only on its explicitly selected loopback port');
  }
  return realListen.apply(this,args);
};
const realEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function(event,...args) {
  if (event === 'request' || event === 'checkContinue') {
    const [request,response] = args;
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const method = String(request.method || 'GET').toUpperCase();
    if (pathname === '/__redesign_owner' || pathname === '/__redesign_stop') {
      if (request.headers['x-redesign-owner'] !== auth.ownerToken) {
        response.writeHead(403); response.end(); return true;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (pathname === '/__redesign_stop' && method === 'POST') response.once('finish', () => process.exit(0));
      response.end(JSON.stringify({ runId: marker.runId, pid: process.pid, clock: auth.capturedAt, guard: global.__tokenproxyPreviewGuard }));
      return true;
    }
    const read = ['GET','HEAD','OPTIONS'].includes(method);
    const syntheticAccount = fixtureIds.has(decodeURIComponent(pathname.split('/').at(-1)));
    const localControl = method === 'POST' && /^\/api\/admin\/investigations(?:\/export)?$/.test(pathname)
      || ['PUT','DELETE'].includes(method) && /^\/api\/admin\/investigations\/[^/]+$/.test(pathname)
      || method === 'POST' && /^\/api\/(?:access-profiles|keys|proxy-pools|provider-nodes)$/.test(pathname)
      || method === 'POST' && pathname === '/api/providers/custom'
      || method === 'DELETE' && pathname === '/api/proxy-pools'
      || ['PATCH','DELETE'].includes(method) && pathname === '/api/pricing'
      || method === 'POST' && pathname === '/api/admin/budgets'
      || method === 'POST' && pathname === '/api/admin/auto-routing'
      || method === 'PATCH' && /^\/api\/context\/sessions\/\d+$/.test(pathname)
      || ['PUT','DELETE'].includes(method) && /^\/api\/(?:access-profiles|keys|proxy-pools|provider-nodes)\/[^/]+$/.test(pathname)
      || method === 'POST' && /^\/api\/keys\/[^/]+\/(?:reveal|rotate|profile|connectivity)$/.test(pathname)
      || method === 'DELETE' && /^\/api\/keys\/[^/]+\/profile$/.test(pathname)
      || method === 'PUT' && /^\/api\/providers\/[^/]+$/.test(pathname) && syntheticAccount
      || ['POST','DELETE'].includes(method) && /^\/api\/admin\/drain\/[^/]+$/.test(pathname) && syntheticAccount
      || method === 'PUT' && pathname === '/api/routing-cascade'
      || method === 'POST' && /^\/api\/admin\/session-pins\/(?:preview|apply)$/.test(pathname)
      || ['POST','PATCH'].includes(method) && /^\/api\/admin\/configuration\/drafts(?:\/[^/]+(?:\/(?:validate|activate))?)?$/.test(pathname)
      || method === 'POST' && /^\/api\/admin\/configuration\/versions\/\d+\/rollback$/.test(pathname)
      || method === 'POST' && /^\/api\/admin\/notification-rules(?:\/dry-run|\/events\/[^/]+)?$/.test(pathname)
      || method === 'PUT' && /^\/api\/admin\/notification-rules\/[^/]+$/.test(pathname)
      || method === 'POST' && /^\/api\/admin\/compatibility\/(?:fixtures|runs|runs\/[^/]+\/cancel)$/.test(pathname)
      || method === 'PATCH' && /^\/api\/admin\/compatibility\/fixtures\/[^/]+$/.test(pathname)
      || ['POST','DELETE'].includes(method) && pathname === '/api/models/disabled'
      || method === 'POST' && pathname === '/api/translator/translate';
    const allowedMutation = method === 'POST' && ['/api/auth/login', '/api/locale'].includes(pathname)
      || method === 'POST' && /^\/api\/admin\/shaping\/(?:profiles|experiments|promote|rollback|controls|plans|runtime)$/.test(pathname)
      || method === 'PATCH' && pathname === '/api/settings'
      || ['POST', 'PUT', 'DELETE'].includes(method) && pathname === '/api/model-context'
      || localControl;
    if (!read && !allowedMutation || /^\/(?:api\/)?(?:v1|v1beta|responses|codex)(?:\/|$)/.test(pathname)) {
      global.__tokenproxyPreviewGuard.mutationBlocked++;
      response.writeHead(403, {'content-type':'application/json','cache-control':'no-store'});
      response.end(JSON.stringify({error:'Synthetic redesign preview; live actions and inference are disabled',code:'preview_isolated'}));
      return true;
    }
    response.setHeader('x-tokenproxy-preview','historical-snapshot');
    response.setHeader('x-tokenproxy-preview-kind','synthetic-fixture');
    if (fixtureManifest?.version) response.setHeader('x-tokenproxy-preview-version',fixtureManifest.version);
    response.setHeader('x-tokenproxy-preview-captured-at',auth.capturedAt);
    response.setHeader('cache-control','no-store');
  }
  return realEmit.call(this,event,...args);
};
syncBuiltinESMExports();
