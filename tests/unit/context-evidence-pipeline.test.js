import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.JWT_SECRET = "context-evidence-fixture-signing-secret-0123456789"; process.env.TOKENPROXY_PEER_TOKEN = "context-export-fixture-peer-proof"; });
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), executor: null }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => mocks.executor }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => mocks.fetch(...args) }));
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { saveRequestStats } = await import("../../src/lib/db/repos/requestStatsRepo.js");
const { saverTelemetryHeaders } = await import("../../open-sse/handlers/chatCore/saverHeaders.js");
const { getExceededLimit } = await import("../../src/lib/db/repos/apiKeysRepo.js");
const { cleanupContext } = await import("../../src/lib/db/repos/contextRepo.js");
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { getContextSession } = await import("../../src/lib/db/repos/contextRepo.js");
const { getContextEvents, ingestContextEvent } = await import("../../src/lib/db/repos/contextClientEventsRepo.js");
const { prepareContextCapture, contextEvidenceKey } = await import("../../src/lib/db/repos/contextEvidenceRepo.js");
const { POST } = await import("../../src/app/api/v1/context/events/route.js");
const { GET } = await import("../../src/app/api/context/events/route.js");
const { createDashboardAuthToken } = await import("../../src/lib/auth/dashboardSession.js");
const db = await getAdapter();
const API_KEY = "fixture-key-only", KEY_ID = "fixture-key-id";
const logicalRequestId = randomUUID();
const headers = { "x-tokenproxy-client-id": "private-client", "x-tokenproxy-session-id": "private-session", "x-tokenproxy-task-id": "private-task", "x-tokenproxy-project-id": "private-project" };
const completion = () => Response.json({ choices: [{ message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 25, completion_tokens: 4 } });
function args(extra = {}) {
  const body = { model: "gpt-4o", messages: [{ role: "user", content: "private café question" }], stream: false };
  return { body, modelInfo: { provider: "openrouter", model: "gpt-4o" }, credentials: { sessionHash: "d".repeat(64), sessionIdentitySource: "explicit", apiKey: "upstream-fixture" },
    connectionId: "account-a", apiKey: API_KEY, clientRawRequest: { body: structuredClone(body), headers, endpoint: "/v1/chat/completions" },
    contextTelemetry: { logicalRequestId }, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, ...extra };
}
function event(extra = {}) { return { eventId: randomUUID(), type: "compaction", occurredAt: new Date().toISOString(), clientId: "private-client", clientSessionId: "private-session", taskId: "private-task", projectId: "private-project", beforeTokens: 100, afterTokens: 120, tokenMeasurementMethod: "client-estimate", ...extra }; }
function post(body, key = API_KEY) { return POST(new Request("http://localhost/api/v1/context/events", { method: "POST", headers: key ? { Authorization: `Bearer ${key}` } : {}, body: JSON.stringify(body) })); }
async function finish() {
  for (let i=0;i<100;i++) { const rows = db.all("SELECT * FROM requestStats ORDER BY timestamp,id"); if (rows.length && rows.every((row) => row.status !== "pending")) return rows; await new Promise((resolve) => setTimeout(resolve,5)); }
  throw Error("Mocked request completion did not persist");
}
beforeEach(() => {
  db.run("DELETE FROM contextClientEvents"); db.run("DELETE FROM usageHistory"); db.run("DELETE FROM requestStats"); db.run("DELETE FROM contextSessions"); db.run("DELETE FROM apiKeys");
  for (const [id,key] of [[KEY_ID,API_KEY],["other-key-id","other-fixture-key"]]) db.run("INSERT INTO apiKeys(id,key,createdAt) VALUES(?,?,?)", [id,key,new Date().toISOString()]);
  mocks.fetch.mockReset(); mocks.fetch.mockResolvedValue(completion());
  mocks.executor = new BaseExecutor("openrouter", { baseUrl: "https://fixture.invalid/v1" });
});
afterAll(async () => { await globalThis._contextAnalytics?.client.close(); delete globalThis._contextAnalytics; });

describe("actual request capture, persistence and readonly query", () => {
  it("exports the actual captured attempt and its authenticated client report through the protected read worker", async () => {
    await handleChatCore(args()); const [row]=await finish();
    const report=await (await post(event({requestId:row.id,logicalRequestId,sessionId:row.contextSessionId}))).json();
    const { POST: exportEvidence }=await import("../../src/app/api/admin/investigations/export/route.js");
    const token=await createDashboardAuthToken();
    const request=new NextRequest("http://localhost/api/admin/investigations/export",{method:"POST",headers:{cookie:`auth_token=${token}`,"content-type":"application/json","x-tp-peer-token":process.env.TOKENPROXY_PEER_TOKEN,"x-tp-real-ip":"127.0.0.1"},body:JSON.stringify({mode:"selected",definition:{schemaVersion:1,lens:"context",scope:{period:"all"},selection:{kind:"context-attempt",id:row.id,sessionId:row.contextSessionId},comparisonIds:[]}})});
    const response=await exportEvidence(request); expect(response.status).toBe(200);
    const result=await response.json(); expect(result.items).toHaveLength(1); expect(result.items[0].structures).toHaveLength(3);
    expect(result.items[0].contextSessionId).toBe(row.contextSessionId);
    expect(result.clientEvents.map(e=>e.id)).toEqual([report.event.id]);
    expect(result.freshness.snapshotStartedAt).toBeTruthy();
    expect(JSON.stringify(result)).not.toMatch(/private café|private-client|fixture-key-only|upstream-fixture/);
  });

  it("restores a saved exact comparison and exports both actual attempts and reports in one worker snapshot", async()=>{
    await handleChatCore(args());await finish();mocks.fetch.mockResolvedValue(completion());
    await handleChatCore(args({contextTelemetry:{logicalRequestId:randomUUID()}}));const rows=await finish();expect(rows).toHaveLength(2);
    for (const row of rows) expect((await post(event({requestId:row.id,logicalRequestId:row.logicalRequestId,sessionId:row.contextSessionId}))).status).toBe(201);
    const definition={schemaVersion:2,lens:'context',scope:{period:'all',provider:'deliberately-outside'},selection:{kind:'context-attempt',id:rows[1].id,sessionId:rows[1].contextSessionId},context:{baseline:{id:rows[0].id,sessionId:rows[0].contextSessionId}},comparisonIds:[]};
    const token=await createDashboardAuthToken();
    const request=(path,body)=>new NextRequest(`http://localhost/api/admin/investigations${path}`,{method:'POST',headers:{cookie:`auth_token=${token}`,'content-type':'application/json','x-tp-peer-token':process.env.TOKENPROXY_PEER_TOKEN,'x-tp-real-ip':'127.0.0.1'},body:JSON.stringify(body)});
    const collection=await import('../../src/app/api/admin/investigations/route.js');
    const saved=await (await collection.POST(request('',{name:'Synthetic exact pair',kind:'investigation',definition}))).json();expect(saved.definition.context.baseline).toEqual(definition.context.baseline);
    const exporter=await import('../../src/app/api/admin/investigations/export/route.js');
    const response=await exporter.POST(request('/export',{mode:'attempt-comparison',definition:saved.definition}));expect(response.status).toBe(200);
    const result=await response.json();expect(result.items.map(row=>row.id).sort()).toEqual(rows.map(row=>row.id).sort());expect(result.items.every(row=>row.structures.length===3)).toBe(true);
    expect(result.clientEvents).toHaveLength(2);expect(result.manifest).toMatchObject({comparisonComplete:true,missingAttempts:[]});expect(result.freshness.snapshotStartedAt).toBeTruthy();
  });

  it("links exact physical UUIDs, content-free boundaries and explicit identity through the worker", async () => {
    const input=args(), before=structuredClone(input.body);
    const result=await handleChatCore(input); expect(result.response.status).toBe(200);
    const [row]=await finish();
    expect(result.response.headers.get("x-tokenproxy-request-id")).toBe(row.id);
    expect(result.response.headers.get("x-tokenproxy-logical-request-id")).toBe(logicalRequestId);
    expect(result.response.headers.get("access-control-expose-headers")).toContain("x-tokenproxy-request-id");
    expect(row.clientKeyId).toBe(KEY_ID); expect(row.clientIdentitySource).toBe("client-reported");
    expect(row.clientRef).toMatch(/^ctx1_[a-f0-9]{64}$/); expect(input.body).toEqual(before);
    const view=await getContextSession(row.contextSessionId,{page:1,pageSize:25,clientRef:row.clientRef});
    expect(view.turns).toHaveLength(1); expect(view.turns[0].structures).toHaveLength(3);
    const dispatch=view.turns[0].structures.find((s)=>s.boundary==="physical-dispatch");
    expect(dispatch.bodyBytes).toBe(Buffer.byteLength(mocks.fetch.mock.calls[0][1].body));
    expect(view.turns[0].explicitIdentity.taskRef).toBe(row.taskRef);
    expect(JSON.stringify(view.turns[0].structures)).not.toMatch(/private|café|fixture-key|upstream/);
    expect((await getContextSession(row.contextSessionId,{clientRef:"ctx1_"+"0".repeat(64)})).turns).toHaveLength(0);
  });
  it("keeps client and gateway evidence with each retry but never carries forward old dispatch evidence", async () => {
    mocks.executor = new BaseExecutor("openrouter", { baseUrl: "https://fixture.invalid/v1", noAuth: true, retry: { 503: { attempts: 1, delayMs: 0 } } });
    mocks.fetch.mockResolvedValueOnce(Response.json({error:{message:"unavailable"}},{status:503,headers:{'x-tokenproxy-replay-safe':'true'}})).mockResolvedValueOnce(completion());
    const result=await handleChatCore(args()); const rows=await finish();
    expect(rows).toHaveLength(2); expect(new Set(rows.map((r)=>r.id)).size).toBe(2);
    expect(rows.every((r)=>r.logicalRequestId===logicalRequestId)).toBe(true);
    expect(result.response.headers.get("x-tokenproxy-request-id")).toBe(rows.find((r)=>r.status==="success").id);
    expect(db.get("SELECT COUNT(*) AS n FROM contextStructures").n).toBe(6);
  });
  it("disabled measurements preserve authenticated identity without serializing or inventing structures", async () => {
    const body={}; body.self=body;
    const capture=await prepareContextCapture({body,apiKey:API_KEY,headers,enabled:false});
    expect(capture.initial).toBeNull(); expect(capture.identity.clientKeyId).toBe(KEY_ID);
    const result=await handleChatCore(args({contextStructureEnabled:false})); expect(result.response.status).toBe(200);
    const [row]=await finish(); expect(row.clientKeyId).toBe(KEY_ID);
    expect(db.get("SELECT COUNT(*) AS n FROM contextStructures").n).toBe(0);
  });
  it("keeps physical refusal identity and missing usage honest", async () => {
    mocks.fetch.mockResolvedValue(Response.json({error:{message:"fixture refusal"}},{status:403}));
    const result=await handleChatCore(args()); const [row]=await finish();
    expect(result.response.status).toBe(403); expect(result.response.headers.get("x-tokenproxy-request-id")).toBe(row.id);
    expect(row.usageSource).toBe("missing"); expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
    expect(saverTelemetryHeaders({requestId:"unknown",logicalRequestId:"bad"})).toEqual({});
  });
  it("isolates rejected structural metrics from authoritative partial usage", async () => {
    const id=randomUUID();
    await saveRequestStats({id,status:"aborted",provider:"fixture",model:"fixture",tokens:{prompt_tokens:37,completion_tokens:2},contextTelemetry:{sessionHash:"f".repeat(64),structures:[{version:1,boundary:"physical-dispatch",bodyBytes:-1}]}});
    expect(db.get("SELECT promptTokens,completionTokens,contextTelemetryError FROM requestStats WHERE id=?",[id])).toMatchObject({promptTokens:37,completionTokens:2,contextTelemetryError:"invalid-metrics"});
    expect(db.get("SELECT COUNT(*) AS n FROM contextStructures").n).toBe(0);
  });
  it("keeps stored structure private on corrupted rows and survives reader restarts", async () => {
    await handleChatCore(args()); const [row]=await finish();
    const first=await getContextSession(row.contextSessionId);
    await globalThis._contextAnalytics.client.close(); delete globalThis._contextAnalytics;
    expect((await getContextSession(row.contextSessionId)).turns[0].structures).toEqual(first.turns[0].structures);
    db.run("UPDATE contextStructures SET data=? WHERE requestId=? AND boundary='physical-dispatch'",[JSON.stringify({prompt:"private-corruption"}),row.id]);
    const after=await getContextSession(row.contextSessionId);
    expect(after.turns[0].structures).toHaveLength(2); expect(JSON.stringify(after)).not.toContain("private-corruption");
  });
  it("reuses a matching prepared body across boundaries without reserializing it", async () => {
    const body={messages:[{role:"user",content:"fixture"}]};
    const prepared=JSON.stringify(body);
    const capture=await prepareContextCapture({body,apiKey:API_KEY,headers});
    const stringify=vi.spyOn(JSON,"stringify");
    expect(capture.capture(body,"gateway-shaped",prepared).bodyBytes).toBe(Buffer.byteLength(prepared));
    expect(capture.capture(body,"physical-dispatch",prepared).bodyBytes).toBe(Buffer.byteLength(prepared));
    expect(stringify).not.toHaveBeenCalled(); stringify.mockRestore();
  });
  it("anonymous and malformed client reports never produce inferred client identities", async () => {
    const anonymous=await prepareContextCapture({body:{},enabled:false});
    expect(anonymous.identity.clientRef).toBeUndefined();
    const rejected=await prepareContextCapture({body:{},apiKey:API_KEY,headers:{"x-tokenproxy-client-id":"/private/path"},enabled:false});
    expect(rejected.identity).toEqual({clientKeyId:KEY_ID,clientIdentitySource:"rejected-client-report"});
    const salt=contextEvidenceKey(db); expect(contextEvidenceKey(db).equals(salt)).toBe(true);
  });
});

describe("explicit client-reported event boundary", () => {
  it("persists linked events, exact duplicates and signed client estimates without claiming verification", async () => {
    await handleChatCore(args()); const [row]=await finish(); const body=event({requestId:row.id,logicalRequestId,sessionId:row.contextSessionId});
    const first=await post(body); expect(first.status).toBe(201); const record=await first.json();
    expect(record.event).toMatchObject({requestId:row.id,contextSessionId:row.contextSessionId,source:"client-reported",providerVerified:false,beforeTokens:100,afterTokens:120});
    expect((await post(body)).status).toBe(200);
    expect((await post({...body,afterTokens:10})).status).toBe(409);
    expect(db.get("SELECT COUNT(*) AS n FROM contextClientEvents").n).toBe(1);
    const view=await getContextEvents({requestId:row.id,page:1,pageSize:1});
    expect(view.events[0].id).toBe(record.event.id); expect(view.events[0].model).toBe("gpt-4o");
    expect(view.freshness.snapshotStartedAt).toBeTruthy();
    expect(JSON.stringify(db.all("SELECT * FROM contextClientEvents"))).not.toMatch(/private-client|private-task|private-session|private-project|fixture-key-only/);
  });
  it("accepts unpaid outcome reporting after the authenticated key exhausts its inference budget", async () => {
    db.run("UPDATE apiKeys SET maxPromptTokens=10,maxCostUsd=1 WHERE id=?",[KEY_ID]);
    db.run("INSERT INTO usageHistory(timestamp,provider,model,apiKey,promptTokens,completionTokens,cost,status) VALUES(?,?,?,?,?,?,?,?)",[new Date().toISOString(),"fixture","fixture",API_KEY,11,0,2,"ok"]);
    expect(await getExceededLimit(API_KEY)).toBeTruthy();
    expect((await post(event())).status).toBe(201);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("prunes expired event evidence through the indexed observation time", async () => {
    const saved=await ingestContextEvent(API_KEY,event());
    const old=new Date(Date.now()-50*86400000).toISOString();
    db.run("UPDATE contextClientEvents SET occurredAt=? WHERE id=?",[old,saved.event.id]);
    cleanupContext(db,Date.now(),45);
    expect(db.get("SELECT COUNT(*) AS n FROM contextClientEvents").n).toBe(0);
    expect(JSON.stringify(db.all("EXPLAIN QUERY PLAN DELETE FROM contextClientEvents WHERE occurredAt<?",[old]))).toContain("idx_cce_time");
  });
  it("requires a live API key even on loopback and does not leak foreign request links", async () => {
    expect((await post(event(),null)).status).toBe(401);
    db.run("UPDATE apiKeys SET isActive=0 WHERE id=?",[KEY_ID]); expect((await post(event())).status).toBe(401);
    db.run("UPDATE apiKeys SET isActive=1,expiresAt='2000-01-01T00:00:00Z' WHERE id=?",[KEY_ID]); expect((await post(event())).status).toBe(401);
    db.run("UPDATE apiKeys SET expiresAt=NULL WHERE id=?",[KEY_ID]);
    await handleChatCore(args()); const [row]=await finish();
    const foreign=await post(event({requestId:row.id}),"other-fixture-key");
    const missing=await post(event({requestId:randomUUID()}),"other-fixture-key");
    expect(foreign.status).toBe(404); expect(await foreign.json()).toEqual(await missing.json());
    expect((await post(event({requestId:row.id,logicalRequestId:randomUUID()}))).status).toBe(404);
    expect((await post(event({requestId:row.id,sessionId:row.contextSessionId+1}))).status).toBe(404);
    expect((await post(event({requestId:row.id,clientId:"different-client"}))).status).toBe(404);
  });
  it.each([{prompt:"private"},{beforeTokens:-1},{afterTokens:1.5},{tokenMeasurementMethod:null},{occurredAt:"2026-01-01"},{occurredAt:"2000-01-01T00:00:00Z"},{type:"prefix_change"},{sessionId:1},{targetClientId:"target"}])("rejects unsupported or ambiguous evidence %j", async (change) => {
    expect((await post(event(change))).status).toBe(400); expect(db.get("SELECT COUNT(*) AS n FROM contextClientEvents").n).toBe(0);
  });
  it("bounds actual request bytes independently of declared content length", async () => {
    const result=await post({padding:"x".repeat(17000)}); expect(result.status).toBe(413);
  });
  it("filters all retained events before pagination, preserves unknown routing and authorizes admin reads", async () => {
    const at=new Date().toISOString();
    for(let i=0;i<3;i++) await ingestContextEvent(API_KEY,event({occurredAt:at,taskId:i===2?"other-task":"private-task"}));
    const all=await getContextEvents({page:1,pageSize:1}); expect(all.pagination.totalItems).toBe(3);
    expect(all.events[0].provider).toBeNull(); expect(all.events[0].linkStatus).toBe("unlinked");
    const row=db.get("SELECT taskRef FROM contextClientEvents GROUP BY taskRef HAVING COUNT(*)=2");
    const second=await getContextEvents({taskRef:row.taskRef,page:2,pageSize:1}); expect(second.pagination.totalItems).toBe(2); expect(second.events).toHaveLength(1);
    expect((await getContextEvents({until:at})).pagination.totalItems).toBe(0);
    const denied=await GET(new Request("http://localhost/api/context/events")); expect(denied.status).toBeGreaterThanOrEqual(400);
    const token=await createDashboardAuthToken();
    const response=await GET({url:"http://localhost/api/context/events?pageSize=1",method:"GET",headers:new Headers(),cookies:{get:()=>({value:token})}});
    expect(response.status).toBe(200); expect((await response.json()).pagination.totalItems).toBe(3);
  });
  it("records explicit handoff targets and task outcomes with independent provenance", async () => {
    const base={beforeTokens:null,afterTokens:null,tokenMeasurementMethod:null};
    const handoff=await ingestContextEvent(API_KEY,event({...base,type:"handoff",targetClientId:"receiver",targetTaskId:"target-task"}));
    expect(handoff.event.targetClientRef).toMatch(/^ctx1_/); expect(handoff.event.targetTaskRef).toMatch(/^ctx1_/);
    const outcome=await ingestContextEvent(API_KEY,event({...base,type:"task_outcome",outcome:"failure"}));
    expect(outcome.event.outcome).toBe("failure"); expect(outcome.event.providerVerified).toBe(false);
  });
});
