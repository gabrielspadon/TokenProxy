import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "../../src/lib/db/driver.js";
import { saveRequestStats } from "../../src/lib/db/repos/requestStatsRepo.js";
import { cleanupContext, getContextOverview, getContextSession, normalizeContextStages, parseContextFilter, updateContextSession } from "../../src/lib/db/repos/contextRepo.js";
import { createNodeSqliteAdapter } from "../../src/lib/db/adapters/nodeSqliteAdapter.js";
import { DATA_FILE } from "../../src/lib/db/paths.js";
import { runMigrationOnce } from "../../src/lib/db/migrate.js";
import { createContextTelemetry } from "../../open-sse/handlers/chatCore/contextTelemetry.js";
import { join } from "node:path";

let db;
const now = new Date().toISOString();
function detail(id, patch = {}) {
  const contextTelemetry = { requestId: id, sessionHash: "a".repeat(32), identitySource: "routing", logicalRequestId: id,
    contextEstimate: 42, inputEstimate: 90, bodyAfterBytes: 260, cachePrefixBytes: 128, clientTool: "codex", requestedModel: "selected-model", attempt: 1,
    stages: [{ stage: "tools", in: 400, out: 400 }, { stage: "rtk", in: 400, out: 240, semanticPreserving: true }, {stage:"inject",in:240,out:260}] };
  return { id, timestamp: now, provider: "test-provider", model: "test-model", connectionId: "account-a", status: "success",
    tokens: { prompt_tokens: 1000, completion_tokens: 25, cached_tokens: 600, cache_creation_input_tokens: 50 },
    ...patch, contextTelemetry: { ...contextTelemetry, ...patch.contextTelemetry } };
}
beforeAll(async () => { db = await getAdapter(); });
beforeEach(() => { db.run("DELETE FROM requestStats"); db.run("DELETE FROM contextSessions"); db.run("DELETE FROM accountSwitches"); db.run("DELETE FROM sessionAffinity"); });

describe("private persisted context lifecycle", () => {
  it("updates one row, rejects a late pending placeholder, and reconciles stage bytes", async () => {
    await saveRequestStats(detail("one", { status:"pending", tokens:null }));
    await saveRequestStats(detail("one"));
    await saveRequestStats(detail("one"));
    await saveRequestStats(detail("one", {status:"pending",tokens:null}));
    const result = await getContextOverview();
    expect(result.summary).toMatchObject({ attempts:1,requests:1,sessions:1,succeeded:1,pending:0,providerInputTokens:1000,cacheReadTokens:600,savedBytes:140,cacheHitRate:0.6 });
    expect(result.stages.reduce((sum,s)=>sum+s.savedBytes,0)).toBe(140);
    const session = await getContextSession(result.sessions[0].id);
    expect(session.turns[0].stages.map(s=>s.stage)).toEqual(["tools","rtk","inject"]);
    expect(session.turns[0].stages[1].risk).toBe("semantic-preserving");
    expect(session.turns[0].providerInputTokens).toBe(1000);
  });
  it("records partial failures once, keeps estimates out of provider totals, and distinguishes missing cache", async () => {
    await saveRequestStats(detail("partial",{status:"aborted",tokens:{prompt_tokens:900,completion_tokens:3}}));
    await saveRequestStats(detail("estimate",{tokens:{prompt_tokens:40,completion_tokens:2,estimated:true}}));
    await saveRequestStats(detail("missing",{status:"error",tokens:null}));
    const result = await getContextOverview();
    expect(result.summary).toMatchObject({attempts:3,failed:2,providerUsageSamples:1,estimatedUsageSamples:1,missingUsageSamples:1,providerInputTokens:900,providerOutputTokens:3,estimatedInputTokens:40,cacheReadTokens:null,cacheHitRate:null});
    const {turns}=await getContextSession(result.sessions[0].id);
    expect(turns.find(t=>t.id==="missing").providerInputTokens).toBeNull();
    expect(turns.find(t=>t.id==="estimate").providerInputTokens).toBeNull();
  });
  it("normalizes cache-exclusive Claude input without double-counting", async () => {
    await saveRequestStats(detail("claude",{tokens:{input_tokens:100,output_tokens:5,cache_read_input_tokens:800,cache_creation_input_tokens:100}}));
    expect((await getContextOverview()).summary).toMatchObject({providerInputTokens:1000,cacheReadTokens:800,cacheWriteTokens:100,cacheHitRate:0.8});
  });
  it("scopes filtering, pagination, models, accounts and retries to identical rows", async () => {
    await saveRequestStats(detail("first",{status:"error",tokens:null,contextTelemetry:{logicalRequestId:"same"}}));
    await saveRequestStats(detail("retry",{connectionId:"account-b",contextTelemetry:{logicalRequestId:"same",attempt:2}}));
    await saveRequestStats(detail("other",{model:"other",contextTelemetry:{sessionHash:"b".repeat(32)}}));
    const f=parseContextFilter(new URLSearchParams("model=test-model&pageSize=1"));
    const result=await getContextOverview(f);
    expect(result.summary).toMatchObject({attempts:2,requests:1,sessions:1});
    expect(result.dimensions.map(d=>d.connectionId).sort()).toEqual(["account-a","account-b"]);
    const session=await getContextSession(result.sessions[0].id,f);
    expect(session.turns).toHaveLength(1);
    expect(session.pagination).toMatchObject({totalItems:2,hasNext:true});
    const next=await getContextSession(result.sessions[0].id,{...f,page:2});
    expect(next.turns[0].id).not.toBe(session.turns[0].id);
  });
  it("joins pins only by full session hash and excludes private identity or prompt data", async () => {
    const entry=detail("safe");entry.contextTelemetry.prompt="SECRET-PROMPT";entry.contextTelemetry.rawSessionId="SECRET-SESSION";
    await saveRequestStats(entry);
    db.run(`INSERT INTO sessionAffinity(sessionHash,model,connectionId,pinnedAt,lastSeenAt) VALUES(?,?,?,?,?)`,["a".repeat(32),"test-model","account-a",now,now]);
    db.run(`INSERT INTO sessionAffinity(sessionHash,model,connectionId,pinnedAt,lastSeenAt) VALUES(?,?,?,?,?)`,["b".repeat(32),"test-model","account-a",now,now]);
    const overview=await getContextOverview();const result=await getContextSession(overview.sessions[0].id);
    expect(result.pins).toHaveLength(1);
    const serialized=JSON.stringify(result);
    expect(serialized).not.toContain("a".repeat(32));expect(serialized).not.toContain("SECRET");
    expect(JSON.stringify(db.all("SELECT * FROM requestStats"))).not.toContain("SECRET");
    await updateContextSession(result.session.id,{projectLabel:"Research"});
    expect((await getContextOverview({projectLabel:"Research"})).summary.attempts).toBe(1);
    await updateContextSession(result.session.id,{projectLabel:null});
    expect((await getContextOverview()).sessions[0].projectLabel).toBeNull();
  });
  it("survives close/reopen and upgrades an old schema without inventing history", async () => {
    await saveRequestStats(detail("durable"));db.close();
    db=await createNodeSqliteAdapter(DATA_FILE);global._dbAdapter.instance=db;
    expect((await getContextOverview()).summary.attempts).toBe(1);
    const old=await createNodeSqliteAdapter(join(process.env.DATA_DIR,"old.sqlite"));
    old.exec("CREATE TABLE requestStats(id TEXT PRIMARY KEY,timestamp TEXT NOT NULL,provider TEXT,model TEXT,connectionId TEXT,status TEXT,promptTokens INTEGER DEFAULT 0,completionTokens INTEGER DEFAULT 0,cachedTokens INTEGER DEFAULT 0,cacheCreationTokens INTEGER DEFAULT 0,reasoningTokens INTEGER DEFAULT 0,latencyTotal INTEGER DEFAULT 0,latencyTtft INTEGER DEFAULT 0)");
    old.run("INSERT INTO requestStats(id,timestamp,promptTokens) VALUES(?,?,?)",["old",now,100]);
    old.exec("CREATE TABLE _meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO _meta VALUES('schemaVersion','1'),('backupSchemaVersion','2')");
    await runMigrationOnce(old);
    expect(old.get("SELECT promptTokens,contextSessionId,usageSource FROM requestStats WHERE id='old'")).toMatchObject({promptTokens:100,contextSessionId:null,usageSource:null});
    old.close();
  });
  it("prunes bounded history and stage/session orphans", async () => {
    await saveRequestStats(detail("recent"));
    await saveRequestStats(detail("old",{timestamp:new Date(Date.now()-50*86400000).toISOString(),contextTelemetry:{sessionHash:"b".repeat(32)}}));
    cleanupContext(db,Date.now(),45);
    expect(db.all("SELECT id FROM requestStats")).toEqual([{id:"recent"}]);
    expect(db.all("SELECT DISTINCT requestId FROM contextStages")).toEqual([{requestId:"recent"}]);
    expect(db.get("SELECT COUNT(*) AS n FROM contextSessions").n).toBe(1);
    expect(JSON.stringify(db.all("EXPLAIN QUERY PLAN SELECT * FROM requestStats WHERE contextSessionId=? ORDER BY timestamp,id LIMIT 50",[1]))).toContain("idx_rs_context_session");
  });
  it("rejects broken stage order and malformed filters", () => {
    expect(()=>normalizeContextStages([{stage:"rtk",in:100,out:50},{stage:"final",in:60,out:40}])).toThrow(/boundaries/);
    for(const query of ["page=0","pageSize=101","from=oops","page=1 OR 1=1","from=2026-09-06T10:00:00Z&to=2026-09-05T10:00:00Z"])expect(()=>parseContextFilter(new URLSearchParams(query))).toThrow();
  });
  it("never guesses a conversation from shared connection or missing session",()=>{
    const a=createContextTelemetry({connectionId:"shared"}),b=createContextTelemetry({connectionId:"shared"});
    expect(a.sessionHash).not.toBe(b.sessionHash);expect(a.identitySource).toBe("request");
  });
});
