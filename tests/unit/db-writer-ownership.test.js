import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createSqlJsAdapter } from '../../src/lib/db/adapters/sqljsAdapter.js';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { createBetterSqliteAdapter } from '../../src/lib/db/adapters/betterSqliteAdapter.js';
import { openAnalyticsReadOnly } from '../../src/lib/db/analytics/readOnly.mjs';
import { acquireSqlJsWriterAdmission, acquireNativeWriterAdmission } from '../../src/lib/db/adapters/writerAdmission.js';

let directory, file;
const adapters = [];
beforeEach(() => { directory = fs.mkdtempSync(join(tmpdir(), 'tokenproxy-writer-owner-')); file = join(directory, 'database.sqlite'); });
afterEach(() => {
  vi.restoreAllMocks();
  while (adapters.length) try { adapters.pop().close(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
});
async function open(factory = createSqlJsAdapter, target = file) {
  const adapter = await factory(target); adapters.push(adapter); return adapter;
}
async function seed() {
  const db = await open();
  db.exec('CREATE TABLE values_table(value INTEGER)');
  db.run('INSERT INTO values_table VALUES (1)');
  db.close();
}
function nativeClaims() { return fs.readdirSync(file + '.writers').filter(name => name.startsWith('native-')); }

it('keeps readers inert and reloads the latest snapshot on exclusive promotion', async () => {
  await seed();
  const first = await open(), second = await open();
  expect(fs.existsSync(join(file + '.writers', 'sqljs.json'))).toBe(false);
  first.run('INSERT INTO values_table VALUES (2)'); first.flush();
  expect(second.all('SELECT value FROM values_table')).toEqual([{ value: 1 }]);
  const mutation = vi.fn(() => second.run('INSERT INTO values_table VALUES (3)'));
  expect(() => second.transaction(mutation)).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY', retryable: false }));
  expect(mutation).not.toHaveBeenCalled();
  first.close();
  second.transaction(() => {
    expect(second.all('SELECT value FROM values_table')).toEqual([{ value: 1 }, { value: 2 }]);
    second.run('INSERT INTO values_table VALUES (3)');
  });
  second.flush();
  const reader = await open();
  expect(reader.all('SELECT value FROM values_table')).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
});

describe.each([['node', createNodeSqliteAdapter], ['better', createBetterSqliteAdapter]])('%s shared native admission', (_kind, create) => {
  it('allows native/native access while excluding sql.js writers until every owner closes', async () => {
    const first = await open(create), second = await open(create);
    first.exec('CREATE TABLE values_table(value INTEGER)');
    first.run('INSERT INTO values_table VALUES (1)');
    second.run('INSERT INTO values_table VALUES (2)');
    expect(nativeClaims()).toHaveLength(2);
    const fallback = await open();
    const mutation = vi.fn();
    expect(() => fallback.criticalTransaction(mutation)).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY' }));
    first.close();
    expect(() => fallback.transaction(mutation)).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY' }));
    second.close();
    fallback.run('INSERT INTO values_table VALUES (3)'); fallback.flush();
    expect(fallback.all('SELECT value FROM values_table')).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(mutation).not.toHaveBeenCalled();
    await expect(open(create)).rejects.toMatchObject({ code: 'DB_WRITER_OWNERSHIP_BUSY' });
    fallback.close();
    const next = await open(create);
    expect(next.get('SELECT COUNT(*) AS n FROM values_table').n).toBe(3);
  });

  it('performs no admission filesystem work on ordinary native reads or transactions', async () => {
    const db = await open(create);
    db.exec('CREATE TABLE values_table(value INTEGER)');
    const reads = vi.spyOn(fs, 'readFileSync');
    const opens = vi.spyOn(fs, 'openSync');
    const writes = vi.spyOn(fs, 'writeFileSync');
    for (let i = 0; i < 20; i += 1) {
      db.transaction(() => db.run('INSERT INTO values_table VALUES (?)', [i]));
      expect(db.get('SELECT COUNT(*) AS n FROM values_table').n).toBe(i + 1);
    }
    expect(reads).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });

  it('releases native admission after a failed database initialization', async () => {
    fs.writeFileSync(file, Buffer.alloc(4096, 'x'));
    await expect(open(create)).rejects.toThrow();
    expect(nativeClaims()).toEqual([]);
  });

  it('retains its claim if closing the native database fails', async () => {
    const native = await open(create);
    native.exec('CREATE TABLE values_table(value INTEGER)');
    const fallback = await open();
    const close = vi.spyOn(native.raw, 'close').mockImplementation(() => { throw new Error('synthetic close failure'); });
    native.close();
    expect(nativeClaims()).toHaveLength(1);
    expect(() => fallback.run('INSERT INTO values_table VALUES (1)')).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY' }));
    close.mockRestore(); native.close();
    fallback.run('INSERT INTO values_table VALUES (1)'); fallback.flush();
    expect(fallback.get('SELECT COUNT(*) AS n FROM values_table').n).toBe(1);
  });
});

it('keeps analytics snapshots available without acquiring writer ownership', async () => {
  await seed();
  const writer = await open(); writer.run('INSERT INTO values_table VALUES (2)');
  const before = fs.readdirSync(file + '.writers');
  const reader = await openAnalyticsReadOnly(file, 'sql.js'); adapters.push(reader);
  expect(reader.all('SELECT value FROM values_table')).toEqual([{ value: 1 }]);
  expect(() => reader.exec('INSERT INTO values_table VALUES (99)')).toThrow();
  expect(fs.readdirSync(file + '.writers')).toEqual(before);
  writer.flush();
  expect(reader.all('SELECT value FROM values_table')).toEqual([{ value: 1 }]);
  const fresh = await openAnalyticsReadOnly(file, 'sql.js'); adapters.push(fresh);
  expect(fresh.all('SELECT value FROM values_table')).toEqual([{ value: 1 }, { value: 2 }]);
});

it('retains an unpublished snapshot after external replacement without retrying the mutation', async () => {
  await seed();
  const writer = await open(); writer.run('INSERT INTO values_table VALUES (2)');
  const otherFile = join(directory, 'replacement.sqlite');
  const replacement = await open(createSqlJsAdapter, otherFile);
  replacement.exec('CREATE TABLE values_table(value INTEGER)'); replacement.run('INSERT INTO values_table VALUES (99)'); replacement.close();
  const external = fs.readFileSync(otherFile); fs.writeFileSync(file, external);
  expect(() => writer.flush()).toThrow(expect.objectContaining({ code: 'DB_SNAPSHOT_STALE', committed: false, retryable: false }));
  expect(writer.all('SELECT value FROM values_table')).toEqual([{ value: 1 }, { value: 2 }]);
  expect(fs.readFileSync(file)).toEqual(external);
  const callback = vi.fn();
  expect(() => writer.criticalTransaction(callback)).toThrow(expect.objectContaining({ code: 'DB_SNAPSHOT_STALE' }));
  expect(callback).not.toHaveBeenCalled();
  expect(() => writer.close()).toThrow(expect.objectContaining({ code: 'DB_SNAPSHOT_STALE' }));
  const contender = await open();
  expect(() => contender.run('INSERT INTO values_table VALUES (3)')).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY' }));
  expect(fs.readFileSync(file)).toEqual(external);
});

it('retains ownership after failed close and releases it only after successful publication', async () => {
  await seed();
  const writer = await open(), contender = await open(); writer.run('INSERT INTO values_table VALUES (2)');
  const realOpen = fs.openSync.bind(fs);
  const fault = vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
    if (target === file + '.tmp') throw Object.assign(new Error('synthetic disk error'), { code: 'EIO' });
    return realOpen(target, ...args);
  });
  expect(() => writer.close()).toThrow('synthetic disk error');
  expect(() => contender.run('INSERT INTO values_table VALUES (3)')).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY' }));
  fault.mockRestore(); writer.close();
  contender.run('INSERT INTO values_table VALUES (3)'); contender.flush();
  expect(contender.all('SELECT value FROM values_table')).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
});

it('rolls back a critical callback after detected replacement and never invokes it again', async () => {
  await seed();
  const writer = await open();
  const replacementFile = join(directory, 'critical-replacement.sqlite');
  const replacement = await open(createSqlJsAdapter, replacementFile);
  replacement.exec('CREATE TABLE values_table(value INTEGER)'); replacement.run('INSERT INTO values_table VALUES (99)'); replacement.close();
  const bytes = fs.readFileSync(replacementFile);
  const mutation = vi.fn(() => {
    writer.run('INSERT INTO values_table VALUES (2)');
    fs.writeFileSync(file, bytes);
  });
  expect(() => writer.criticalTransaction(mutation)).toThrow(expect.objectContaining({ code: 'DB_SNAPSHOT_STALE', retryable: false, committed: false }));
  expect(writer.all('SELECT value FROM values_table')).toEqual([{ value: 1 }]);
  expect(() => writer.criticalTransaction(mutation)).toThrow(expect.objectContaining({ code: 'DB_SNAPSHOT_STALE' }));
  expect(mutation).toHaveBeenCalledTimes(1); expect(fs.readFileSync(file)).toEqual(bytes);
});

it('refuses uncheckpointed native history before invoking a fallback mutation', async () => {
  await seed();
  const reader = await open();
  fs.writeFileSync(file + '-wal', 'synthetic uncheckpointed history');
  const callback = vi.fn();
  expect(() => reader.criticalTransaction(callback)).toThrow(expect.objectContaining({ code: 'DB_SNAPSHOT_STALE' }));
  expect(callback).not.toHaveBeenCalled();
  expect(fs.existsSync(join(file + '.writers', 'sqljs.json'))).toBe(false);
});

it.runIf(process.platform === 'linux')('recovers a proven-dead owned child without elapsed-time expiry', async () => {
  const adapterUrl = new URL('../../src/lib/db/adapters/sqljsAdapter.js', import.meta.url).href;
  const script = `import {createSqlJsAdapter} from ${JSON.stringify(adapterUrl)};
    const db = await createSqlJsAdapter(process.argv[1]);
    db.exec('CREATE TABLE values_table(value INTEGER)'); db.run('INSERT INTO values_table VALUES (1)'); db.flush();
    process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { timeout: 15000, encoding: 'utf8' });
  expect(child.error).toBeUndefined(); expect(child.signal, child.stderr).toBe('SIGKILL');
  expect(fs.existsSync(join(file + '.writers', 'sqljs.json'))).toBe(true);
  const recovered = await open();
  recovered.run('INSERT INTO values_table VALUES (2)'); recovered.flush();
  expect(recovered.all('SELECT value FROM values_table')).toEqual([{ value: 1 }, { value: 2 }]);
  expect(fs.readdirSync(file + '.writers').some(name => name.startsWith('reap-'))).toBe(true);
});

it('never treats an old modification time as proof that an unknown owner died', async () => {
  const held = acquireSqlJsWriterAdmission(file);
  const location = join(file + '.writers', 'sqljs.json');
  const record = JSON.parse(fs.readFileSync(location)); held.release();
  Object.assign(record, { nonce: randomUUID(), instanceId: randomUUID(), machine: '0'.repeat(64) });
  fs.writeFileSync(location, JSON.stringify(record), { mode: 0o600 });
  fs.utimesSync(location, new Date(0), new Date(0));
  expect(() => acquireSqlJsWriterAdmission(file)).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY' }));
  expect(() => acquireNativeWriterAdmission(file)).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY' }));
  expect(JSON.parse(fs.readFileSync(location)).nonce).toBe(record.nonce);
});

it.runIf(process.platform === 'linux')('does not let a delayed reclaimer unlink a newly acquired owner', () => {
  const held = acquireSqlJsWriterAdmission(file);
  const location = join(file + '.writers', 'sqljs.json');
  const dead = JSON.parse(fs.readFileSync(location)); held.release();
  Object.assign(dead, { nonce: randomUUID(), instanceId: randomUUID(), start: `${dead.start}0` });
  fs.writeFileSync(location, JSON.stringify(dead), { mode: 0o600 });
  let newer, armed = true;
  const read = fs.readFileSync.bind(fs);
  const fault = vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
    const bytes = read(target, ...args);
    if (armed && typeof target === 'number' && String(bytes).includes(dead.nonce)) {
      armed = false;
      newer = acquireSqlJsWriterAdmission(file);
    }
    return bytes;
  });
  expect(() => acquireSqlJsWriterAdmission(file)).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY' }));
  fault.mockRestore();
  expect(newer).toBeDefined(); expect(() => newer.assertOwned()).not.toThrow();
  newer.release();
});

it('keeps two-phase native admission safe against a concurrent exclusive claimant', () => {
  const link = fs.linkSync.bind(fs);
  let attempted = false;
  const interleave = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
    const result = link(source, target);
    if (!attempted && String(target).includes('/native-')) {
      attempted = true;
      expect(() => acquireSqlJsWriterAdmission(file)).toThrow(expect.objectContaining({ code: 'DB_WRITER_OWNERSHIP_BUSY' }));
    }
    return result;
  });
  const native = acquireNativeWriterAdmission(file);
  interleave.mockRestore(); expect(attempted).toBe(true); native.release();
  const exclusive = acquireSqlJsWriterAdmission(file); exclusive.release();
});
