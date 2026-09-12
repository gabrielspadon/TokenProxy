#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { authenticatedObservationSources } from './observe-production.mjs';
import { normalizeReplayEvidence } from '../../src/lib/db/replayEvidence.js';
import { candidateFileHash } from './risk-scope.mjs';

const hash = bytes=>createHash('sha256').update(bytes).digest('hex');
const same = (left,right)=>JSON.stringify(left)===JSON.stringify(right);
const integer = value=>Number.isSafeInteger(value)&&value>=0;
const fail = message=>{throw new Error(`Live safety rejected: ${message}`);};
const SHA = /^[a-f0-9]{40}$/, SHA256=/^[a-f0-9]{64}$/;
const SCOPES=['replay','secret-scan','acknowledged-writes','front-evictions'];
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

export function candidateSafetySources(root=ROOT) {
  return Object.fromEntries(['live-safety-runtime.cjs','custom-server.js']
    .map(name=>[name,hash(fs.readFileSync(path.join(root,name)))]));
}

export function candidateFrontSources(root,sha) {
  if(!root||!SHA.test(sha||'')) fail('front candidate source required');
  return Object.fromEntries(['front-proxy.mjs','front-activation.mjs','front-lifecycle.mjs','front-telemetry.mjs','front-outcome-journal.mjs']
    .map(name=>[name,candidateFileHash(root,sha,`services/tokenproxy/${name}`)]));
}

export function deriveReplayAudit({requests,end}) {
  const attempts=new Map(), ids=new Set(), unresolvedAttempts=[], unsafeReplays=[];
  let physicalAttempts=0;
  for(const row of end.attempts) {
    if(ids.has(row.id)) fail('duplicate backend attempt'); ids.add(row.id);
    const list=attempts.get(row.logicalRequestId)||[];list.push(row);attempts.set(row.logicalRequestId,list);
  }
  for(const request of requests) {
    const rows=(attempts.get(request.logicalRequestId)||[]).sort((a,b)=>a.attempt-b.attempt);
    if(!rows.length) {
      if(!['admission-timeout','backend-unavailable'].includes(request.terminal?.terminalReason))
        unresolvedAttempts.push({logicalRequestId:request.logicalRequestId,reason:'missing-attempts'});
      continue;
    }
    let previous;
    for(const [index,row] of rows.entries()) {
      if(row.attempt!==index+1 || row.contextTelemetryError) unresolvedAttempts.push({id:row.id,reason:'ambiguous-attempt-order'});
      if(row.replaySource==='transport-no-dispatch') {
        try { normalizeReplayEvidence({disposition:row.replayDisposition,source:row.replaySource,status:row.replayStatus,observedAt:row.replayObservedAt}); }
        catch { unresolvedAttempts.push({id:row.id,reason:'invalid-no-dispatch-proof'}); }
        continue;
      }
      if(row.dispatchCoverage!=='physical-dispatch') {unresolvedAttempts.push({id:row.id,reason:'unobserved-dispatch-boundary'});continue;}
      physicalAttempts++;
      if(previous) {
        if(previous.replayDisposition==='never-replay') unsafeReplays.push({id:row.id,previousId:previous.id,reason:'generation-may-have-been-accepted'});
        else if(previous.replayDisposition!=='safe-rejection') unresolvedAttempts.push({id:row.id,previousId:previous.id,reason:'previous-dispatch-acceptance-unknown'});
      }
      try { normalizeReplayEvidence({disposition:row.replayDisposition,source:row.replaySource,status:row.replayStatus,observedAt:row.replayObservedAt});
        if(!row.replayObservedAt || row.replayObservedAt<request.start.firstObservedAt || row.replayObservedAt>end.captureEndedAt) throw new Error();
      } catch { unresolvedAttempts.push({id:row.id,reason:'missing-or-invalid-response-proof'}); }
      previous=row;
    }
  }
  return {logicalRequests:requests.length,physicalAttempts,unsafeReplays,unresolvedAttempts,
    countScope:'physical-dispatch-intents',unobservable:[]};
}

export function deriveSecretAudit({begin,end,window,sourceHashes,applicationSha}) {
  const a=begin.safety?.secrets,b=end.safety?.secrets,unobservable=[],findings=[],coverage=[],authorizedDeliveries=[];
  let scannedBytes=0,observedWrites=0;
  const valid=value=>value?.kind==='live-secret-snapshot' && value.schemaVersion===1
    && value.scope==='configured-credential-literal-bytes' && value.process?.id && value.inventory?.count>0
    && Array.isArray(value.inventory.fingerprints) && value.inventory.fingerprints.length===value.inventory.count
    && new Set(value.inventory.fingerprints).size===value.inventory.count && value.inventory.fingerprints.every(x=>SHA256.test(x))
    && Array.isArray(value.findings) && Array.isArray(value.authorizedDeliveries) && Array.isArray(value.unobservable);
  if(!valid(a)||!valid(b)) return {scannedBytes,observedWrites,coverage,findings,unobservable:['secret-capture-missing-or-invalid']};
  if(!same(a.process,b.process)||!same(a.source,b.source)||!a.process.bootId||!a.process.startTicks) unobservable.push('secret-process-identity-changed-or-incomplete');
  if(a.source.buildSha!==applicationSha || b.source.buildSha!==applicationSha
    || Object.entries(sourceHashes).some(([name,value])=>a.source[name]!==value)) unobservable.push('secret-source-identity-mismatch');
  if(!(a.capturedAt<=window.start && b.capturedAt>=window.end && a.process.startedAt<=window.start)) unobservable.push('secret-capture-does-not-cover-window');
  if(a.unobservable.length||b.unobservable.length) unobservable.push('secret-observer-coverage-incomplete');
  if(a.inventory.fingerprints.some(value=>!b.inventory.fingerprints.includes(value))) unobservable.push('credential-inventory-disappeared');
  if(!same(a.environment,b.environment)) unobservable.push('configured-environment-credentials-changed');
  if(!same(a.trace?.current,b.trace?.current) || a.trace.configChanges!==b.trace.configChanges) unobservable.push('trace-configuration-changed');
  for(const sink of ['api','exception','log','trace']) {
    const initial=a.sinks?.[sink],final=b.sinks?.[sink];
    if(!initial||!final||['writes','bytes','matches','errors'].some(key=>!integer(initial[key])||!integer(final[key])||final[key]<initial[key])) {
      unobservable.push(`${sink}-counter-invalid`);continue;
    }
    const inactive=sink==='trace'&&!a.trace.requestLogsEnabledEver&&!b.trace.requestLogsEnabledEver
      &&!a.trace.otlpEnabledEver&&!b.trace.otlpEnabledEver && !a.trace.current.requestLogs&&!a.trace.current.otlp
      &&!b.trace.current.requestLogs&&!b.trace.current.otlp;
    if(inactive && (final.bytes!==0||final.writes!==0)) unobservable.push('inactive-trace-counter-conflict');
    if(!inactive && (!initial.observed||!final.observed)) unobservable.push(`${sink}-not-observed-throughout-window`);
    const bytes=final.bytes-initial.bytes,writes=final.writes-initial.writes;
    const count=(rows,sink)=>rows.filter(row=>row.sink===sink).reduce((sum,row)=>sum+row.count,0);
    if([a,b].some(snapshot=>count([...snapshot.findings,...snapshot.authorizedDeliveries],sink)!==snapshot.sinks[sink].matches)) unobservable.push(`${sink}-findings-counter-mismatch`);
    scannedBytes+=bytes;observedWrites+=writes;
    coverage.push({sink,status:inactive?'checked-inactive':'observed',bytes,writes});
    const unexpected=count(b.findings,sink)-count(a.findings,sink),authorized=count(b.authorizedDeliveries,sink)-count(a.authorizedDeliveries,sink);
    if(unexpected<0||authorized<0) unobservable.push(`${sink}-disclosure-history-decreased`);
    if(unexpected>0) findings.push({sink,matches:unexpected});
    if(authorized>0) authorizedDeliveries.push({sink,matches:authorized});
    if(final.errors>initial.errors) unobservable.push(`${sink}-observer-errors`);
  }
  if([a,b].some(snapshot=>snapshot.authorizedDeliveries.some(row=>row.sink!=='api'||!['client-key-create','client-key-reveal','client-key-rotate'].includes(row.policy)))) unobservable.push('invalid-authorized-delivery-policy');
  return {scannedBytes,observedWrites,coverage,findings,authorizedDeliveries,unobservable,
    matchScope:'configured-credential-literal-bytes',limitations:b.limitations,
    counting:'write-attempts-conservative-superset',rawContentRetained:false,
    allCredentialsCleanClaim:false,allEncodingsCovered:false};
}

export function deriveFrontEvictionAudit({begin,end,before,after}) {
  const key='queue-timeout', beginCounter=begin.status.terminal_counts[key]||0,endCounter=end.status.terminal_counts[key]||0;
  const beforeIds=new Set(before.map(row=>row.receiptId));
  const events=after.filter(row=>row.kind==='terminal'&&!beforeIds.has(row.receiptId)&&row.clockDomain===end.active.clockDomain);
  const signedEvictions=events.filter(row=>row.terminalReason==='admission-timeout').length;
  const delta=endCounter-beginCounter, unobservable=[];
  if(!integer(delta)||delta!==signedEvictions) unobservable.push('eviction-counter-journal-disagreement');
  return {beginCounter,endCounter,delta,signedEvictions,counterEpoch:`${end.active.clockDomain}/${end.status.terminal_window_started_at}`,
    scope:'all-front-admission-evictions-including-deployment',unobservable};
}

export async function deriveAcknowledgedAudit({begin,end,window,applicationSha,validateCapture}) {
  const a=begin.safety?.acknowledgments,b=end.safety?.acknowledgments;
  const unobservable=[],missing=[],unreadable=[];
  let acknowledged=0,reconciled=0;
  const result=()=>({acknowledged,reconciled,missing,unreadable,unobservable,
    acknowledgmentScope:'durable-before-return',callerObserved:null});
  try {
    if(!validateCapture) {
      const moduleUrl=new URL('../../src/lib/db/adapters/criticalAckJournal.js',import.meta.url).href;
      validateCapture=(await import(/* @vite-ignore */ moduleUrl)).validateCriticalAcknowledgmentCapture;
    }
    if(typeof validateCapture!=='function') throw new Error();
    validateCapture(a);validateCapture(b);
  } catch { unobservable.push('acknowledgment-native-validation-unavailable-or-invalid');return result(); }
  if(a.epoch!==b.epoch || a.capturedAt>window.start || b.capturedAt<window.end) unobservable.push('acknowledgment-epoch-or-window-mismatch');
  if(a.unobservable.length||b.unobservable.length||a.failures.length||b.failures.length) unobservable.push('acknowledgment-source-incomplete');
  const markers=new Map(b.database.markers.map(row=>[row.transactionId,row]));
  const receipts=new Map(b.journal.records.map(row=>[row.marker.transactionId,row]));
  const retained=new Map(b.journal.inventory.map(row=>[row.name,row.sha256]));
  if(a.journal.inventory.some(row=>retained.get(row.name)!==row.sha256)) unobservable.push('acknowledgment-inventory-history-disappeared');
  for(const row of a.journal.records) if(!same(row,receipts.get(row.marker.transactionId))) unobservable.push('acknowledgment-history-disappeared');
  for(const row of b.journal.records) {
    const matches=row.marker.markerSha256===markers.get(row.marker.transactionId)?.markerSha256;
    if(!matches) missing.push(row.marker.transactionId);
    if(row.ackEligibleAt>=window.start&&row.ackEligibleAt<window.end) {
      acknowledged++;
      if(row.marker.buildSha!==applicationSha) unobservable.push('acknowledgment-candidate-mismatch');
      if(matches) reconciled++;
    }
  }
  // No fabricated positive count. A zero-activity window needs native runtime
  // coverage as well as a complete retained journal, supplied by the adapter.
  const ar=begin.safety?.secrets?.criticalAcknowledgments,br=end.safety?.secrets?.criticalAcknowledgments;
  if(!ar||!br||ar.kind!=='critical-ack-runtime'||br.kind!=='critical-ack-runtime'
    ||ar.processInstanceId!==br.processInstanceId||ar.pid!==br.pid||!ar.enabledAt||ar.enabledAt!==br.enabledAt||ar.enabledAt>window.start
    ||br.counters?.omittedAttempts!==0||ar.counters?.omittedAttempts!==0)
    unobservable.push('critical-write-runtime-coverage-missing');
  else {
    const fields=['startedAttempts','createdIntents','acknowledgedReturnsEligible','failedAttempts','omittedAttempts'];
    if(fields.some(key=>!integer(ar.counters[key])||!integer(br.counters[key])||br.counters[key]<ar.counters[key])) unobservable.push('critical-write-runtime-counter-discontinuity');
    for(const [runtime,capture,secrets] of [[ar,a,begin.safety.secrets],[br,b,end.safety.secrets]]) {
      if(runtime.buildSha!==applicationSha||runtime.pid!==secrets.process.pid) unobservable.push('critical-write-runtime-candidate-mismatch');
      const intents=capture.journal.intents.filter(row=>row.processInstanceId===runtime.processInstanceId);
      const eligible=capture.journal.records.filter(row=>row.marker.processInstanceId===runtime.processInstanceId);
      const intentIds=new Set(intents.map(row=>row.transactionId));
      const failures=capture.journal.failures.filter(row=>intentIds.has(row.transactionId));
      if(runtime.counters.startedAttempts<runtime.counters.createdIntents
        ||intents.length<runtime.counters.createdIntents ||eligible.length<runtime.counters.acknowledgedReturnsEligible
        ||failures.length<runtime.counters.failedAttempts) unobservable.push('critical-write-runtime-journal-disagreement');
    }
  }
  return result();
}

export async function deriveLiveSafety({begin,end,keyringPath,identities,inputs,sourceHashes=candidateSafetySources(),frontSourceHashes,validateCapture}) {
  for(const key of ['applicationSha','frontSha','deploySha']) if(!SHA.test(identities?.[key]||'')) fail('candidate identity');
  const authenticated=authenticatedObservationSources({begin,end,keyringPath});
  const {observation,requests,before,after}=authenticated;
  if(begin.status.backend_build_sha!==identities.applicationSha||end.status.backend_build_sha!==identities.applicationSha) fail('backend candidate mismatch');
  if(!Array.isArray(inputs)||inputs.length!==3||!same(inputs.map(row=>row.role).sort(),['begin','end','keyring'])) fail('signed raw inputs');
  const sourceIdentities=Object.fromEntries(['applicationSha','frontSha','deploySha'].map(key=>[key,identities[key]]));
  const common={...sourceIdentities,releaseId:observation.releaseId,window:observation.window,inputs};
  const frontA=begin.status.source_manifest,frontB=end.status.source_manifest;
  const frontBound=frontSourceHashes && frontA?.schemaVersion===1 && same(frontA,frontB)
    && same(frontA.files,frontSourceHashes) && frontA.sha256===hash(JSON.stringify(frontA.files))
    && frontA.capturedAt<=observation.window.start;
  const raw=[deriveReplayAudit({requests,end}),deriveSecretAudit({begin,end,window:observation.window,sourceHashes,...identities}),
    await deriveAcknowledgedAudit({begin,end,window:observation.window,...identities,validateCapture}),deriveFrontEvictionAudit({begin,end,before,after})];
  const audits=Object.fromEntries(SCOPES.map((scope,index)=>{
    const value=raw[index];
    if(!frontBound) value.unobservable.push('front-startup-source-binding-missing-or-mismatched');
    const failed=value.unobservable.length || value.unsafeReplays?.length || value.unresolvedAttempts?.length
      || value.findings?.length || value.missing?.length || value.unreadable?.length || value.delta>0
      || (scope==='replay'&&value.logicalRequests!==observation.counts.naturalLogicalRequests);
    return [scope,{schema:`tokenproxy-live-${scope}-audit-v1`,state:failed?'failed':'passed',...common,...value}];
  }));
  return {observation,audits};
}

function readInput(root,reference) {
  if(!reference||typeof reference.path!=='string'||path.isAbsolute(reference.path)||!SHA256.test(reference.sha256||'')) fail('input reference');
  const base=fs.realpathSync(root),file=fs.realpathSync(path.resolve(base,reference.path)),relative=path.relative(base,file);
  if(!relative||relative.startsWith('../')||path.isAbsolute(relative)) fail('input escaped root');
  const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>268435456||(stat.mode&0o777)!==0o600) fail('input mode or size');
  const bytes=fs.readFileSync(file);if(hash(bytes)!==reference.sha256) fail('input hash mismatch');
  return {file,value:JSON.parse(bytes)};
}
async function main() {
  const [manifestPath,outputDirectory]=process.argv.slice(2);
  if(!path.isAbsolute(manifestPath||'')||!path.isAbsolute(outputDirectory||'')) fail('absolute manifest and output directory required');
  const root=path.dirname(manifestPath),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const refs=manifest.observation;
  const inputs=['begin','end','keyring'].map(role=>({role,...refs[role]}));
  const begin=readInput(root,refs.begin).value,end=readInput(root,refs.end).value,keyringPath=readInput(root,refs.keyring).file;
  const {observation,audits}=await deriveLiveSafety({begin,end,keyringPath,identities:manifest.identities,inputs,
    frontSourceHashes:candidateFrontSources(manifest.frontRepositoryRoot,manifest.identities.frontSha)});
  const relativeOutput=path.relative(root,outputDirectory);
  if(relativeOutput==='..'||relativeOutput.startsWith('../')||path.isAbsolute(relativeOutput)) fail('output outside evidence root');
  fs.mkdirSync(outputDirectory,{recursive:true,mode:0o700});
  const references=[];
  for(const [scope,value] of Object.entries(audits)) {
    const file=path.join(outputDirectory,`${scope}.json`),bytes=JSON.stringify(value,null,2)+'\n';
    fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600}); references.push({scope,source:{path:path.relative(root,file),sha256:hash(bytes)}});
  }
  const closure={schema:'tokenproxy-live-safety-closure-v1',state:Object.values(audits).every(row=>row.state==='passed')?'passed':'failed',
    ...manifest.identities,releaseId:observation.releaseId,window:observation.window,audits:references};
  fs.writeFileSync(path.join(outputDirectory,'closure.json'),JSON.stringify(closure,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({state:closure.state,outputDirectory})+'\n');
  if(closure.state!=='passed') process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(()=>{
  process.stderr.write('Live safety collection failed; inspect private inputs and candidate source.\n');process.exitCode=1;
});
