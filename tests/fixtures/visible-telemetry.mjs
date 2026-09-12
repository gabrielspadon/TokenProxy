import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Public analytics intentionally excludes test-origin writes. These fixtures
// first verify the real producer's trusted origin, then expose only the rows
// created by their own operation as an explicitly identified synthetic import.
export function createVisibleTelemetryFixture(db, label) {
  assert.equal(process.env.NODE_ENV, 'test', 'fixture visibility is confined to a test process');
  const tables = ['requestStats', 'usageHistory'];
  const snapshots = () => Object.fromEntries(tables.map(table => [table, new Set(db.all(`SELECT id FROM ${table}`).map(row => String(row.id)))]));
  const delay = () => new Promise(resolve => setTimeout(resolve, 5));

  return async function visibleFixture(produce) {
    const before = snapshots();
    const result = await produce();
    let owned;
    for (let attempt = 0; attempt < 100; attempt++) {
      owned = Object.fromEntries(tables.map(table => [table, db.all(`SELECT id,status,dataOrigin,originReceiptId FROM ${table}`)
        .filter(row => !before[table].has(String(row.id)))]));
      if (owned.requestStats.length + owned.usageHistory.length > 0 && owned.requestStats.every(row => row.status !== 'pending')) break;
      if (attempt === 99) throw new Error('Owned fixture telemetry did not reach durable terminal state');
      await delay();
    }
    db.transaction(() => {
      for (const table of tables) for (const row of owned[table]) {
        const key = `${table}:${row.id}`;
        const receipt = createHash('sha256').update(`${label}:${key}`).digest('hex');
        assert.equal(row.dataOrigin, 'test', `${key} must originate from the test process`);
        const changed = db.run(`UPDATE ${table} SET dataOrigin=?,originReceiptId=? WHERE id=? AND dataOrigin=?`, ['import', receipt, row.id, 'test']);
        assert.equal(changed.changes, 1, `${key} must be an exact owned fixture row`);
      }
    });
    return result;
  };
}
