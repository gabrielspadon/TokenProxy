import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir=process.env.DATA_DIR;
let tempDir;
beforeEach(() => {
  tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenproxy-completion-migration-'));
  process.env.DATA_DIR=tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});
afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  fs.rmSync(tempDir,{recursive:true,force:true});
  if (originalDataDir===undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR=originalDataDir;
});

describe('schema 20 to 21 exact completion binding', () => {
  it('backs up before additive migration and preserves legacy identity as unavailable', async () => {
    const {getAdapter}=await import('@/lib/db/driver.js');
    const db=await getAdapter();
    const ts='2026-09-01T00:00:00.000Z',meta=JSON.stringify({costLedgerId:'cafebabe'});
    db.run('INSERT INTO costLedger(id,ts,baselineUsd,actualUsd,savedUsd) VALUES(?,?,?,?,?)',['cafebabe',ts,1,2,-1]);
    db.run('INSERT INTO usageHistory(timestamp,requestId,meta) VALUES(?,?,?)',[ts,'cafebabe',meta]);
    db.exec('DROP INDEX idx_cl_completion');
    db.exec('DROP INDEX idx_uh_completion');
    db.exec('ALTER TABLE costLedger DROP COLUMN completionId');
    db.exec('ALTER TABLE usageHistory DROP COLUMN completionId');
    db.run("UPDATE _meta SET value='20' WHERE key='backupSchemaVersion'");
    db.flush?.(); db.close?.();
    delete global._dbAdapter; vi.resetModules();
    const {getAdapter:boot}=await import('@/lib/db/driver.js');
    const migrated=await boot();
    const backups=fs.readdirSync(path.join(tempDir,'db','backups')).filter(name=>name.startsWith('schema-20-to-21'));
    expect(backups).toHaveLength(1);
    expect(fs.existsSync(path.join(tempDir,'db','backups',backups[0],'data.sqlite'))).toBe(true);
    expect(migrated.get('SELECT id,ts,completionId FROM costLedger')).toEqual({id:'cafebabe',ts,completionId:null});
    expect(migrated.get('SELECT timestamp,requestId,meta,completionId FROM usageHistory')).toEqual({timestamp:ts,requestId:'cafebabe',meta,completionId:null});
    expect(migrated.all("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_cl_completion','idx_uh_completion')")).toHaveLength(2);
    const {attachCounterfactualEvidence}=await import('@/lib/db/analytics/counterfactualEvidence.mjs');
    const legacy={requestId:'cafebabe',costLedgerId:'cafebabe',completionId:null};
    attachCounterfactualEvidence(migrated,[legacy]);
    expect(legacy.counterfactual.state).toBe('identity-unavailable');
  });
});
