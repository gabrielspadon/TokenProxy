import { it, expect, vi, afterEach } from 'vitest';
import { requestFetch, withRequestLifetime, requestDelay, requestSignal } from 'open-sse/utils/requestLifetime.js';
afterEach(()=>vi.unstubAllGlobals());
it('isolates concurrent caller contexts and composes timeout with caller abort',async()=>{
  const a=new AbortController(),b=new AbortController(), timeout=new AbortController();
  const captured=[]; vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{captured.push(options.signal);return new Response('ok');}));
  await Promise.all([withRequestLifetime(a.signal,()=>requestFetch('http://mock',{signal:timeout.signal})),withRequestLifetime(b.signal,()=>requestFetch('http://mock'))]);
  a.abort(); expect(captured[0].aborted).toBe(true); expect(captured[1].aborted).toBe(false); expect(requestSignal()).toBeUndefined();
});
it('cancels polling sleeps immediately and forbids a subsequent dispatch',async()=>{
  const abort=new AbortController(); const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const work=withRequestLifetime(abort.signal,async()=>{await requestDelay(10000);return requestFetch('http://mock');});
  abort.abort(); await expect(work).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('already aborted caller cannot dispatch an adapter retry',async()=>{
  const abort=new AbortController();abort.abort();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  expect(()=>withRequestLifetime(abort.signal,()=>requestFetch('http://mock'))).toThrow();expect(fetch).not.toHaveBeenCalled();
});
