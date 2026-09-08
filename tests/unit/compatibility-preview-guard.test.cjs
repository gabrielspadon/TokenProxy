const {test}=require('node:test'); const assert=require('node:assert/strict');
const {validateMarker,createPreviewTransport}=require('../../src/lib/compatibility/previewTransport.cjs');
const owner={runId:'owned-run',root:'/owned'};
test('controlled marker requires exact owned runtime and refuses absent, invalid and extra grants',()=>{
 for(const value of [undefined,{}, {kind:'compatibility-gateway-v1',...owner,runId:'other'}, {kind:'compatibility-gateway-v1',...owner,allowNetwork:true}])assert.throws(()=>validateMarker(value,owner));
 assert.equal(validateMarker({kind:'compatibility-gateway-v1',...owner},owner),true);
});
test('transport refuses arbitrary targets, credentials, models, tools and malformed requests without network fallback',async()=>{
 const counters={}, transport=createPreviewTransport(counters,kind=>new Error(kind));
 const body={model:'gpt-4o-mini',messages:[{role:'user',content:'compatibility-gateway-v1 synthetic request'}]};
 const options={method:'POST',body:JSON.stringify(body)};
 for(const [url,opts] of [['https://evil.invalid',options],['https://api.openai.com/v1/chat/completions',{...options,headers:{authorization:'synthetic-secret'}}],['https://api.openai.com/v1/chat/completions',{...options,body:JSON.stringify({...body,model:'other'})}],['https://api.openai.com/v1/chat/completions',{...options,body:'broken'}]])await assert.rejects(transport(url,opts),/outboundBlocked/);
 assert.equal(counters.compatibilityDispatches,undefined);
 assert.match(await (await transport('https://api.openai.com/v1/chat/completions',options)).text(),/\[DONE\]/); assert.equal(counters.compatibilityDispatches,1);
});
