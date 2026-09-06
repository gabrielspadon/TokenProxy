import { beforeEach, expect, it, vi } from 'vitest';
const auth=vi.hoisted(()=>({guard:vi.fn()}));
vi.mock('../../src/lib/admin/guard.js',()=>({requireAdmin:auth.guard}));
import { GET,POST } from '../../src/app/api/admin/budgets/route.js';
import { getAdapter } from '../../src/lib/db/driver.js';
import { createApiKey,updateApiKey } from '../../src/lib/db/repos/apiKeysRepo.js';
import { reserveBudget } from '../../src/lib/db/repos/budgetRepo.js';
import { randomUUID } from 'node:crypto';
const db=await getAdapter();
beforeEach(()=>{auth.guard.mockResolvedValue(null);});
it('rejects before reading a mutation body or touching budget state',async()=>{
 const denied=Response.json({error:'unauthorized'},{status:401});auth.guard.mockResolvedValue(denied);
 const request={json:vi.fn()};expect(await POST(request)).toBe(denied);expect(request.json).not.toHaveBeenCalled();
});
it('pages operator-scoped reservations and requires evidence to release one',async()=>{
 const k=await createApiKey('operator fixture','mock');await updateApiKey(k.id,{maxCompletionTokens:10,budgetPolicy:'reserve-remaining'});
 const r=await reserveBudget({apiKey:k.key,requestId:randomUUID(),logicalRequestId:randomUUID()});
 const response=await GET(new Request(`http://localhost/api/admin/budgets?apiKeyId=${k.id}&limit=1`));const body=await response.json();
 expect(body.reservations).toHaveLength(1);expect(JSON.stringify(body)).not.toContain(k.key);
 const req=evidence=>new Request('http://localhost/api/admin/budgets',{method:'POST',body:JSON.stringify({apiKeyId:k.id,requestId:r.requestId,evidence})});
 expect((await POST(req({kind:'timeout',reference:'old'}))).status).toBe(400);
 expect(db.get('SELECT state FROM apiKeyBudgetReservations WHERE requestId=?',[r.requestId]).state).toBe('reserved');
 expect((await POST(req({kind:'proven-no-dispatch',reference:'fixture-pre-send-failure'}))).status).toBe(200);
 expect(db.get('SELECT state FROM apiKeyBudgetReservations WHERE requestId=?',[r.requestId]).state).toBe('released');
});
it('GET rejects duplicate or unknown filters and never initializes history on read',async()=>{
 const k=await createApiKey('read fixture','mock');await updateApiKey(k.id,{maxCompletionTokens:10});
 const before=db.get('SELECT COUNT(*) AS n FROM apiKeyBudgetAccounts').n;
 for(const query of [`apiKeyId=${k.id}&apiKeyId=${k.id}`,`apiKeyId=${k.id}&unknown=x`,`apiKeyId=${k.id}&limit=1000`,`apiKeyId=${k.id}&before=${'x'.repeat(129)}`]){
  const r=await GET(new Request('http://localhost/api/admin/budgets?'+query));expect(r.status).toBe(400);expect(r.headers.get('cache-control')).toBe('no-store');
 }
 const response=await GET(new Request(`http://localhost/api/admin/budgets?apiKeyId=${k.id}`));expect(await response.json()).toMatchObject({account:null,basis:'basis-uninitialized'});
 expect(db.get('SELECT COUNT(*) AS n FROM apiKeyBudgetAccounts').n).toBe(before);
});
it('mutation size is bounded independently of its declared length',async()=>{
 const body=JSON.stringify({apiKeyId:'fixture',requestId:'fixture',evidence:{kind:'provider-usage',reference:'x'.repeat(33000)}});
 const response=await POST(new Request('http://localhost/api/admin/budgets',{method:'POST',body}));
 expect(response.status).toBe(413);expect(response.headers.get('cache-control')).toBe('no-store');
});
