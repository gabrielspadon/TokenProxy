import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
import { latestVersion } from '../../src/lib/db/migrations/index.js';
import { DATA_FILE } from '../../src/lib/db/paths.js';

const additions = ['requestId', 'logicalRequestId', 'attempt', 'contextSessionId', 'projectId',
  'rateSnapshotId', 'pricingCapturedAt', 'dispatchCoverage', 'costSource', 'costEvidence', 'usageSource', 'estimatedCostUsd', 'reportedCostUsd'];
let db;
afterAll(() => db?.close?.());
describe('usage attribution additive migration', () => {
  it('preserves legacy rows without inventing links and enforces one completion per exact attempt', async () => {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    const old = new DatabaseSync(DATA_FILE);
    for (const [name, definition] of Object.entries(TABLES)) {
      if (name === 'usageRateSnapshots') continue;
      const columns = Object.fromEntries(Object.entries(definition.columns).filter(([key]) =>
        !(name === 'usageHistory' && additions.includes(key))
        && !(name === 'requestStats' && ['rateSnapshotId', 'pricingCapturedAt', 'dispatchCoverage'].includes(key))));
      old.exec(buildCreateTableSql(name, { ...definition, columns }));
    }
    old.prepare('INSERT INTO _meta(key,value) VALUES(?,?)').run('backupSchemaVersion', '4');
    old.prepare('INSERT INTO _meta(key,value) VALUES(?,?)').run('schemaVersion', String(latestVersion()));
    const insert = old.prepare('INSERT INTO usageHistory(timestamp,provider,model,cost) VALUES(?,?,?,?)');
    insert.run('2026-09-06T12:00:00.000Z', 'fixture', 'model', 1.25);
    insert.run('2026-09-06T12:00:00.000Z', 'fixture', 'model', 0);
    old.close();
    const { getAdapter } = await import('../../src/lib/db/driver.js');
    db = await getAdapter();
    const rows = db.all('SELECT * FROM usageHistory ORDER BY id');
    expect(rows.map((row) => row.cost)).toEqual([1.25, 0]);
    for (const row of rows) for (const field of additions) expect(row[field]).toBeNull();
    expect(db.all('SELECT * FROM usageRateSnapshots')).toEqual([]);
    db.run('INSERT INTO usageHistory(timestamp,requestId) VALUES(?,?)', ['2026-09-06T13:00:00.000Z', 'attempt-1']);
    expect(() => db.run('INSERT INTO usageHistory(timestamp,requestId) VALUES(?,?)', ['2026-09-06T13:00:01.000Z', 'attempt-1'])).toThrow();
    expect(db.get('PRAGMA integrity_check').integrity_check).toBe('ok');
  });
});
