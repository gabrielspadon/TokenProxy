import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.hoisted(()=>{process.env.JWT_SECRET='investigation-fixture-signing-secret-at-least-thirty-two';process.env.TOKENPROXY_PEER_TOKEN='investigation-test-loopback-proof';});
const collection=await import('../../src/app/api/admin/investigations/route');
const single=await import('../../src/app/api/admin/investigations/[id]/route');
const exporter=await import('../../src/app/api/admin/investigations/export/route');
const {createDashboardAuthToken}=await import('../../src/lib/auth/dashboardSession');
const {getAdapter}=await import('../../src/lib/db/driver');
const {INITIAL_SCOPE}=await import('../../src/lib/db/analytics/investigationModel.mjs');
let token,db;
const definition={schemaVersion:1,lens:'economics',scope:INITIAL_SCOPE,comparisonIds:[],selection:{kind:'economics-record',id:'1'}};
const body={name:'Synthetic saved ledger',kind:'bookmark',definition};
function request(path='',method='GET',payload,operator=true,local=true){
  const headers={'content-type':'application/json',...(operator?{cookie:`auth_token=${token}`}:{})};
  if(local){headers['x-tp-peer-token']=process.env.TOKENPROXY_PEER_TOKEN;headers['x-tp-real-ip']='127.0.0.1';}
  return new NextRequest(`http://localhost/api/admin/investigations${path}`,{method,headers,...(payload===undefined?{}:{body:typeof payload==='string'?payload:JSON.stringify(payload)})});
}
beforeAll(async()=>{token=await createDashboardAuthToken();db=await getAdapter();db.run('INSERT INTO usageHistory(id,timestamp,provider,promptTokens,completionTokens,tokens) VALUES(?,?,?,?,?,?)',[1,'2026-09-06T12:00:00.000Z','fixture',100,10,'{"cached_tokens":20,"cache_creation_input_tokens":0}']);});
afterAll(async()=>{await globalThis._contextAnalytics?.client.close();delete globalThis._contextAnalytics;});
describe('Authenticated persistent investigation boundary',()=>{
  it('denies anonymous reads and nonlocal writes before changing storage',async()=>{
    expect((await collection.GET(request('','GET',undefined,false))).status).toBe(401);
    expect((await collection.POST(request('','POST',body,true,false))).status).toBe(403);
    expect(db.all('SELECT * FROM investigations')).toEqual([]);
  });
  it('persists through actual routes, rejects conflicts, and returns no-store',async()=>{
    const created=await collection.POST(request('','POST',body));expect(created.status).toBe(200);
    const row=await created.json();const params={params:Promise.resolve({id:row.id})};
    const read=await single.GET(request(`/${row.id}`),params);expect(read.headers.get('cache-control')).toBe('no-store');expect((await read.json()).definition.selection).toEqual(definition.selection);
    const updated=await single.PUT(request(`/${row.id}`,'PUT',{...body,name:'Updated',version:1}),params);expect((await updated.json()).version).toBe(2);
    expect((await single.PUT(request(`/${row.id}`,'PUT',{...body,version:1}),params)).status).toBe(409);
    expect((await single.DELETE(request(`/${row.id}`,'DELETE',{version:1}),params)).status).toBe(409);
    expect((await single.DELETE(request(`/${row.id}`,'DELETE',{version:2}),params)).status).toBe(200);
    expect((await single.GET(request(`/${row.id}`),params)).status).toBe(404);
  });
  it('bounds bodies and refuses forged ownership or executable query fields',async()=>{
    expect((await collection.POST(request('','POST','x'.repeat(32769)))).status).toBe(413);
    expect((await collection.POST(request('','POST',{...body,ownerScope:'someone'}))).status).toBe(400);
    expect((await exporter.POST(request('/export','POST',{mode:'selected',definition,operation:'sql'}))).status).toBe(400);
  });
  it('exports exact IDs through the actual bounded read worker and retains source bytes',async()=>{
    const before=JSON.stringify(db.all('SELECT * FROM usageHistory'));
    const response=await exporter.POST(request('/export','POST',{mode:'selected',definition}));expect(response.status).toBe(200);
    const result=await response.json();expect(result.items.map(row=>row.id)).toEqual([1]);expect(result.manifest).toMatchObject({complete:true,returnedRecords:1,source:'usageHistory'});expect(result.freshness.source).toBe('committed-sqlite');
    expect(JSON.stringify(db.all('SELECT * FROM usageHistory'))).toBe(before);
  });
});
