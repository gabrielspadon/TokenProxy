import fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECLAIM_DEPTH = 8;

function startIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^\d+$/.test(value || '')) throw new Error('Unverifiable process start identity');
  return value;
}

function processIdentity() {
  const identity = { instanceId: randomUUID(), pid: process.pid, machine: null, boot: null, start: null };
  if (process.platform === 'linux') {
    try {
      const machine = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (!/^[a-f0-9]{32}$/.test(machine) || !UUID.test(boot)) throw new Error('Unverifiable host identity');
      Object.assign(identity, { machine: createHash('sha256').update(machine).digest('hex'), boot, start: startIdentity(process.pid) });
    } catch {}
  }
  return identity;
}

const identity = globalThis.__tokenproxyWriterAdmissionIdentity ??= processIdentity();

function admissionError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false, committed: false });
}
function busy() { return admissionError('DB_WRITER_OWNERSHIP_BUSY', 'Database writer ownership is active or cannot be verified'); }
function invalid() { return admissionError('DB_WRITER_OWNERSHIP_INVALID', 'Database writer ownership metadata is unsafe or invalid'); }

function privateStat(stat, directory = false) {
  if (!(directory ? stat.isDirectory() : stat.isFile())
    || !directory && (stat.nlink < 1 || stat.nlink > 2 || stat.size > 4096)
    || process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw invalid();
}

function canonicalFile(file) {
  const parent = fs.realpathSync(dirname(resolve(file)));
  const canonical = join(parent, basename(file));
  try { const stat = fs.lstatSync(canonical); if (!stat.isFile() || stat.nlink !== 1) throw invalid(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return canonical;
}

function directoryFor(file) {
  const directory = `${canonicalFile(file)}.writers`;
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateStat(fs.lstatSync(directory), true);
  return directory;
}

function claim(role) { return { schemaVersion: 1, role, nonce: randomUUID(), ...identity }; }

function readClaim(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    privateStat(stat);
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (record.schemaVersion !== 1 || !['native', 'sqljs', 'reaper'].includes(record.role)
      || !UUID.test(record.nonce) || !UUID.test(record.instanceId) || !Number.isSafeInteger(record.pid) || record.pid < 1
      || !(record.machine === null || HASH.test(record.machine)) || !(record.boot === null || UUID.test(record.boot))
      || !(record.start === null || typeof record.start === 'string' && /^\d+$/.test(record.start))) throw invalid();
    return { record, ino: stat.ino, dev: stat.dev };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Publish a complete owner record atomically. No process can observe an empty
// fixed claim between exclusive creation and writing its identity.
function publish(directory, name, record) {
  privateStat(fs.lstatSync(directory), true);
  const temporary = join(directory, `.claim-${record.nonce}`);
  const destination = join(directory, name);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.closeSync(fd); fd = undefined;
    fs.linkSync(temporary, destination);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return readClaim(destination);
}

function ownerState(record) {
  if (record.instanceId === identity.instanceId && record.pid === identity.pid) return 'alive';
  if (!identity.machine || !record.machine || identity.machine !== record.machine || !record.boot || !record.start) return 'unknown';
  if (identity.boot !== record.boot) return 'dead';
  try { return startIdentity(record.pid) === record.start ? 'alive' : 'dead'; }
  catch (error) { return error.code === 'ENOENT' || error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

function sameClaim(left, right) {
  return left && right && left.ino === right.ino && left.dev === right.dev && left.record.nonce === right.record.nonce;
}

// Reclaimers retain their unique claim after deleting a dead exclusive owner.
// A delayed second reclaimer cannot reuse that claim and unlink a new owner.
// If a reclaimer itself dies, the next attempt follows its identity, at most
// MAX_RECLAIM_DEPTH times. Elapsed time never grants ownership.
function reclaimExclusive(directory, previous) {
  if (ownerState(previous.record) !== 'dead') throw busy();
  const exclusive = join(directory, 'sqljs.json');
  let predecessor = 'root';
  for (let depth = 0; depth < MAX_RECLAIM_DEPTH; depth += 1) {
    const name = `reap-${previous.record.nonce}-${predecessor}.json`;
    const reaper = claim('reaper');
    let held;
    try { held = publish(directory, name, reaper); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readClaim(join(directory, name));
      if (!existing || existing.record.role !== 'reaper' || ownerState(existing.record) !== 'dead') throw busy();
      predecessor = existing.record.nonce;
      continue;
    }
    let removed = false;
    try {
      if (!sameClaim(readClaim(exclusive), previous)) throw busy();
      fs.unlinkSync(exclusive);
      removed = true;
      return;
    } finally {
      if (!removed && sameClaim(readClaim(join(directory, name)), held)) fs.unlinkSync(join(directory, name));
    }
  }
  throw busy();
}

function ensureNoExclusive(directory) {
  const current = readClaim(join(directory, 'sqljs.json'));
  if (!current) return;
  if (current.record.role !== 'sqljs') throw invalid();
  reclaimExclusive(directory, current);
}

function lease(directory, name, held) {
  let released = false;
  const file = join(directory, name);
  return {
    assertOwned() {
      if (released || !sameClaim(readClaim(file), held)) throw admissionError('DB_WRITER_OWNERSHIP_LOST', 'Database writer ownership was lost; do not replay the mutation');
    },
    release() {
      if (released) return;
      this.assertOwned();
      fs.unlinkSync(file);
      released = true;
    },
  };
}

export function acquireNativeWriterAdmission(file) {
  if (file === ':memory:') return { assertOwned() {}, release() {} };
  const directory = directoryFor(file);
  ensureNoExclusive(directory);
  const owner = claim('native');
  const name = `native-${owner.nonce}.json`;
  const held = publish(directory, name, owner);
  const admission = lease(directory, name, held);
  try {
    // An exclusive claimant appearing after our first check must see this
    // shared claim; we also refuse to open a native connection while it exists.
    ensureNoExclusive(directory);
    return admission;
  } catch (error) { admission.release(); throw error; }
}

export function acquireSqlJsWriterAdmission(file) {
  const directory = directoryFor(file);
  const owner = claim('sqljs');
  let held;
  try { held = publish(directory, 'sqljs.json', owner); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    ensureNoExclusive(directory);
    try { held = publish(directory, 'sqljs.json', owner); }
    catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
  }
  const admission = lease(directory, 'sqljs.json', held);
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!/^native-[a-f0-9-]{36}\.json$/.test(name)) continue;
      const current = readClaim(join(directory, name));
      if (!current) continue;
      if (current.record.role !== 'native' || name !== `native-${current.record.nonce}.json`) throw invalid();
      if (ownerState(current.record) !== 'dead') throw busy();
      // Shared filenames are never reused, so removing a proven-dead native
      // owner cannot remove another owner's claim.
      fs.unlinkSync(join(directory, name));
    }
    return admission;
  } catch (error) { admission.release(); throw error; }
}
