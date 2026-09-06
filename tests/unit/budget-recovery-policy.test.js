import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getAdapter } from '@/lib/db/driver.js';
import { exportDb, importDb } from '@/lib/db/index.js';
import { createApiKey, updateApiKey, getApiKeyById } from '@/lib/db/repos/apiKeysRepo.js';
import { reserveBudget, getBudgetStatus, markBudgetDispatched } from '@/lib/db/repos/budgetRepo.js';
import { POST as create } from '@/app/api/keys/route.js';
import { PUT as update } from '@/app/api/keys/[id]/route.js';
let db;
beforeAll(async()=>{db=await getAdapter();});
beforeEach(()=>{for(const t of ['apiKeyBudgetReservations','apiKeyBudgetAccounts','usageHistory','apiKeys'])db.run(`DELETE FROM ${t}`);});
const req=body=>new Request('http://localhost/api/keys',{method:'POST',body:JSON.stringify(body)});
async function make(limits={}) {const k=await createApiKey('recovery','mock');return updateApiKey(k.id,{maxCompletionTokens:100,...limits});}
const reserve=k=>reserveBudget({apiKey:k.key,requestId:randomUUID(),logicalRequestId:'recovery',bounds:{completionTokens:30}});
describe('persistent budget policy and conservative recovery',()=>{
 it('new keys default strict while untouched historical policies are labeled best effort',async()=>{
  const k=await make();expect(k.budgetPolicy).toBe('strict');
  db.run('UPDATE apiKeys SET budgetPolicy=NULL WHERE id=?',[k.id]);
  expect(await getApiKeyById(k.id)).toMatchObject({budgetPolicy:null,effectiveBudgetPolicy:'reserve-remaining',budgetPolicyExplanation:expect.stringMatching(/not a hard cap/)});
 });
 it('API rejects unsupported policy before any creation or mutation',async()=>{
  const before=db.get('SELECT COUNT(*) AS n FROM apiKeys').n;
  expect((await create(req({name:'bad',budgetPolicy:'pretend-hard-cap'}))).status).toBe(400);
  expect(db.get('SELECT COUNT(*) AS n FROM apiKeys').n).toBe(before);
  const k=await make();expect((await update(req({budgetPolicy:'bogus'}),{params:Promise.resolve({id:k.id})})).status).toBe(400);
  expect((await getApiKeyById(k.id)).budgetPolicy).toBe('strict');
 });
 it('native admission flushes durably and restores the previous SQLite sync setting',async()=>{
  const k=await make();const prior=db.get('PRAGMA synchronous').synchronous;
  const original=db.transaction.bind(db);const seen=[];const spy=vi.spyOn(db,'transaction').mockImplementation(fn=>{seen.push(db.get('PRAGMA synchronous').synchronous);return original(fn);});
  try {await reserve(k);expect(seen).toContain(2);expect(db.get('PRAGMA synchronous').synchronous).toBe(prior);}finally{spy.mockRestore();}
 });
 it('SQL.js cannot admit capped requests, while unlimited retains its fast path',async()=>{
  const k=await make();const unlimited=await createApiKey('uncapped','mock');const driver=db.driver;
  db.driver='sql.js';
  try {await expect(reserve(k)).rejects.toMatchObject({code:'durable-storage-required'});expect(await reserve(unlimited)).toBeNull();}
  finally{db.driver=driver;}
  expect(db.get('SELECT COUNT(*) AS n FROM apiKeyBudgetReservations').n).toBe(0);
 });
 it('configuration roundtrip preserves ceilings, policy and existing outstanding exposure',async()=>{
  const k=await make({maxPromptTokens:500,maxCostUsd:3,budgetPolicy:'reserve-remaining',expiresAt:'2099-01-01T00:00:00Z'});
  const r=await reserve(k);await markBudgetDispatched(r.requestId);
  const exported=await exportDb();expect(exported.apiKeys[0]).toMatchObject({maxCompletionTokens:100,maxPromptTokens:500,maxCostUsd:3,budgetPolicy:'reserve-remaining'});
  await importDb(exported);expect((await getBudgetStatus(k.id)).reservations[0].state).toBe('dispatched');
  expect(await getApiKeyById(k.id)).toMatchObject({maxCompletionTokens:100,maxPromptTokens:500,maxCostUsd:3,budgetPolicy:'reserve-remaining'});
 });
 it('legacy configuration import cannot erase an existing stable key ceiling',async()=>{
  const k=await make();await reserve(k);
  await importDb({apiKeys:[{id:k.id,key:k.key,name:k.name,isActive:true,createdAt:k.createdAt}]});
  expect(await getApiKeyById(k.id)).toMatchObject({maxCompletionTokens:100,budgetPolicy:'strict'});
  expect((await getBudgetStatus(k.id)).outstanding.completionTokens).toBe(30);
 });
 it('configuration import refuses ambiguous raw-key reassignment atomically',async()=>{
  const k=await make();await reserve(k);
  await expect(importDb({apiKeys:[{id:'different-id',key:k.key}]})).rejects.toThrow('different stable key ID');
  expect((await getApiKeyById(k.id)).key).toBe(k.key);
  expect((await getBudgetStatus(k.id)).outstanding.completionTokens).toBe(30);
 });
});
