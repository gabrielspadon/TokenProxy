import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ fail: new Set(), execute: vi.fn(), visited: new Set() }));
const probe = vi.hoisted(() => (stage) => { state.visited.add(stage); if (state.fail.has(stage)) throw new Error('PRIVATE-CONTEXT-DO-NOT-RETAIN'); });
vi.mock('../../open-sse/executors/index.js', () => ({ getExecutor: () => ({ noAuth:true, execute:state.execute }) }));
vi.mock('../../open-sse/utils/schemaDistiller.js', async original => ({ ...(await original()), distillToolSchemas: (...args) => { probe('schema'); return ({tools: args[0],savedBytes:0}); } }));
vi.mock('../../open-sse/utils/thinkingStrip.js', async original => ({ ...(await original()), stripHistoricalThinking: (...args) => { probe('thinking'); return ({messages:args[0],stripped:0,notes:[]}); } }));
vi.mock('../../open-sse/utils/queryAwareCompress.js', async original => ({ ...(await original()), compressPrefixByQuery: (...args) => { probe('qac'); return ({messages:args[0],compressed:state.fail.has("midinject")?1:0,added:0,notes:[]}); } }));
vi.mock('../../open-sse/utils/pairDropper.js', async original => ({ ...(await original()), dropOldestPairs: (...args) => { probe('pairs'); return ({messages:args[0],droppedPairs:0}); } }));
vi.mock('../../open-sse/utils/dietPrune.js', async original => ({ ...(await original()), pruneExpiredToolResults: (...args) => { probe('diet'); return ({messages:args[0].messages,applied:false}); } }));
vi.mock('../../open-sse/utils/midPrefixInject.js', async original => ({ ...(await original()), injectBoundaryNote: (...args) => { probe('midinject'); return ({messages:args[0],injected:false}); } }));
vi.mock('../../open-sse/utils/toolFilter.js', async original => ({ ...(await original()), toolFilter: (...args) => { probe('tools'); return args[0]; } }));
vi.mock('../../open-sse/utils/epochCompact.js', async original => ({ ...(await original()), computeEpochCutIndex:()=>1,
 microcompact:body=>{probe('epochMicro');return {messages:body.messages,applied:false};},
 autocompact:async body=>{probe('epochAuto');return {messages:body.messages,applied:false};} }));
vi.mock('../../open-sse/utils/linguaCompress.js', async original => ({ ...(await original()), compressBlobs:async body=>{probe('lingua');return {messages:body.messages,applied:false};} }));
vi.mock('../../open-sse/utils/embedReorder.js', async original => ({ ...(await original()), reorderByRelevance:async messages=>{probe('reorder');return {messages,moved:0};} }));
vi.mock('../../open-sse/utils/privacyFilter.js', async original => ({ ...(await original()), redactOutbound:()=>{probe('privacy');return null;} }));
vi.mock('../../open-sse/rtk/index.js', async original => ({ ...(await original()), compressMessages:()=>{probe('rtk');return null;} }));
vi.mock('../../open-sse/rtk/caveman.js', async original => ({ ...(await original()), injectCaveman:()=>{probe('inject');return false;} }));
vi.mock('../../open-sse/rtk/pxpipe.js', async original => ({ ...(await original()), compressWithPxpipe:async()=>{probe('pxpipe');return {summary:{applied:false}};} }));
vi.mock('../../open-sse/rtk/headroom.js', async original => ({ ...(await original()), compressWithHeadroom:async()=>{probe('headroom');return null;} }));
vi.mock('../../open-sse/services/memory/index.js',()=>({applyMemoryEnhancements:async body=>{probe('mem');return {body,stats:{budget:{overAfter:true}}};}}));
vi.mock('../../src/lib/db/repos/shapingHandoffsRepo.js', async original => ({ ...(await original()), pendingShapingHandoffs: async () => { probe('handoff'); return []; } }));
const {handleChatCore}=await import('../../open-sse/handlers/chatCore.js');
const {getAdapter}=await import('../../src/lib/db/driver.js');
const db=await getAdapter();
function options() { return {body:{model:'claude-3-5-sonnet-20241022',stream:false,max_tokens:8,tools:[{name:'fixture',input_schema:{type:'object',properties:{}}}],
 messages:[{role:'user',content:'Earlier question context'}, {role:'assistant',content:'Earlier response'}, {role:'user',content:'Current question context'}]},
 modelInfo:{provider:'anthropic-compatible-audit',model:'claude-3-5-sonnet-20241022'},credentials:{apiKey:'fixture',sessionHash:'e'.repeat(64)},connectionId:'stage-fixture',contextStructureEnabled:false,
 contextTelemetry:{logicalRequestId:'stage-logical'},clientRawRequest:{headers:{},body:{model:'claude-3-5-sonnet-20241022'}},
 schemaDistillEnabled:true,thinkingStripEnabled:true,rtkEnabled:true,privacyEnabled:true,privacyTerms:[],cavemanEnabled:true,cavemanLevel:'lite',
 pxpipeEnabled:true,headroomEnabled:true,headroomUrl:'http://localhost:8787',memorySettings:{memoryContextWindowOverride:1,memoryHandoffEnabled:true},
 queryAwareCompressionEnabled:true,pairDropEnabled:true,dietEnabled:true,linguaEnabled:true,epochMicroEnabled:true,epochAutoEnabled:true,embedReorderEnabled:true,midPrefixInjectEnabled:true,
 toolDisclosure:{filterEnabled:true},log:{debug(){},info(){},warn(){},error(){}}}; }
beforeEach(()=>{state.fail.clear();state.visited.clear();state.execute.mockReset();state.execute.mockImplementation(async({body})=>({body,response:Response.json({id:'fixture',type:'message',role:'assistant',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:1}})}));});
const stages=['tools','schema','thinking','rtk','privacy','inject','pxpipe','mem','headroom','qac','pairs','diet','lingua','epochMicro','epochAuto','reorder','midinject','handoff'];
describe('gateway optional stage fault isolation',()=>{
 for(const stage of stages) it(`records ${stage} failure and dispatches exactly once`,async()=>{
  const warm=await handleChatCore(options());await warm.response.text();
  db.run('DELETE FROM requestStats');state.execute.mockClear();state.visited.clear();state.fail.add(stage);
  const args=options(), before=structuredClone(args.body); args.contextTelemetry.logicalRequestId=`stage-failure-${stage}`; const result=await handleChatCore(args);
  expect(state.visited.has(stage)).toBe(true);expect(result.success, JSON.stringify({status:result.status,error:result.error,visited:[...state.visited]})).toBe(true);await result.response.text();expect(state.execute).toHaveBeenCalledTimes(1);expect(args.body).toEqual(before);
  const row=db.get('SELECT s.* FROM contextStages s JOIN requestStats r ON r.id=s.requestId WHERE s.stage=? AND r.logicalRequestId=?',[stage,args.contextTelemetry.logicalRequestId]);expect(row).toMatchObject({outcome:'failed',outcomeSource:'execution',errorCode:'transform_exception',deltaBytes:0});
  const records=db.all('SELECT * FROM requestStats WHERE logicalRequestId=?',[args.contextTelemetry.logicalRequestId]);expect(records).toHaveLength(1);
  expect(JSON.stringify(db.all('SELECT * FROM contextStages'))).not.toContain('PRIVATE-CONTEXT');
 });
 it('retains mixed failures as distinct ordered stages on one attempt',async()=>{
  state.fail=new Set(['schema','pxpipe','headroom']);const result=await handleChatCore(options());await result.response.text();
  const failed=db.all("SELECT stage,requestId FROM contextStages WHERE outcome='failed' AND requestId=(SELECT id FROM requestStats ORDER BY timestamp DESC LIMIT 1) ORDER BY ordinal");
  expect(failed.map(x=>x.stage)).toEqual(['schema','pxpipe','headroom']);expect(new Set(failed.map(x=>x.requestId)).size).toBe(1);
 });
});
