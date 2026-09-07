import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
const state=vi.hoisted(()=>({db:null}));
vi.mock('../../src/lib/db/driver.js',()=>({getAdapter:async()=>state.db}));
const {getCascadePolicy,replaceCascadePolicy,validateCascadePairs}=await import('../../src/lib/db/repos/cascadePolicyRepo.js');
let directory,file;
beforeEach(async()=>{
  directory=mkdtempSync(join(tmpdir(),'routing-cascade-')); file=join(directory,'fixture.sqlite');
  state.db=await createNodeSqliteAdapter(file);
  state.db.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE kv(scope TEXT,key TEXT,value TEXT,PRIMARY KEY(scope,key));');
  state.db.run('INSERT INTO settings(id,data) VALUES(1,?)',[JSON.stringify({reasoningPolicy:'retain',cascadePairs:[]})]);
});
afterEach(()=>{state.db.close();rmSync(directory,{recursive:true,force:true});});
it('persists reviewed mappings and immutable receipts without touching other policy, then restores through a fresh revision',async()=>{
  const initial=await getCascadePolicy();
  expect(initial).toMatchObject({pairs:[],includedInRoutingPlanRollback:false,upstreamVerified:false,limits:{promptEstimateExclusive:65536,escalationPinMs:1800000}});
  const applied=await replaceCascadePolicy({expectedRevision:initial.revision,pairs:[{strong:'openai:gpt-4o',cheap:'openai/gpt-4o-mini'}]});
  const reopened=await createNodeSqliteAdapter(file);
  expect(JSON.parse(reopened.get('SELECT data FROM settings').data)).toEqual({reasoningPolicy:'retain',cascadePairs:[{strong:'openai/gpt-4o',cheap:'openai/gpt-4o-mini'}]});
  expect(reopened.all('SELECT * FROM kv')).toHaveLength(1);reopened.close();
  expect((await getCascadePolicy()).revision).toBe(applied.revision);
  await expect(replaceCascadePolicy({expectedRevision:initial.revision,pairs:[]})).rejects.toMatchObject({code:'revision_conflict',status:409});
  const restored=await replaceCascadePolicy({expectedRevision:applied.revision,pairs:[]});
  expect(restored.revision).toBe(initial.revision);
  expect((await getCascadePolicy()).receipts).toHaveLength(2);
  expect((await getCascadePolicy()).receipts.map(row=>row.id)).toEqual([restored.receipt.id,applied.receipt.id]);
});
it('rejects malformed, duplicate, self and oversized mappings before mutation',async()=>{
  const initial=await getCascadePolicy();
  for(const pairs of [null,{},[{strong:'invalid model',cheap:'openai/x'}],[{strong:'openai:x',cheap:'openai/x'}],[{strong:'openai/x',cheap:'openai/y'},{strong:'openai:x',cheap:'openai/z'}],Array.from({length:65},(_,i)=>({strong:`openai/m${i}`,cheap:'openai/x'}))]) {
    expect(()=>validateCascadePairs(pairs)).toThrow();
    await expect(replaceCascadePolicy({expectedRevision:initial.revision,pairs})).rejects.toBeTruthy();
  }
  expect((await getCascadePolicy()).revision).toBe(initial.revision);
  expect(state.db.all('SELECT * FROM kv')).toHaveLength(0);
});
it('normalizes each valid unique mapping without reordering it',()=>{
  expect(validateCascadePairs([{strong:'strong-alias',cheap:'cheap-alias'}])).toEqual([{strong:'strong-alias',cheap:'cheap-alias'}]);
  for(let count=0;count<=64;count++){
    const pairs=Array.from({length:count},(_,i)=>({strong:`openai:m${i}`,cheap:`openai/c${i}`}));
    const normalized=validateCascadePairs(pairs);
    expect(normalized.map(pair=>pair.strong)).toEqual(pairs.map(pair=>pair.strong.replace(':','/')));
    expect(validateCascadePairs(normalized)).toEqual(normalized);
  }
});
it('refuses memory-backed persistence without writing settings or receipts',async()=>{
  const initial=await getCascadePolicy();
  state.db={...state.db,driver:'sql.js'};
  await expect(replaceCascadePolicy({expectedRevision:initial.revision,pairs:[]})).rejects.toMatchObject({code:'durable_storage_required'});
  expect(state.db.all('SELECT * FROM kv')).toHaveLength(0);
});
