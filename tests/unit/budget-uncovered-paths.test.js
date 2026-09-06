import { beforeAll, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({credentials:vi.fn(async()=>{throw Error('Uncovered capped request reached provider selection');})}));
vi.mock('../../src/sse/services/auth.js',async original=>({...await original(),getProviderCredentials:mocks.credentials}));
import { getAdapter } from '../../src/lib/db/driver.js';
import { updateSettings } from '../../src/lib/db/repos/settingsRepo.js';
const db=await getAdapter();
beforeAll(async()=>{await updateSettings({requireApiKey:false});db.run("INSERT INTO apiKeys(id,key,isActive,createdAt,maxCompletionTokens,budgetPolicy) VALUES('coverage-key','coverage-synthetic',1,?,100,'reserve-remaining')",[new Date().toISOString()]);});
const routes=[['imageGeneration','handleImageGeneration'],['videoGeneration','handleVideoCreate','generations'],['stt','handleStt'],['tts','handleTts'],['jsonProxy','handleJsonProxy','ocr'],['search','handleSearch'],['fetch','handleFetch']];
it.each(routes)('%s refuses capped keys before any uncovered generation path',async(file,handler,action)=>{
 let body=JSON.stringify({model:'openai/gpt-4o',input:'fixture',query:'fixture',documents:['fixture'],prompt:'fixture',url:'https://fixture.invalid',document:{type:'document_url',document_url:'https://fixture.invalid'}});
 if(file==='stt'){body=new FormData();body.set('model','openai/whisper-1');body.set('file',new Blob(['fixture']),'fixture.wav');}
 const response=await(await import(`../../src/sse/handlers/${file}.js`))[handler](new Request('http://localhost/v1/fixture',{method:'POST',headers:{authorization:'Bearer coverage-synthetic'},body}),action);
 expect(response.status).toBe(402);expect(await response.json()).toMatchObject({error:{code:'budget-dispatch-coverage-unavailable'}});
 expect(response.headers.get('x-should-retry')).toBe('false');expect(mocks.credentials).not.toHaveBeenCalled();
 expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(0);
});
