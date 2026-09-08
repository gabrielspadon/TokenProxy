import { expect, it } from 'vitest';
import { capabilityEvidence, compareCompatibilityRuns, qualifiedRegressionEvidence } from '../../src/lib/compatibility/evidence.mjs';
const run=(id,outcome='passed',patch={})=>({id,fixtureId:'fixture',fixtureHash:'a'.repeat(64),fixtureRevision:1,scope:'controlled-executor',status:outcome==='passed'?'succeeded':'failed',createdAt:`2026-09-08T10:00:0${id}.000Z`,finishedAt:`2026-09-08T10:00:0${id}.000Z`,result:{implementationHash:'b'.repeat(64),fixtureVersion:'controlled-v1',provider:'openai',model:'exact-model',scenario:'native-fields',sourceFormat:'openai',targetFormat:'openai',operation:'request',checks:[{id:'native-fields',outcome}]},...patch});
it('only comparable completed exact evidence produces a linked passed-to-failed regression',()=>{const before=run('1'),after=run('2','failed');const comparison=compareCompatibilityRuns(before,after);expect(comparison).toMatchObject({comparable:true,previousRunId:'1',currentRunId:'2',scope:'controlled-executor',regressions:[{checkId:'native-fields'}],evidenceLinks:['/api/admin/compatibility/runs/1','/api/admin/compatibility/runs/2']});expect(qualifiedRegressionEvidence([after,before])).toHaveLength(1);});
it.each(['scope','fixtureHash'])('different %s cannot manufacture regression',(field)=>expect(compareCompatibilityRuns(run('1'),run('2','failed',{[field]:'different'})).comparable).toBe(false));
it.each(['model','provider','scenario','fixtureVersion'])('different exact %s is not comparable',field=>{const current=run('2','failed');current.result[field]='different';expect(compareCompatibilityRuns(run('1'),current).comparable).toBe(false);});
it.each(['cancelled','interrupted','timed-out','queued','running'])('%s is never regression evidence',status=>expect(qualifiedRegressionEvidence([run('1'),run('2','failed',{status})])).toEqual([]));
it('missing and unknown check outcomes remain unknown rather than matrix support',()=>{const missing=run('1');delete missing.result.implementationHash;const unknown=run('2','unknown');const groups=capabilityEvidence([missing,unknown]);expect(groups.reduce((n,g)=>n+g.passed,0)).toBe(0);expect(groups.reduce((n,g)=>n+g.unknown,0)).toBe(2);expect(compareCompatibilityRuns(missing,run('3','failed')).comparable).toBe(false);});
it('implementation revisions form separate capability rows but comparable baselines',()=>{const before=run('1'),after=run('2','failed');after.result.implementationHash='c'.repeat(64);expect(capabilityEvidence([before,after])).toHaveLength(2);expect(compareCompatibilityRuns(before,after).regressions).toHaveLength(1);});
it('a repeated failed outcome does not create a fresh regression',()=>expect(qualifiedRegressionEvidence([run('1','failed'),run('2','failed')])).toEqual([]));

it('a newer or identical run is not a prior regression baseline',()=>{expect(compareCompatibilityRuns(run('2'),run('1','failed')).comparable).toBe(false);expect(compareCompatibilityRuns(run('1'),run('1')).comparable).toBe(false);});
it.each([{},'bad',[{id:'native-fields',outcome:'passed'},{id:'native-fields',outcome:'failed'}],[{id:12,outcome:'passed'}],[{id:'native-fields',outcome:'invented'}]])('malformed retained checks cannot throw or establish support',checks=>{
 const bad=run('2','failed');bad.result.checks=checks;
 expect(()=>qualifiedRegressionEvidence([null,{},bad,run('1')])).not.toThrow();
 expect(qualifiedRegressionEvidence([bad,run('1')])).toEqual([]);
 expect(compareCompatibilityRuns(run('1'),bad).comparable).toBe(false);
 expect(capabilityEvidence([bad])[0].unknown).toBe(1);
});
it.each([{finishedAt:'not-time'},{fixtureHash:'unversioned'},{fixtureRevision:0},{finishedAt:null}])('invalid retained identity remains unknown',patch=>expect(qualifiedRegressionEvidence([run('1'),run('2','failed',patch)])).toEqual([]));

it('contradictory succeeded/failed outcomes remain unknown',()=>{const bad=run('2','failed',{status:'succeeded'});expect(qualifiedRegressionEvidence([run('1'),bad])).toEqual([]);expect(capabilityEvidence([bad])[0].unknown).toBe(1);});
it('unrecognized scopes cannot establish capability support',()=>expect(capabilityEvidence([run('1','passed',{scope:'future-unverified'})])[0].unknown).toBe(1));
it('result scope disagreement cannot establish regression',()=>{const bad=run('2','failed');bad.result.scope='local-translation';expect(compareCompatibilityRuns(run('1'),bad).comparable).toBe(false);});
