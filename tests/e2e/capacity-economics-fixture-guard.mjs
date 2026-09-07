import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const accounts = new Map([
  ['connection-fixture-alpha','openai'],['connection-fixture-beta','openai'],
  ['capacity-fixture-a','codex'],['capacity-fixture-b','codex'],
]);
const refuse = message => { throw new Error(`Synthetic fixture refused: ${message}`); };
const hasValue = value => value != null && value !== '' && value !== false && (
  typeof value !== 'object' || Object.values(value).some(hasValue)
);
const credentialName = /^(?:apiKey|accessKeyId|secretAccessKey|accessToken|refreshToken|idToken|token|password|passwordHash|proxyPassword|clientSecret|copilotToken|managementKey|authorization|bearerToken|privateKey|credential|credentials|cookie|cookies|customHeaders)$/i;

function decode(stored, key) {
  try {
    if (typeof stored !== 'string') refuse('connection data is unavailable');
    if (stored.startsWith('enc1:')) {
      const parts = /^enc1:([a-f\d]{24}):([a-f\d]{32}):((?:[a-f\d]{2})+)$/i.exec(stored);
      if (!parts || typeof key !== 'string' || !key) refuse('encrypted connection data requires the explicit fixture key');
      const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), Buffer.from(parts[1],'hex'));
      decipher.setAuthTag(Buffer.from(parts[2],'hex'));
      stored = Buffer.concat([decipher.update(Buffer.from(parts[3],'hex')),decipher.final()]).toString('utf8');
    }
    const value = JSON.parse(stored);
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('connection data must be an object');
    return value;
  } catch {
    // Do not include ciphertext, plaintext, key material or parser errors in a test report.
    refuse('connection data could not be safely decoded');
  }
}
function rejectCredentials(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key,child] of Object.entries(value)) {
    if (credentialName.test(key.replace(/[^a-z\d]/gi,'')) && hasValue(child)) refuse('usable credential data is present');
    rejectCredentials(child);
  }
}
function verifyAccounts(rows, fromDatabase = false, key) {
  if (!Array.isArray(rows) || rows.length !== accounts.size || new Set(rows.map(row=>row.id)).size !== accounts.size) refuse('exactly four known fixture accounts are required');
  for (const row of rows) {
    if (accounts.get(row.id) !== row.provider) refuse('account identity or provider is outside the fixture');
    const data = fromDatabase ? decode(row.data,key) : row;
    const names = fromDatabase && Object.hasOwn(data,'name') ? [row.name,data.name] : [row.name];
    if (names.some(name => typeof name !== 'string' || !name.startsWith('Synthetic '))) refuse('fixture account name is missing its Synthetic prefix');
    if (data.provider != null && data.provider !== row.provider) refuse('connection provider disagrees with its stored identity');
    rejectCredentials(data);
  }
}

export function credentiallessDatabase({ dataDir = process.env.E2E_DATA_DIR, fixtureRoot = process.env.E2E_FIXTURE_ROOT, key = process.env.E2E_FIXTURE_DB_KEY } = {}) {
  if (!dataDir) refuse('provide the disposable database directory');
  const directory = realpathSync(dataDir);
  if (fixtureRoot) {
    const root = realpathSync(fixtureRoot);
    if (path.resolve(fixtureRoot) !== root || path.resolve(directory,'../..') !== root || directory !== path.join(root,'runtime','db')) refuse('explicit fixture root must equal the canonical runtime root');
    const manifestPath = path.join(root,'fixture-manifest.json');
    if (realpathSync(manifestPath) !== manifestPath) refuse('manifest cannot escape the explicit fixture root');
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath,'utf8')); } catch { refuse('fixture manifest is unreadable'); }
    if (manifest.version !== 'operator-workspace-v2' || manifest.source !== 'synthetic-local-policy' || manifest.inferenceAllowed !== false) refuse('fixture manifest is not the authorized synthetic version');
    verifyAccounts(manifest.accounts);
  } else if (![realpathSync(os.tmpdir()),realpathSync('/tmp')].some(root=>directory.startsWith(`${root}${path.sep}`))) refuse('a private workspace database requires an explicit fixture root');
  const filename = realpathSync(path.join(directory,'data.sqlite'));
  if (path.dirname(filename) !== directory) refuse('database cannot escape the verified directory');
  const db = new DatabaseSync(filename,{readOnly:true});
  try { verifyAccounts(db.prepare('SELECT id,provider,name,data FROM providerConnections').all(),true,key); return db; }
  catch (error) { db.close(); throw error; }
}
