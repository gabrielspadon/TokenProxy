import { describe,it,expect,vi,afterEach } from 'vitest';
import { withRequestLifetime } from 'open-sse/utils/requestLifetime.js';
import { handleSttCore } from 'open-sse/handlers/sttCore.js';
import { handleTtsCore } from 'open-sse/handlers/ttsCore.js';
import { handleEmbeddingsCore } from 'open-sse/handlers/embeddingsCore.js';
import { handleRerankCore } from 'open-sse/handlers/rerankCore.js';
afterEach(()=>vi.unstubAllGlobals());
describe('real media core transport cancellation with mock upstream',()=>{
  it.each(['stt','tts','embeddings','rerank'])('%s fetch inherits caller signal and cannot retry after abort',async(kind)=>{
    const abort=new AbortController();let observed;
    const fetch=vi.fn((_url,options)=>{observed=options.signal;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));});
    vi.stubGlobal('fetch',fetch);
    const fd=new FormData();fd.append('file',new File(['mock audio'],'mock.wav',{type:'audio/wav'}));
    const run={
      stt:()=>handleSttCore({provider:'deepgram',model:'nova-2',formData:fd,credentials:{apiKey:'synthetic'},sttConfig:{format:'deepgram',baseUrl:'http://mock',authType:'apikey'}}),
      tts:()=>handleTtsCore({provider:'openai',model:'tts-1/alloy',input:'mock',credentials:{apiKey:'synthetic'}}),
      embeddings:()=>handleEmbeddingsCore({body:{input:'mock'},modelInfo:{provider:'openai',model:'text-embedding-3-small'},credentials:{apiKey:'synthetic'}}),
      rerank:()=>handleRerankCore({body:{query:'mock',documents:['mock']},modelInfo:{provider:'cohere',model:'rerank-v3.5'},credentials:{apiKey:'synthetic'}}),
    }[kind];
    const work=withRequestLifetime(abort.signal,run);await vi.waitFor(()=>expect(observed).toBeDefined());
    abort.abort();const result=await work;expect(result.success).toBe(false);expect(observed.aborted).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);
  });
});
