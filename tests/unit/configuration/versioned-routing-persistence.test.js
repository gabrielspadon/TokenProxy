import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSqlJsAdapter } from '../../../src/lib/db/adapters/sqljsAdapter.js';
import { createNodeSqliteAdapter } from '../../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { TABLES, buildCreateTableSql } from '../../../src/lib/db/schema.js';
import { CONFIG_VERSION_TABLES } from '../../../src/lib/db/configVersionSchema.js';
import { getCurrentConfiguration, createConfigurationDraft, activateConfigurationDraft } from '../../../src/lib/db/repos/configVersionsRepo.js';
const fixture = vi.hoisted(() => ({ db: null }));
vi.mock('../../../src/lib/db/driver.js', () => ({ getAdapter: async () => fixture.db }));
let directory, file;
const schema = db => {
  for (const [name, def] of Object.entries({ ...TABLES, ...CONFIG_VERSION_TABLES })) {
    db.exec(buildCreateTableSql(name, def));
    for (const sql of def.indexes || []) db.exec(sql);
  }
};
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'config-publication-'));
  file = join(directory, 'data.sqlite');
  fixture.db = await createSqlJsAdapter(file);
  schema(fixture.db);
});
afterEach(() => { vi.restoreAllMocks(); fixture.db.close(); rmSync(directory, { recursive: true, force: true }); });
async function draft() {
  const current = await getCurrentConfiguration();
  const document = { ...current.document, combos: [{ id: 'p', name: 'work', kind: null, models: ['openai/gpt-4o'] }] };
  return { current, draft: await createConfigurationDraft({ document, expectedCurrent: current.currentHash }) };
}
it('strict sql.js flush is immediately reloadable with private permissions and no pending timer', async () => {
  const { current, draft: d } = await draft();
  const result = await activateConfigurationDraft(d.id, { expectedRevision: 1, expectedCurrent: current.currentHash });
  expect(result.outcome).toBe('applied');
  const reopened = await createSqlJsAdapter(file);
  try {
    expect(reopened.get('SELECT name FROM combos').name).toBe('work');
    const latest = reopened.get('SELECT outcome, details FROM configReceipts ORDER BY id DESC LIMIT 1');
    expect(latest.outcome).toBe('applied');
    expect(JSON.parse(latest.details).runtimeRefresh).toBe('applied');
  } finally { reopened.close(); }
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(file + '.tmp')).toBe(false);
});
it('flush failure before staging persistence leaves routing unchanged', async () => {
  const { current, draft: d } = await draft();
  fixture.db.flush();
  const bytes = fs.readFileSync(file);
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('ENOSPC-secret'); });
  await expect(activateConfigurationDraft(d.id, { expectedRevision: 1, expectedCurrent: current.currentHash })).rejects.toMatchObject({ code: 'configuration_stage_persistence_failed', details: { effectiveConfigurationChanged: false } });
  expect((await getCurrentConfiguration()).currentHash).toBe(current.currentHash);
  expect(fs.readFileSync(file)).toEqual(bytes);
  rename.mockRestore();
});
it('post-commit flush failure reports partial and preserves recoverable memory plus durable staged receipt', async () => {
  const { current, draft: d } = await draft();
  const rename = fs.renameSync.bind(fs);
  let writes = 0;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
    if (++writes === 2) throw new Error('ENOSPC-secret');
    return rename(...args);
  });
  const result = await activateConfigurationDraft(d.id, { expectedRevision: 1, expectedCurrent: current.currentHash });
  expect(result).toMatchObject({ outcome: 'partial', completion: { databaseCommitted: true, persistence: 'failed' } });
  expect(fixture.db.get('SELECT name FROM combos').name).toBe('work');
  const reopened = await createSqlJsAdapter(file);
  try {
    expect(reopened.all('SELECT name FROM combos')).toEqual([]);
    expect(reopened.get('SELECT outcome FROM configReceipts ORDER BY id DESC LIMIT 1').outcome).toBe('staged');
  } finally { reopened.close(); }
  spy.mockRestore();
  fixture.db.flush();
  const recovered = await createSqlJsAdapter(file);
  try { expect(recovered.get('SELECT name FROM combos').name).toBe('work'); } finally { recovered.close(); }
});
it('propagates POSIX directory fsync failure after atomic rename without discarding memory', async () => {
  if (process.platform === 'win32') return;
  fixture.db.run('INSERT INTO settings(id, data) VALUES(1, ?)', ['{}']);
  const fsync = fs.fsyncSync.bind(fs);
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('directory-sync-failed');
    return fsync(fd);
  });
  expect(() => fixture.db.flush()).toThrow('directory-sync-failed');
  expect(fixture.db.get('SELECT data FROM settings WHERE id = 1').data).toBe('{}');
});
it('native readers never see partially replaced stores and an intervening connection defeats expectedCurrent', async () => {
  fixture.db.close();
  fixture.db = await createNodeSqliteAdapter(file);
  schema(fixture.db);
  const other = await createNodeSqliteAdapter(file);
  try {
    const { current, draft: d } = await draft();
    const run = fixture.db.run.bind(fixture.db);
    let observed = false;
    vi.spyOn(fixture.db, 'run').mockImplementation((sql, args) => {
      const result = run(sql, args);
      if (sql.startsWith('INSERT INTO combos(')) {
        observed = true;
        expect(other.all('SELECT id FROM combos')).toEqual([]);
      }
      return result;
    });
    const applied = await activateConfigurationDraft(d.id, { expectedRevision: 1, expectedCurrent: current.currentHash });
    expect(observed).toBe(true);
    expect(other.get('SELECT name FROM combos').name).toBe('work');
    vi.restoreAllMocks();
    const state = await getCurrentConfiguration();
    const next = await createConfigurationDraft({ document: { ...state.document, settings: { exposeComboOnly: true } }, expectedCurrent: applied.currentHash });
    const transaction = fixture.db.transaction.bind(fixture.db);
    let transactions = 0;
    vi.spyOn(fixture.db, 'transaction').mockImplementation(fn => {
      const result = transaction(fn);
      if (++transactions === 1) other.run('UPDATE settings SET data = ? WHERE id = 1', ['{"comboStrategy":"fusion"}']);
      return result;
    });
    await expect(activateConfigurationDraft(next.id, { expectedRevision: 1, expectedCurrent: applied.currentHash })).rejects.toMatchObject({ code: 'configuration_conflict' });
    expect(JSON.parse(other.get('SELECT data FROM settings WHERE id = 1').data).comboStrategy).toBe('fusion');
  } finally { other.close(); }
});
