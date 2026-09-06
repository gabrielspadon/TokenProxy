import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '@/lib/db/driver.js';
import { createApiKey, updateApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import { getBudgetStatus, reserveBudget } from '@/lib/db/repos/budgetRepo.js';
import { randomUUID } from 'node:crypto';
const db=await getAdapter();
const root=fileURLToPath(new URL('../../',import.meta.url));
const worker=`
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
if(!process.env.DATA_DIR)throw Error('Private DATA_DIR required');
const root=process.env.BUDGET_TEST_ROOT;
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('open-sse/'))return {url:pathToFileURL(join(root,specifier)).href,shortCircuit:true};return next(specifier,context);}});
const {createNodeSqliteAdapter}=await import(pathToFileURL(join(root,'src/lib/db/adapters/nodeSqliteAdapter.js')).href);
global._dbAdapter={instance:await createNodeSqliteAdapter(join(process.env.DATA_DIR,'db/data.sqlite'))};
const {reserveBudget,markBudgetDispatched}=await import(pathToFileURL(join(root,'src/lib/db/repos/budgetRepo.js')).href);
process.on('message',async()=>{try{const row=await reserveBudget({apiKey:process.env.BUDGET_TEST_KEY,requestId:randomUUID(),logicalRequestId:randomUUID()});await markBudgetDispatched(row.requestId);process.send({ok:true,requestId:row.requestId});}catch(e){process.send({ok:false,code:e.code,message:e.message});}});
process.send({ready:true});
`;
function child(key){
 const processChild=spawn(process.execPath,['--input-type=module','-e',worker],{env:{...process.env,DATA_DIR:process.env.DATA_DIR,BUDGET_TEST_ROOT:root,BUDGET_TEST_KEY:key},stdio:['ignore','pipe','pipe','ipc']});
 let stderr='';processChild.stderr.on('data',chunk=>{stderr+=chunk;});
 const ready=new Promise((resolve,reject)=>{processChild.once('message',message=>message.ready?resolve():reject(Error('Unexpected worker message')));processChild.once('error',reject);processChild.once('exit',code=>reject(Error('Worker exited '+code+' '+stderr)));});
 return {processChild,ready,run:()=>new Promise(resolve=>{processChild.once('message',resolve);processChild.send('go');})};
}
describe('separate native process admissions and abrupt death',()=>{
 it('admits one concurrent unknown exposure and preserves it after the owner is killed',async()=>{
  const created=await createApiKey('crash fixture','mock');const key=await updateApiKey(created.id,{maxCompletionTokens:100,budgetPolicy:'reserve-remaining'});
  const workers=Array.from({length:4},()=>child(key.key));
  try{
   await Promise.all(workers.map(w=>w.ready));const results=await Promise.all(workers.map(w=>w.run()));
   expect(results.filter(r=>r.ok)).toHaveLength(1);
   const completed=workers.map(w=>new Promise(resolve=>{w.processChild.once('exit',resolve);w.processChild.kill('SIGKILL');}));await Promise.all(completed);
   const status=await getBudgetStatus(key.id);expect(status.reservations).toHaveLength(1);expect(status.reservations[0].state).toBe('dispatched');expect(status.outstanding.completionTokens).toBe(100);
   await expect(reserveBudget({apiKey:key.key,requestId:randomUUID(),logicalRequestId:randomUUID()})).rejects.toMatchObject({code:'api_key_budget_exceeded'});
   expect(db.get('SELECT COUNT(*) AS n FROM usageHistory WHERE requestId=?',[status.reservations[0].requestId]).n).toBe(0);
  }finally{for(const w of workers)if(w.processChild.exitCode===null&&!w.processChild.killed)w.processChild.kill('SIGKILL');}
 });
});
