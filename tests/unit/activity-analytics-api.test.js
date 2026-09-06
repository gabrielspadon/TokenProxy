import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env.JWT_SECRET='activity-fixture-signing-secret-at-least-thirty-two'; });
const { GET } = await import('../../src/app/api/analytics/route.js');
const { createDashboardAuthToken } = await import('../../src/lib/auth/dashboardSession.js');
const { getAdapter } = await import('../../src/lib/db/driver.js');
let db, token;
const request = (path,{operator=false,inference=false}={}) => ({url:`http://localhost${path}`,method:'GET',
  headers:new Headers(inference?{authorization:'Bearer analytics-synthetic-inference-key'}:{}),
  cookies:{get:()=>operator?{value:token}:undefined}});
beforeAll(async()=>{
  db=await getAdapter();token=await createDashboardAuthToken();
  db.run('INSERT INTO apiKeys(id,key,isActive,createdAt) VALUES(?,?,?,?)',['analytics-key','analytics-synthetic-inference-key',1,new Date().toISOString()]);
  db.run('INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cachedTokens,cacheCreationTokens,latencyTotal) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ['a1','2026-09-06T12:00:00.000Z','fixture','model','account','success',100,10,50,20,1000]);
  db.run('INSERT INTO usageHistory(timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,tokens) VALUES(?,?,?,?,?,?,?,?,?)',
    ['2026-09-06T12:00:00.000Z','fixture','model','account','ok',100,10,0.001,'{"cached_tokens":50,"cache_creation_input_tokens":20}']);
});
afterAll(async()=>{await globalThis._contextAnalytics?.client.close();delete globalThis._contextAnalytics;});
describe('operator analytics boundary and actual worker',()=>{
  it('rejects anonymous and inference-only clients before exposing the ledger',async()=>{
    expect((await GET(request('/api/analytics'))).status).toBe(401);
    expect((await GET(request('/api/analytics',{inference:true}))).status).toBe(403);
  });
  it('reads both named views through the shared read-only worker',async()=>{
    for(const view of ['activity','economics']){
      const response=await GET(request(`/api/analytics?view=${view}&groupBy=account`,{operator:true}));
      expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
      const value=await response.json();
      expect(value.summary).toMatchObject({records:1,inputTokens:100,cacheReadTokens:50,cacheWriteTokens:20,outputTokens:10});
      expect(value.groups[0].connectionId).toBe('account');
      expect(value.freshness.source).toBe('committed-sqlite');
      expect(value.series.points[0].bucketStart).toBe('2026-09-06T12:00:00.000Z');
      expect(JSON.stringify(value)).not.toContain('analytics-synthetic-inference-key');
    }
  });
  it('validates unknown, duplicate and reserved parameters before querying',async()=>{
    for(const query of ['sql=SELECT','operation=overview','view=activity&view=economics','pageSize=1000','groupBy=apiKey','provider=%00','__proto__=unknown']){
      expect((await GET(request(`/api/analytics?${query}`,{operator:true}))).status).toBe(400);
    }
  });
  it('leaves source rows unchanged after filtered aggregate reads',async()=>{
    const before=JSON.stringify(db.all('SELECT * FROM requestStats'));
    await GET(request('/api/analytics?provider=absent&start=2026-09-06T11:00:00Z&end=2026-09-06T13:00:00Z',{operator:true}));
    expect(JSON.stringify(db.all('SELECT * FROM requestStats'))).toBe(before);
  });
});
