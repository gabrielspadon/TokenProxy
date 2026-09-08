import {beforeAll,describe,expect,it,vi} from "vitest";
vi.hoisted(()=>{process.env.JWT_SECRET="context-api-fixture-secret-at-least-thirty-two";process.env.TOKENPROXY_PEER_TOKEN="context-peer-fixture";});
const {GET:overview}=await import("../../src/app/api/context/route.js");
const {GET:session,PATCH:patch}=await import("../../src/app/api/context/sessions/[id]/route.js");
const {createDashboardAuthToken}=await import("../../src/lib/auth/dashboardSession.js");
const {getAdapter}=await import("../../src/lib/db/driver.js");
const {saveRequestStats}=await import("../../src/lib/db/repos/requestStatsRepo.js");
const {getContextOverview}=await import("../../src/lib/db/repos/contextRepo.js");
const {ContextAnalyticsError}=await import("../../src/lib/db/analytics/client.js");
let db,id,cookie;
const req=(path,{method="GET",operator=false,local=false,inference=false,body}={})=>({url:`http://localhost${path}`,method,
 headers:new Headers({...local?{"x-tp-peer-token":"context-peer-fixture","x-tp-real-ip":"127.0.0.1"}:{},...inference?{authorization:"Bearer synthetic-context-inference-key"}:{}}),
 cookies:{get:()=>operator?{value:cookie}:undefined},text:async()=>JSON.stringify(body)});
beforeAll(async()=>{
 db=await getAdapter();cookie=await createDashboardAuthToken();
 db.run(`INSERT INTO apiKeys(id,key,name,isActive,createdAt) VALUES(?,?,?,?,?)`,["context-key","synthetic-context-inference-key","fixture",1,new Date().toISOString()]);
 await saveRequestStats({id:"api-fixture",provider:"fixture",model:"fixture",status:"success",tokens:null,contextTelemetry:{sessionHash:"a".repeat(32),identitySource:"routing",stages:[]}});
 id=(await getContextOverview()).sessions[0].id;
});
describe("context operator API boundary",()=>{
 it("runs project, interval and routing projections through the real bounded worker",async()=>{
  for(const query of ['view=projects&projectSearch=Research','view=interval-comparison&baselineFrom=2026-09-05T00:00:00Z&baselineUntil=2026-09-06T00:00:00Z&from=2026-09-06T00:00:00Z&until=2026-09-07T00:00:00Z']) {
   expect((await overview(req(`/api/context?${query}`))).status).toBe(401);
   const result=await overview(req(`/api/context?${query}`,{operator:true}));
   expect(result.status).toBe(200);
   const body=await result.json();expect(body.freshness.source).toBe('committed-sqlite');expect(JSON.stringify(body)).not.toContain('a'.repeat(32));
   if(body.view==='projects')expect(body.pagination.totalItems).toBeTypeOf('number');
   else {expect(body.baseline.period.start).toBe('2026-09-05T00:00:00.000Z');expect(body.selected.period.end).toBe('2026-09-07T00:00:00.000Z');}
  }
  const result=await session(req(`/api/context/sessions/${id}?view=routing`,{operator:true}),{params:Promise.resolve({id:String(id)})});
  expect(result.status).toBe(200);expect(await result.json()).toMatchObject({view:'routing',sessionId:id,items:[],pagination:{totalItems:0,hasMore:false}});
  expect((await overview(req('/api/context?view=routing',{operator:true}))).status).toBe(400);
  expect((await overview(req('/api/context?view=interval-comparison',{operator:true}))).status).toBe(400);
 });
 it("rejects anonymous and inference keys without disclosing or changing context",async()=>{
  const before=JSON.stringify(db.all("SELECT * FROM contextSessions"));
  for(const handler of [overview,session,patch]){
   const method=handler===patch?"PATCH":"GET";
   const path=handler===overview?"/api/context":`/api/context/sessions/${id}`;
   expect((await handler(req(path,{method,body:{projectLabel:"bad"}}),{params:Promise.resolve({id:String(id)})})).status).toBe(401);
   expect((await handler(req(path,{method,inference:true,body:{projectLabel:"bad"}}),{params:Promise.resolve({id:String(id)})})).status).toBe(403);
  }
  expect(JSON.stringify(db.all("SELECT * FROM contextSessions"))).toBe(before);
 });
 it("requires a verified loopback peer for mutation, returns no-store and hides hashes",async()=>{
  const path=`/api/context/sessions/${id}`;
  expect((await patch(req(path,{method:"PATCH",operator:true,body:{projectLabel:"Research"}}),{params:Promise.resolve({id:String(id)})})).status).toBe(403);
  const written=await patch(req(path,{method:"PATCH",operator:true,local:true,body:{projectLabel:"Research"}}),{params:Promise.resolve({id:String(id)})});
  expect(written.status).toBe(200);
  const result=await session(req(path,{operator:true}),{params:Promise.resolve({id:String(id)})});
  expect(result.headers.get("cache-control")).toBe("no-store");
  const data=await result.json();expect(data.session.projectLabel).toBe("Research");expect(JSON.stringify(data)).not.toContain("a".repeat(32));
 });
 it("validates bounds, absent sessions and unknown mutation fields",async()=>{
  expect((await overview(req("/api/context?pageSize=10000",{operator:true}))).status).toBe(400);
  expect((await session(req("/api/context/sessions/99999",{operator:true}),{params:Promise.resolve({id:"99999"})})).status).toBe(404);
  expect((await patch(req(`/api/context/sessions/${id}`,{method:"PATCH",operator:true,local:true,body:{prompt:"forbidden"}}),{params:Promise.resolve({id:String(id)})})).status).toBe(400);
 });
 it("returns explicit summary projection and overload without leaking worker errors",async()=>{
  const response=await overview(req("/api/context?view=summary",{operator:true}));
  expect(response.status).toBe(200);
  const data=await response.json();expect(data.view).toBe("summary");expect(data).not.toHaveProperty("sessions");expect(data.freshness.source).toBe("committed-sqlite");
  expect((await overview(req("/api/context?view=unknown",{operator:true}))).status).toBe(400);
  const run=vi.spyOn(globalThis._contextAnalytics.client,"run").mockRejectedValue(new ContextAnalyticsError("private worker detail"));
  try {
   const failed=await overview(req("/api/context",{operator:true}));
   expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("private worker detail");
  } finally {run.mockRestore();}
 });
});
