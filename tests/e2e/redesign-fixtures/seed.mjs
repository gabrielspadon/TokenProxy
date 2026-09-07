import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TABLES, buildCreateTableSql } from '../../../src/lib/db/schema.js';
import { seedCapacityEconomics } from '../capacity-economics-seed.mjs';
import { seedRoutingCompletion } from '../routing-completion-seed.mjs';
import { bindCapacityEconomicsFixtureCompletions } from '../capacity-economics-completion-bindings.mjs';
import { seedOperationsWorkspace } from '../../fixtures/operations-workspace-v1.mjs';
import { ACCOUNTS, CLOCK, VERSION, SCENARIOS } from './catalog.mjs';
import { seedEdgeCases } from './edge-seed.mjs';
import { seedRepresentative } from './representative-seed.mjs';

export async function seed(root, scenario, { clock = CLOCK } = {}) {
  assert.ok(SCENARIOS[scenario]?.persistence, 'Choose a retained-schema scenario');
  assert.equal(new Date(clock).toISOString(), clock, 'Clock must be canonical UTC');
  const dataDir = join(root, 'runtime', 'db');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(join(dataDir, 'data.sqlite'));
  const db = {
    get: (sql, args = []) => raw.prepare(sql).get(...args),
    all: (sql, args = []) => raw.prepare(sql).all(...args),
    run: (sql, args = []) => raw.prepare(sql).run(...args),
    transaction: fn => { raw.exec('BEGIN IMMEDIATE'); try { const value = fn(); raw.exec('COMMIT'); return value; } catch (error) { raw.exec('ROLLBACK'); throw error; } },
  };
  const accounts = ACCOUNTS.slice(0, SCENARIOS[scenario].accounts);
  try {
    for (const [name, definition] of Object.entries(TABLES)) {
      raw.exec(buildCreateTableSql(name, definition));
      for (const index of definition.indexes || []) raw.exec(index);
    }
    assert.equal(db.get('SELECT COUNT(*) AS count FROM providerConnections').count, 0, 'Seed requires a fresh database');
    db.run('INSERT INTO settings(id,data) VALUES(1,?)', [JSON.stringify({ requireLogin: true, requireApiKey: true, cloudEnabled: false, analyticsEnabled: false, tunnelEnabled: false, tailscaleEnabled: false, freeModelSync: { enabled: false }, quotaAutoPing: { enabled: false }, notifications: { enabled: false }, rtkEnabled: false, memEnabled: false, headroomEnabled: false })]);
    for (const [index, account] of accounts.entries()) db.run('INSERT INTO providerConnections(id,provider,authType,name,priority,isActive,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)', [account.id, account.provider, 'apikey', account.name, index + 1, 0, '{}', CLOCK, CLOCK]);
    let receipt = { version: VERSION, scenario, capturedAt: CLOCK, synthetic: true, upstreamCalls: 0, accounts: accounts.length };
    if (['populated', 'edge-cases', 'representative'].includes(scenario)) {
      receipt.capacity = seedCapacityEconomics(db, { fixtureKind: 'synthetic-fixture' });
      receipt.bindings = bindCapacityEconomicsFixtureCompletions(db, { fixtureKind: 'synthetic-fixture', usageIds: receipt.capacity.usageIds });
      receipt.routing = seedRoutingCompletion(db, { fixtureKind: 'synthetic-fixture' });
      receipt.operations = seedOperationsWorkspace(db, { accountId: 'capacity-fixture-a' });
      if (['edge-cases', 'representative'].includes(scenario)) receipt.edges = seedEdgeCases(db);
      if (scenario === 'representative') receipt.representative = seedRepresentative(db, accounts);
    }
    if (clock !== CLOCK) {
      const offset = Date.parse(clock) - Date.parse(CLOCK);
      const rebase = value => value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, stamp => new Date(Date.parse(stamp) + offset).toISOString());
      db.transaction(() => {
        for (const [table, definition] of Object.entries(TABLES)) {
          const fields = Object.entries(definition.columns).filter(([, type]) => type.includes('TEXT')).map(([field]) => field.replaceAll('"', ''));
          if (!fields.length) continue;
          for (const row of db.all(`SELECT rowid AS fixtureRowId,${fields.map(field => `"${field}"`).join(',')} FROM "${table}"`)) {
            const changed = fields.filter(field => typeof row[field] === 'string' && rebase(row[field]) !== row[field]);
            if (changed.length) db.run(`UPDATE "${table}" SET ${changed.map(field => `"${field}"=?`).join(',')} WHERE rowid=?`, [...changed.map(field => rebase(row[field])), row.fixtureRowId]);
          }
        }
      });
      receipt = JSON.parse(rebase(JSON.stringify(receipt)));
      receipt.clockBasis = 'Dev run UTC anchor; stable identities and relative intervals, compiler clock remains real';
    }
    await writeFile(join(root, 'fixture-manifest.json'), JSON.stringify({ version: VERSION, scenario, capturedAt: clock, accounts, source: 'synthetic-local-policy', inferenceAllowed: false }, null, 2), { mode: 0o600 });
    await writeFile(join(root, 'seed-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    return receipt;
  } finally { raw.close(); }
}
