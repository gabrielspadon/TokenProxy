import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../dataDir.js';
import { DB_DIR, SECRET_DIR_MODE, SECRET_FILE_MODE, SECRET_KEY_FILE, chmodQuiet } from '../paths.js';

const ENCRYPT_ALGO = 'aes-256-gcm';
const ENCRYPT_SALT = 'tokenproxy-conn-secret';
const ENC_PREFIX = 'enc1:';

// P-F1: the machine id cannot change under a running process, but reading it
// costs a ~2ms subprocess — and deriveKey ran once per row decrypt, which put
// the whole admission queue behind it. Cache the derived key for the process
// lifetime; first call computes, later calls return.
let cachedKey = null;

const LEGACY_FAILURE_KEY = crypto.createHash('sha256').update(ENCRYPT_SALT).digest();

function readInstallKey() {
  try {
    const stat = fs.lstatSync(SECRET_KEY_FILE);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('database encryption key must be a regular file');
    const encoded = fs.readFileSync(SECRET_KEY_FILE, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(encoded)) throw new Error('database encryption key file is invalid');
    chmodQuiet(SECRET_KEY_FILE, SECRET_FILE_MODE);
    return Buffer.from(encoded, 'hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function publishInstallKey(key) {
  fs.mkdirSync(DB_DIR, { recursive: true, mode: SECRET_DIR_MODE });
  chmodQuiet(DB_DIR, SECRET_DIR_MODE);
  let fd;
  try {
    fd = fs.openSync(SECRET_KEY_FILE, 'wx', SECRET_FILE_MODE);
  } catch (error) {
    if (error?.code === 'EEXIST') return readInstallKey();
    throw error;
  }
  let complete = false;
  try {
    fs.writeFileSync(fd, key.toString('hex'), 'utf8');
    fs.fsyncSync(fd);
    complete = true;
  } finally {
    try { fs.closeSync(fd); } catch {}
    if (!complete) {
      try { fs.unlinkSync(SECRET_KEY_FILE); } catch {}
    }
  }
  if (process.platform !== 'win32') {
    const directory = fs.openSync(DB_DIR, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  return key;
}

function stableMachineIdentity() {
  try {
    const { machineIdSync } = require('node-machine-id');
    return machineIdSync();
  } catch {
    // Newer TokenProxy installations persist the raw machine identity here.
    // It provides a recovery path if the platform API later becomes unavailable.
    try {
      const stored = fs.readFileSync(path.join(DATA_DIR, 'machine-id'), 'utf8').trim();
      if (stored) return stored;
    } catch {}
    return null;
  }
}

function deriveKey() {
  if (cachedKey) return cachedKey;
  let key;
  if (process.env.DB_ENCRYPTION_KEY) {
    key = crypto.createHash('sha256').update(process.env.DB_ENCRYPTION_KEY).digest();
  } else {
    const installed = readInstallKey();
    if (installed) key = installed;
    else {
      const machineId = stableMachineIdentity();
      const candidate = machineId
        ? crypto.createHash('sha256').update(machineId + ENCRYPT_SALT).digest()
        : crypto.randomBytes(32);
      key = publishInstallKey(candidate);
    }
  }
  cachedKey = key;
  return key;
}

// Test-only: reset the cached key so a test can re-derive under different env.
export function _resetSecretKeyCacheForTests() {
  cachedKey = null;
}

function encrypt(plaintext) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptWithKey(stored, key) {
  const [ivHex, tagHex, dataHex] = stored.slice(ENC_PREFIX.length).split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('malformed secret ciphertext');
  const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8');
}

function decrypt(stored) {
  const key = deriveKey();
  try {
    return decryptWithKey(stored, key);
  } catch (error) {
    // Releases before the installation-local key used this shared fallback
    // when machine-id failed. Read it only for recovery; every new write uses
    // the random installation key and no two new installations share a domain.
    if (!key.equals(LEGACY_FAILURE_KEY)) return decryptWithKey(stored, LEGACY_FAILURE_KEY);
    throw error;
  }
}

// Encrypts a JSON-serializable value for storage in a `data` column.
export function encryptSecretJson(value) {
  return encrypt(JSON.stringify(value ?? null));
}

// Decrypts a value stored by encryptSecretJson. Transparently reads legacy
// plaintext JSON (no "enc1:" prefix) written before this encryption was added.
export function decryptSecretJson(stored, fallback = null) {
  if (stored == null) return fallback;
  try {
    if (typeof stored === 'string' && stored.startsWith(ENC_PREFIX)) {
      return JSON.parse(decrypt(stored));
    }
    return JSON.parse(stored);
  } catch {
    return fallback;
  }
}
