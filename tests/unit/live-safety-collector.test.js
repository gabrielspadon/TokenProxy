import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { deriveReplayAudit,deriveSecretAudit,deriveFrontEvictionAudit,deriveAcknowledgedAudit } from '../../scripts/qa/collect-live-safety.mjs';
const {createLiveSafety}=createRequire(import.meta.url)('../../live-safety-runtime.cjs');
const START='2026-09-10T01:00:00.000Z',END='2026-09-11T02:00:00.000Z';
const sha='a'.repeat(40),sourceHashes={'live-safety-runtime.cjs':'b'.repeat(64),'custom-server.js':'c'.repeat(64)};
function secretFixture() {
  let at=START;
  const env={JWT_SECRET:'fixture-secret-credential-123456'};
  const runtime=createLiveSafety({env,identity:{id:'process',bootId:'boot',startTicks:'1',startedAt:START},
    source:{...sourceHashes,buildSha:sha},now:()=>at});
  for(const sink of ['api','log','exception']) runtime.stream(sink).close();
  const begin={safety:{secrets:runtime.snapshot()}};
  at=END;runtime.scan('api','ordinary user-authored sk-example text');
  const end={safety:{secrets:runtime.snapshot()}};
  return {runtime,env,begin,end,window:{start:START,end:END},applicationSha:sha,sourceHashes};
}
it('checks inactive trace capability against stable instrumented source/config and covers active sinks',()=>{
  const fixture=secretFixture(),result=deriveSecretAudit(fixture);
  expect(result.unobservable).toEqual([]);expect(result.findings).toEqual([]);
  expect(result.coverage.find(row=>row.sink==='trace')).toEqual({sink:'trace',status:'checked-inactive',bytes:0,writes:0});
  expect(result.scannedBytes).toBeGreaterThan(0);expect(result.rawContentRetained).toBe(false);
});
it.each(['process','source','missing','trace','counter','inventory'])('rejects %s secret coverage gaps',fault=>{
  const fixture=secretFixture(),end=fixture.end.safety.secrets;
  if(fault==='process')end.process={...end.process,id:'new'};
  if(fault==='source')end.source={...end.source,buildSha:'d'.repeat(40)};
  if(fault==='missing')delete fixture.end.safety.secrets;
  if(fault==='trace'){fixture.env.TOKENPROXY_TELEMETRY='otlp';fixture.runtime.traceMode();delete fixture.env.TOKENPROXY_TELEMETRY;fixture.end.safety.secrets=fixture.runtime.snapshot();}
  if(fault==='counter')end.sinks.api.bytes=-1;
  if(fault==='inventory')end.inventory.fingerprints=[];
  expect(deriveSecretAudit(fixture).unobservable.length).toBeGreaterThan(0);
});
it('flags configured literal exposure but does not treat all token-looking generation as a credential',()=>{
  const fixture=secretFixture();fixture.runtime.scan('log',fixture.env.JWT_SECRET);
  fixture.end.safety.secrets=fixture.runtime.snapshot();
  const result=deriveSecretAudit(fixture);
  expect(result.findings).toEqual([{sink:'log',matches:1}]);
  expect(JSON.stringify(result)).not.toContain(fixture.env.JWT_SECRET);
});
const row=(attempt,disposition='never-replay')=>({id:`id-${attempt}`,logicalRequestId:'logical',attempt,dispatchCoverage:'physical-dispatch',
  replayDisposition:disposition,replaySource:'upstream-response',replayStatus:disposition==='safe-rejection'?429:200,replayObservedAt:START});
const replay=rows=>deriveReplayAudit({requests:[{logicalRequestId:'logical',start:{firstObservedAt:START}}],end:{attempts:rows,captureEndedAt:END}});
it('reconciles every attempt and flags retry after accepted generation even with successful final output',()=>{
  expect(replay([row(1,'safe-rejection'),row(2)])).toMatchObject({logicalRequests:1,physicalAttempts:2,unsafeReplays:[],unresolvedAttempts:[]});
  expect(replay([row(1),row(2)]).unsafeReplays).toEqual([{id:'id-2',previousId:'id-1',reason:'generation-may-have-been-accepted'}]);
});
it('retains missing, ambiguous and unknown attempt proof as unresolved and rejects duplicate IDs',()=>{
  expect(replay([]).unresolvedAttempts).toHaveLength(1);
  expect(replay([row(1),row(3)]).unresolvedAttempts.length).toBeGreaterThan(0);
  expect(replay([{...row(1),replayDisposition:null},row(2)]).unresolvedAttempts.length).toBeGreaterThan(0);
  expect(()=>replay([row(1),row(1)])).toThrow('duplicate');
});
it('counts only signed non-dispatched cancellation or queue refusal as proven no attempt',()=>{
  const request={logicalRequestId:null,start:{firstObservedAt:START},terminal:{terminalReason:'caller-cancelled',backendDispatched:false}};
  const input={requests:[request],end:{attempts:[],captureEndedAt:END}};
  expect(deriveReplayAudit(input)).toMatchObject({logicalRequests:1,physicalAttempts:0,provedNoDispatch:1,unresolvedAttempts:[]});
  delete request.terminal.backendDispatched;
  expect(deriveReplayAudit(input).unresolvedAttempts).toHaveLength(1);
  request.terminal.backendDispatched=true;
  expect(deriveReplayAudit(input).unresolvedAttempts).toHaveLength(1);
  request.terminal={terminalReason:'backend-unavailable',backendDispatched:true};
  expect(deriveReplayAudit(input).unresolvedAttempts).toHaveLength(1);
  request.terminal={terminalReason:'caller-cancelled',backendDispatched:false};request.logicalRequestId='logical';input.end.attempts=[row(1)];
  expect(deriveReplayAudit(input).unresolvedAttempts).toContainEqual({logicalRequestId:'logical',reason:'front-backend-dispatch-disagreement'});
});
it('matches monotonic front eviction counters to signed terminal evidence including older ingress',()=>{
  const begin={status:{terminal_counts:{'queue-timeout':2}}},end={active:{clockDomain:'clock'},status:{terminal_counts:{'queue-timeout':2},terminal_window_started_at:START}};
  const input={begin,end,before:[],after:[]};
  expect(deriveFrontEvictionAudit(input)).toMatchObject({delta:0,signedEvictions:0,unobservable:[]});
  end.status.terminal_counts['queue-timeout']=3;
  expect(deriveFrontEvictionAudit(input).unobservable).toHaveLength(1);
  input.after.push({kind:'terminal',receiptId:'receipt',clockDomain:'clock',terminalReason:'admission-timeout'});
  expect(deriveFrontEvictionAudit(input)).toMatchObject({delta:1,signedEvictions:1,unobservable:[]});
});
it('never substitutes stale pending rows or caller supplied clean booleans for ACK evidence',async()=>{
  const result=await deriveAcknowledgedAudit({begin:{safety:{acknowledgments:{clean:true}}},end:{safety:{acknowledgments:{clean:true}}},window:{start:START,end:END},applicationSha:sha,
    validateCapture(){throw new Error('missing immutable markers');}});
  expect(result).toMatchObject({acknowledged:0,reconciled:0,callerObserved:null,unobservable:['acknowledgment-native-validation-unavailable-or-invalid']});
});
