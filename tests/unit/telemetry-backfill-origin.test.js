import { expect, it } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { ensureStatsBackfilled, getStatsItems } from '../../src/lib/db/repos/requestStatsRepo.js';
import { createQuarantineManifest, applyQuarantine, revertQuarantine } from '../../src/lib/db/repos/telemetryQuarantineRepo.js';

it('copies trusted origin and exact source IDs during backfill, with reversible source exclusions', async () => {
  const db = await getAdapter(), ids = [];
  const at = new Date().toISOString(), evidence = 'Exact source fixture receipts';
  expect(db.get('SELECT COUNT(*) AS n FROM requestStats').n).toBe(0);
  for (const origin of ['unknown', 'production', 'import', 'test']) {
    const row = db.run("INSERT INTO usageHistory(timestamp,provider,model,promptTokens,completionTokens,tokens,dataOrigin) VALUES(?,'fixture','fixture',10,5,'{}',?)", [at, origin]);
    ids.push(String(row.lastInsertRowid));
  }
  const receipt = createQuarantineManifest(db, { evidence, rows: [{ sourceTable: 'usageHistory', rowId: ids[0] }] });
  applyQuarantine(db, receipt, { evidence });
  await ensureStatsBackfilled();
  const stored = db.all('SELECT id,sourceUsageId,dataOrigin FROM requestStats ORDER BY sourceUsageId');
  expect(stored).toEqual(ids.map((id, index) => ({ id: `bh-${id}`, sourceUsageId: Number(id), dataOrigin: ['unknown', 'production', 'import', 'test'][index] })));
  const during = JSON.stringify(await getStatsItems());
  expect(during).not.toContain(`bh-${ids[0]}"`);
  expect(during).not.toContain(`bh-${ids[3]}"`);
  expect(during).toContain(`bh-${ids[1]}"`);
  revertQuarantine(db, receipt, { evidence });
  expect(JSON.stringify(await getStatsItems())).toContain(`bh-${ids[0]}"`);
  expect(db.get('SELECT COUNT(*) AS n FROM requestStats').n).toBe(4);
  expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(4);
});
