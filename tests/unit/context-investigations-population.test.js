import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
import { parseContextFilter, readContextOverview, readContextSession, validateAnalyticsQuery } from '../../src/lib/db/analytics/contextQueries.mjs';
import { INITIAL_SCOPE, validateDefinition } from '../../src/lib/db/analytics/investigationModel.mjs';

let native,db;
const at='2026-09-06T12:00:00.000Z';
const parsed=params=>parseContextFilter(new URLSearchParams(params));
beforeEach(()=>{
  native=new Database(':memory:');
  for(const [name,table] of Object.entries(TABLES)) native.exec(buildCreateTableSql(name,table));
  db={get:(sql,args=[])=>native.prepare(sql).get(...args),all:(sql,args=[])=>native.prepare(sql).all(...args)};
});
afterEach(()=>native.close());
function session(id,label=`Project ${String(id).padStart(3,'0')}`) {
  native.prepare('INSERT INTO contextSessions(id,sessionHash,firstSeenAt,lastSeenAt,identitySource,projectLabel) VALUES(?,?,?,?,?,?)').run(id,`PRIVATE-${id}`,at,at,'explicit',label);
}
function attempt(id,sessionId=1,time=at,provider='scope-a',measured=true) {
  native.prepare('INSERT INTO requestStats(id,timestamp,contextSessionId,logicalRequestId,provider,model,usageSource,usageInputPresent,usageOutputPresent,cacheReadPresent,promptTokens,completionTokens,cachedTokens,bodyBeforeBytes,bodyAfterBytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,time,sessionId,`logical-${id}`,provider,'model',measured?'provider':'missing',measured?1:0,measured?1:0,measured?1:0,measured?100:null,measured?10:null,measured?20:null,measured?300:null,measured?200:null);
}
describe('Context complete investigation projections',()=>{
  it('applies an exact durable project filter and refuses mismatched attempt links',()=>{
    session(1); attempt('linked'); attempt('wrong-link'); attempt('unassigned');
    const insert=native.prepare('INSERT INTO usageHistory(timestamp,requestId,logicalRequestId,provider,model,projectId) VALUES(?,?,?,?,?,?)');
    insert.run(at,'linked','logical-linked','scope-a','model','project-one');
    insert.run(at,'wrong-link','different-logical','scope-a','model','project-one');
    const filter=parsed({projectId:'project-one'});
    expect(validateAnalyticsQuery({operation:'overview',retainedDays:null,filter}).filter.projectId).toBe('project-one');
    const result=readContextOverview(db,filter);
    expect(result.summary.attempts).toBe(1);
    expect(readContextOverview(db,{projectId:'absent'}).summary.attempts).toBe(0);
    expect(readContextOverview(db,{}).summary.attempts).toBe(3);
  });
  it('searches all project labels before pagination and retains an off-page selection',()=>{
    for(let i=1;i<=137;i++){session(i);attempt(`r-${i}`,i);}
    session(200,'Wrong provider');attempt('wrong',200,at,'scope-b');
    const first=readContextOverview(db,parsed({view:'projects',provider:'scope-a',projectLabel:'Project 137',pageSize:'20'}));
    expect(first.pagination).toMatchObject({totalItems:137,totalPages:7,hasNext:true});
    expect(first.selectedLabel).toBe('Project 137');expect(first.projects[0].projectLabel).toBe('Project 001');
    const last=readContextOverview(db,parsed({view:'projects',provider:'scope-a',page:'7',pageSize:'20'}));
    expect(last.projects.at(-1).projectLabel).toBe('Project 137');expect(last.pagination.hasNext).toBe(false);
    const searched=readContextOverview(db,parsed({view:'projects',provider:'scope-a',projectSearch:'137',pageSize:'1'}));
    expect(searched.projects).toMatchObject([{projectLabel:'Project 137',attempts:1,sessions:1}]);expect(searched.pagination.totalItems).toBe(1);
    expect(JSON.stringify(first)).not.toContain('PRIVATE');
  });
  it('uses literal project substrings and complete time/client scope rather than SQL wildcards',()=>{
    session(1,'100%_literal');attempt('old');session(2,'Other');attempt('new',2,'2026-09-07T12:00:00.000Z');
    expect(readContextOverview(db,parsed({view:'projects',projectSearch:'%_'})).projects).toHaveLength(1);
    expect(readContextOverview(db,parsed({view:'projects',from:'2026-09-07T00:00:00Z'})).projects.map(p=>p.projectLabel)).toEqual(['Other']);
    expect(readContextOverview(db,parsed({view:'projects',clientTool:'absent'})).pagination.totalItems).toBe(0);
  });
  it('continues beyond 100 tied switch receipts without duplication when newer rows arrive',()=>{
    session(1);session(2);
    const insert=native.prepare('INSERT INTO accountSwitches(id,sessionHash,model,toConnectionId,trigger,switchedAt) VALUES(?,?,?,?,?,?)');
    for(let i=1;i<=137;i++)insert.run(`s-${String(i).padStart(3,'0')}`,'PRIVATE-1','model','account','initial-pin',at);
    insert.run('other-session','PRIVATE-2','model','account','initial-pin',at);
    const filter={view:'routing',routingKind:'switches',pageSize:'25'};
    let result=readContextSession(db,1,parsed(filter));
    expect(result.pagination.totalItems).toBe(137);
    const ids=result.items.map(item=>item.id);
    insert.run('newer','PRIVATE-1','model','account','initial-pin','2026-09-07T00:00:00.000Z');
    while(result.pagination.hasMore){result=readContextSession(db,1,parsed({...filter,cursor:result.pagination.nextCursor}));ids.push(...result.items.map(item=>item.id));}
    expect(ids).toHaveLength(137);expect(new Set(ids).size).toBe(137);expect(ids.at(-1)).toBe('s-001');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(readContextSession(db,999,parsed(filter))).toBeNull();
  });
  it('continues stored pins and refuses malformed or wrong-kind cursors',()=>{
    session(1);
    for(let i=0;i<105;i++)native.prepare('INSERT INTO sessionAffinity(sessionHash,model,connectionId,pinnedAt,lastSeenAt) VALUES(?,?,?,?,?)').run('PRIVATE-1',`m-${String(i).padStart(3,'0')}`,'account',at,at);
    const first=readContextSession(db,1,parsed({view:'routing',routingKind:'pins',pageSize:'100'}));
    const next=readContextSession(db,1,parsed({view:'routing',routingKind:'pins',pageSize:'100',cursor:first.pagination.nextCursor}));
    expect(next.items).toHaveLength(5);expect(next.items[0].model).toBe('m-100');
    expect(()=>parsed({view:'routing',routingKind:'switches',cursor:first.pagination.nextCursor})).toThrow('cursor');
    expect(()=>parsed({view:'routing',cursor:'bogus'})).toThrow('cursor');
  });
  it('compares whole half-open periods with common dimensions, sample denominators and unknowns',()=>{
    session(1);attempt('start',1,'2026-09-06T00:00:00.000Z');attempt('missing',1,'2026-09-06T01:00:00.000Z','scope-a',false);
    attempt('next-boundary',1,'2026-09-07T00:00:00.000Z');attempt('excluded',1,'2026-09-08T00:00:00.000Z');attempt('wrong-scope',1,at,'scope-b');
    const filter=parsed({view:'interval-comparison',provider:'scope-a',baselineFrom:'2026-09-06T00:00:00Z',baselineUntil:'2026-09-07T00:00:00Z',from:'2026-09-07T00:00:00Z',until:'2026-09-08T00:00:00Z',pageSize:'1'});
    const result=readContextOverview(db,filter);
    expect(result.baseline.summary).toMatchObject({attempts:2,requests:2,providerInputTokens:100,savedBytes:100,cacheWriteTokens:null});
    expect(result.baseline.coverage).toMatchObject({providerInputSamples:1,cacheWriteSamples:0,bodySamples:1});
    expect(result.selected.summary.attempts).toBe(1);expect(result.overlapMs).toBe(0);expect(result.baseline.period.durationMs).toBe(86400000);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const empty=readContextOverview(db,{...filter,provider:'absent'});
    expect(empty.baseline.summary.attempts).toBe(0);expect(empty.baseline.summary.providerInputTokens).toBeNull();
  });
  it('rejects incomplete periods and admits new projections through the worker validator',()=>{
    expect(()=>parsed({view:'interval-comparison',from:at,until:at})).toThrow();
    expect(()=>parsed({view:'interval-comparison',from:at,until:'2026-09-07T00:00:00Z'})).toThrow();
    expect(()=>parsed({view:'projects',projectSearch:'x'.repeat(81)})).toThrow();
    expect(validateAnalyticsQuery({operation:'overview',retainedDays:null,filter:{view:'projects',projectSearch:'literal'}}).filter.view).toBe('projects');
  });
  it('round-trips explicit interval definitions in version 5 without changing old definitions',()=>{
    const pair={baseline:{start:'2026-09-06T00:00:00Z',end:'2026-09-07T00:00:00Z'},selected:{start:'2026-09-07T00:00:00Z',end:'2026-09-08T00:00:00Z'}};
    const base={schemaVersion:5,lens:'context',scope:INITIAL_SCOPE,context:{intervalComparison:pair}};
    const saved=validateDefinition(base);
    expect(saved.context.intervalComparison.baseline.start).toBe('2026-09-06T00:00:00.000Z');expect(validateDefinition(saved)).toEqual(saved);
    for(const version of [1,2,3,4]) expect(validateDefinition({...base,schemaVersion:version,context:{}}).context).not.toHaveProperty('intervalComparison');
    expect(()=>validateDefinition({...base,schemaVersion:4})).toThrow();
    expect(()=>validateDefinition({...base,context:{intervalComparison:{...pair,baseline:{...pair.baseline,end:pair.baseline.start}}}})).toThrow();
  });
});
