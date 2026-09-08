const {test}=require('node:test');
const assert=require('node:assert/strict');
async function execute(definition) {
 const {createCompatibilityWorker}=await import('../../src/lib/compatibility/runtime.mjs'); const w=createCompatibilityWorker(definition);w.stdout.resume();w.stderr.resume();
 try{return await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>reject(new Error('worker deadline')),5000);w.once('message',m=>{clearTimeout(timer);resolve(m)});w.once('error',e=>{clearTimeout(timer);reject(e)}); });}finally{await w.terminate();}
}
function fixture(provider,scenario,scope='controlled-executor') {
 const payload=provider==='claude'?{messages:[{role:'user',content:'Synthetic request'},{role:'assistant',content:[{type:'thinking',thinking:'Synthetic reasoning',signature:'synthetic-signature'},{type:'tool_use',id:'call_1',name:'sensor',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call_1',content:'12'}]}],max_tokens:32,tools:[{name:'sensor',input_schema:{type:'object',properties:{}}}]}:
 {messages:[{role:'user',content:'Synthetic request'},{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'sensor',arguments:'{}'}}]},{role:'tool',tool_call_id:'call_1',content:'12'}],tools:[{type:'function',function:{name:'sensor',parameters:{type:'object',properties:{}}}}],max_tokens:32};
 return {version:1,origin:'synthetic',suitable:true,operation:'request',sourceFormat:provider,targetFormat:provider,model:'synthetic-model',payload,scope,provider,scenario,fixtureVersion:'controlled-v1'};
}
for(const scope of ['controlled-executor','controlled-gateway-routing'])for(const provider of ['openai','claude'])for(const scenario of ['native-fields','tool-ordering','cache-accounting','sse-terminal','slow-consumer','proxy-configuration','abort-before-dispatch','interrupted-stream'])test(`${scope} ${provider} ${scenario}`,async()=>{
 const response=await execute(fixture(provider,scenario,scope));assert.equal(response.error,undefined,JSON.stringify(response));assert.ok(response.result.checks.every(c=>c.outcome==='passed'),JSON.stringify(response.result.checks));assert.equal(response.result.coverage.providerCalls,0);assert.equal(response.result.coverage.credentialsRead,false);assert.match(response.result.implementationHash,/^[a-f\d]{64}$/);assert.equal(response.result.provider,provider);assert.equal(response.result.model,'synthetic-model');
});
test('controlled gateway refuses incorrectly declared resolved target',async()=>{const value=fixture('openai','native-fields','controlled-gateway-routing');value.targetFormat='claude';assert.equal((await execute(value)).error.code,'target_mismatch');});
test('controlled gateway resolves and translates OpenAI tools onto the Claude executor wire',async()=>{
 const value=fixture('openai','tool-ordering','controlled-gateway-routing');value.provider='claude';value.targetFormat='claude';
 const response=await execute(value);assert.equal(response.error,undefined,JSON.stringify(response));assert.ok(response.result.checks.every(check=>check.outcome==='passed'));assert.equal(response.result.route.resolvedTarget,'claude');
 assert.ok(response.result.comparison.wire[0].body.messages.some(message=>message.content?.some?.(block=>block.type==='tool_result')));
});
