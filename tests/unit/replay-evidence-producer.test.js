import { beforeAll, expect, it, vi } from 'vitest';
import { replayResponseEvidence, normalizeReplayEvidence, REQUEST_REPLAY_COLUMNS } from '../../src/lib/db/replayEvidence.js';
import { getAdapter } from '../../src/lib/db/driver.js';
import { saveRequestStats } from '../../src/lib/db/repos/requestStatsRepo.js';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: fetchMock }));
import { BaseExecutor } from '../../open-sse/executors/base.js';
const at = '2026-09-12T00:00:00.000Z';
let db;
beforeAll(async () => {
  db = await getAdapter();
  const present = new Set(db.all('PRAGMA table_info(requestStats)').map(row => row.name));
  for (const name of Object.keys(REQUEST_REPLAY_COLUMNS)) expect(present.has(name), name).toBe(true);
});
it.each([200,201,408,409,500,502,503,504])('records HTTP %s as never replay even when the body is an SSE error', status => {
  const result = replayResponseEvidence({ response: new Response('data: {"error":"failed"}', { status }) }, () => at);
  expect(result).toEqual({ disposition: 'never-replay', source: 'upstream-response', status, observedAt: at });
});
it.each(['x-tokenproxy-replay-safe', 'x-should-retry'])('preserves explicit %s denial despite nonacceptance hint', header => {
  expect(replayResponseEvidence({ response: new Response('', { status:429, headers:{[header]:'false'} }),
    nonacceptance:'verified-provider-nonacceptance' }).disposition).toBe('never-replay');
});
it('persists exact response proofs for both physical URL dispatches without retaining content', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{"error":{"code":"rate_limit_exceeded","message":"quota exhausted"}}',{status:429}))
    .mockResolvedValueOnce(new Response('sensitive fixture response',{status:200}));
  let ordinal = 0;
  const executor = new BaseExecutor('fixture',{baseUrls:['https://a.invalid','https://b.invalid'],retry:{429:{attempts:1,delayMs:0}}});
  await executor.execute({model:'fixture',body:{messages:[]},stream:false,credentials:{apiKey:'fixture'},
    beforeDispatch:async()=>{ ordinal++; await saveRequestStats({id:`proof-${ordinal}`,status:'pending',contextTelemetry:{replayEvidence:{disposition:'unknown',source:'dispatch-start',status:null,observedAt:at}}}); },
    afterDispatch:async evidence=>saveRequestStats({id:`proof-${ordinal}`,status:'pending',contextTelemetry:{replayEvidence:replayResponseEvidence(evidence)}}),
  });
  expect(ordinal).toBe(2);
  const rows=db.all('SELECT id,replayDisposition,replaySource,replayStatus FROM requestStats ORDER BY id');
  expect(rows).toEqual([{id:'proof-1',replayDisposition:'safe-rejection',replaySource:'upstream-response',replayStatus:429},
    {id:'proof-2',replayDisposition:'never-replay',replaySource:'upstream-response',replayStatus:200}]);
  expect(JSON.stringify(db.all('SELECT * FROM requestStats'))).not.toContain('sensitive fixture response');
});
it('rejects forged local response proof and retains unknown before-response dispatch', () => {
  expect(()=>normalizeReplayEvidence({disposition:'safe-rejection',source:'dispatch-start',observedAt:at})).toThrow('Invalid replay');
  expect(()=>normalizeReplayEvidence({disposition:'safe-rejection',source:'upstream-response',status:200,observedAt:at})).toThrow('Invalid replay');
  expect(normalizeReplayEvidence({disposition:'unknown',source:'dispatch-start',observedAt:at})).toMatchObject({replayDisposition:'unknown',replayStatus:null});
});
it('records canonical account quota nonacceptance independently of same-account retry permission', () => {
  expect(replayResponseEvidence({response:new Response('',{status:429,headers:{'x-should-retry':'false'}}),
    payload:{error:{type:'rate_limit_error',message:'quota exhausted'}}}).disposition).toBe('safe-rejection');
});
