import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ executor: null }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => mocks.executor }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: async () => Response.json({ choices: [{message:{role:"assistant",content:"fixture"},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:2} }) }));
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getAdapter } = await import("../../src/lib/db/driver.js");

it("measures the incremental default capture cost on actual mocked requests", async () => {
  mocks.executor=new BaseExecutor("openrouter",{baseUrl:"https://fixture.invalid/v1",noAuth:true});
  const db=await getAdapter(), rows=[];
  const stats=(values)=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1]};};
  for (const size of [1024*1024,2*1024*1024]) {
    const text="Precise unicode 日本語 🧭 and exact context. ".repeat(Math.ceil(size/Buffer.byteLength("Precise unicode 日本語 🧭 and exact context. ")));
    const body={model:"openrouter/gpt-4.1",messages:[{role:"assistant",content:text},{role:"user",content:"Current fixture request"}],stream:false};
    const samples={enabled:[],disabled:[]};
    for(let i=0;i<28;i++) for(const enabled of i%2?[true,false]:[false,true]) {
      const start=performance.now();
      const result=await handleChatCore({body,modelInfo:{provider:"openrouter",model:"gpt-4.1"},credentials:{},connectionId:"benchmark",contextStructureEnabled:enabled,
        clientRawRequest:{body,headers:{},endpoint:"/v1/chat/completions"},log:{debug(){},info(){},warn(){},error(){}}});
      await result.response.text(); expect(result.success).toBe(true);
      if(i>=4) samples[enabled?"enabled":"disabled"].push(performance.now()-start);
    }
    rows.push({bodyBytes:Buffer.byteLength(JSON.stringify(body)),enabled:stats(samples.enabled),disabled:stats(samples.disabled)});
  }
  expect(db.get("SELECT COUNT(*) AS n FROM contextStructures").n).toBeGreaterThan(0);
  const sources=["../../open-sse/handlers/chatCore.js","../../open-sse/utils/contextStructure.js","../../src/lib/db/repos/contextEvidenceRepo.js","../../src/lib/db/analytics/contextStructure.mjs"];
  const receipt={recordedAt:new Date().toISOString(),runtime:process.version,platform:process.platform,architecture:process.arch,driver:db.driver,
    warmupPairsPerSize:4,measuredPairsPerSize:24,order:"Alternating enabled-first and disabled-first pairs",quantileMethod:"Sorted upper median; nearest-rank p95",
    configuration:{provider:"openrouter",model:"gpt-4.1",stream:false,providerFetch:"mocked",saverControls:"Core defaults; no optional saver enabled",contextStructureEnabled:"Explicit true versus false",fixture:"Unicode assistant history plus unchanged trailing user request"},
    sourceSha256:Object.fromEntries(sources.map(path=>[path,createHash("sha256").update(readFileSync(new URL(path,import.meta.url))).digest("hex")])),scope:"Actual handleChatCore through BaseExecutor with only upstream fetch mocked; includes clone/translation/capture/persistence and response construction. Alternating enabled/disabled after warmup. No provider/network or cost claim.",rows};
  if(process.env.CONTEXT_BENCHMARK_RECEIPT) writeFileSync(process.env.CONTEXT_BENCHMARK_RECEIPT,JSON.stringify(receipt,null,2)+"\n",{mode:0o600});
  console.log(JSON.stringify(receipt));
});
