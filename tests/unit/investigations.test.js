import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import Database from 'better-sqlite3';
import { TABLES,buildCreateTableSql } from '../../src/lib/db/schema';
import { investigationStore } from '../../src/lib/db/repos/investigationsRepo';
import { INITIAL_SCOPE,validateSave,validateSelection,selectionExcluded } from '../../src/lib/db/analytics/investigationModel.mjs';
import { readEvidence,validateEvidenceQuery } from '../../src/lib/db/analytics/evidenceQueries.mjs';
import { readActivityAnalytics } from '../../src/lib/db/analytics/activityQueries.mjs';

let native,db,store;
const definition = (patch={}) => ({schemaVersion:1,lens:'capacity',scope:{...INITIAL_SCOPE},selection:null,comparisonIds:[],...patch});
const saved = (patch={}) => ({name:'Recorded comparison',kind:'investigation',definition:definition(),...patch});
beforeEach(()=>{
  native = new Database(':memory:');
  for (const [name,table] of Object.entries(TABLES)) native.exec(buildCreateTableSql(name,table));
  db = { get:(sql,args=[])=>native.prepare(sql).get(...args), all:(sql,args=[])=>native.prepare(sql).all(...args),run:(sql,args=[])=>native.prepare(sql).run(...args),transaction:(fn)=>native.transaction(fn)() };
  store = investigationStore(db);
});
afterEach(()=>native.close());
describe('Persistent operator workspaces',()=>{
  it('retains a historical quota series fingerprint with its exact account',()=>{
    const selection={kind:'account',id:'one',windowScope:'weekly',windowId:'a'.repeat(64)};
    const row=store.create(saved({definition:definition({selection})}));
    expect(store.get(row.id).definition.selection).toEqual(selection);
    for (const patch of [{windowId:'not-a-fingerprint'},{kind:'routing-switch'}])
      expect(()=>validateSelection({...selection,...patch})).toThrow();
  });
  it('persists a bounded definition, exact selection and multiaccount comparison',()=>{
    const input=saved({definition:definition({selection:{kind:'account',id:'one'},comparisonIds:['one','two']})});
    const row=store.create(input);
    expect(investigationStore(db).get(row.id)).toMatchObject({...input,version:1,ownerScope:'installation-operator'});
    expect(store.list()).toHaveLength(1);
  });
  it('round trips version 2 exact baselines while preserving version 1 definitions',()=>{
    const v1=store.create(saved());expect(store.get(v1.id).definition.schemaVersion).toBe(1);
    expect(store.get(v1.id).definition.context).not.toHaveProperty('baseline');
    const input=saved({definition:definition({schemaVersion:2,lens:'context',selection:{kind:'context-attempt',id:'selected',sessionId:8},context:{baseline:{id:'baseline',sessionId:7}}})});
    const v2=store.create(input);
    expect(investigationStore(db).get(v2.id).definition.context.baseline).toEqual({id:'baseline',sessionId:7});
    expect(validateSave({...input,kind:'filter-set'}).definition.context.baseline).toBeNull();
    for(const baseline of [{id:'x'},{id:'x',sessionId:0},{id:'x',sessionId:7,body:'private'}]) expect(()=>store.create({...input,definition:{...input.definition,context:{baseline}}})).toThrow();
  });
  it('round trips version 3 evidence cohorts while preserving version 1 and 2 definitions',()=>{
    const reference=`ctx1_${'a'.repeat(64)}`;
    const economics={groupBy:'client-project',status:'all',sortBy:'timestamp',sortDirection:'desc',cohort:{projectRef:reference},groupSortBy:'records',groupSortDirection:'asc',costSource:'provider-reported',attemptKind:'additional'};
    const v3=store.create(saved({definition:definition({schemaVersion:3,lens:'economics',economics})}));
    expect(investigationStore(db).get(v3.id).definition.economics).toEqual(economics);
    const v1=store.create(saved());
    expect(store.get(v1.id).definition.economics).not.toHaveProperty('costSource');
    const v2=store.create(saved({definition:definition({schemaVersion:2,lens:'context',selection:{kind:'context-attempt',id:'selected',sessionId:8},context:{baseline:{id:'baseline',sessionId:7}}})}));
    expect(store.get(v2.id).definition.context.baseline).toEqual({id:'baseline',sessionId:7});
    expect(store.get(v2.id).definition.economics).not.toHaveProperty('attemptKind');
    const v2economics={groupBy:'provider',status:'all',sortBy:'timestamp',sortDirection:'desc',cohort:null};
    for(const economicsPatch of [{groupBy:'client-project'},{cohort:{projectRef:reference}},{costSource:'provider-reported'}])
      expect(()=>store.create(saved({definition:definition({schemaVersion:2,economics:{...v2economics,...economicsPatch}})}))).toThrow();
    for(const cohort of [{projectRef:'raw'},{missing:'projectRef',projectRef:reference},{missing:'apiKey'},{sessionId:0}])
      expect(()=>store.create(saved({definition:definition({schemaVersion:3,economics:{...economics,cohort}})}))).toThrow();
    expect(()=>store.create(saved({definition:definition({schemaVersion:5})}))).toThrow(/version/);
  });
  it('rejects lost updates and stale deletes without changing stored bytes',()=>{
    const row=store.create(saved());
    const updated=store.update(row.id,{...saved({name:'Second tab'}),version:1});
    expect(updated.version).toBe(2);
    const before=JSON.stringify(store.get(row.id));
    expect(()=>store.update(row.id,{...saved(),version:1})).toThrow(/another view/);
    expect(()=>store.remove(row.id,1)).toThrow(/changed/);
    expect(JSON.stringify(store.get(row.id))).toBe(before);
    expect(store.remove(row.id,2)).toEqual({deleted:true,id:row.id});
  });
  it('never lets another owner read or modify a saved record',()=>{
    const row=store.create(saved()), other=investigationStore(db,'different-owner');
    expect(other.get(row.id)).toBeNull(); expect(other.list()).toEqual([]);
    expect(()=>other.update(row.id,{...saved(),version:1})).toThrow(/not found/);
    expect(()=>other.remove(row.id,1)).toThrow(/not found/);
  });
  it.each([{secret:'no'}, {definition:definition({prompt:'no'})}, {name:'bad\nname'}, {definition:definition({scope:{...INITIAL_SCOPE,provider:4}})}])('rejects unsupported payload fields/types %#',(patch)=>{
    expect(()=>store.create(saved(patch))).toThrow(); expect(store.list()).toEqual([]);
  });
  it('treats markup names as ordinary strings and parameterizes filters',()=>{
    const row=store.create(saved({name:'<img src=x onerror=alert(1)>',definition:definition({scope:{...INITIAL_SCOPE,provider:"x' OR 1=1--"}})}));
    expect(store.get(row.id).name).toBe('<img src=x onerror=alert(1)>');
  });
  it('requires exact bookmarks and removes selection from named filter sets',()=>{
    expect(()=>validateSave(saved({kind:'bookmark'}))).toThrow(/Select/);
    expect(validateSave(saved({kind:'bookmark',definition:definition({selection:{kind:'economics-record',id:'2'}})})).definition.lens).toBe('economics');
    const result=validateSave(saved({kind:'filter-set',definition:definition({selection:{kind:'account',id:'one'},comparisonIds:['one']})}));
    expect(result.definition.selection).toBeNull(); expect(result.definition.comparisonIds).toEqual([]);
  });
  it('validates fixed UTC bounds and exact Context identities',()=>{
    expect(()=>validateSave(saved({definition:definition({scope:{...INITIAL_SCOPE,period:'custom',start:'2026-02-31T00:00:00.000Z',end:'2026-04-01T00:00:00.000Z'}})}))).toThrow();
    expect(()=>validateSelection({kind:'context-attempt',id:'request'})).toThrow();
    expect(()=>validateSelection({kind:'context-session',id:'7',sessionId:8})).toThrow(/match/);
    expect(()=>validateSelection({kind:'economics-record',id:'9007199254740993'})).toThrow(/ledger/);
    expect(()=>validateSave(saved({definition:definition({selection:{kind:'context-session',id:'7'},context:{sessionId:8}})}))).toThrow(/same session/);
    expect(selectionExcluded({kind:'routing-switch',id:'r',connectionId:'to',fromConnectionId:'from'},{...INITIAL_SCOPE,connectionId:'from'})).toBe(false);
    expect(selectionExcluded({kind:'context-attempt',id:'r',provider:'claude',timestamp:'2026-09-06T00:00:00.000Z'},{...INITIAL_SCOPE,provider:'codex'})).toBe(true);
  });
});
describe('Complete evidence exports',()=>{
  it('persists version 4 identity filters and exports the same selected cohort as its lens',()=>{
    seed(6);
    db.run("UPDATE usageHistory SET status='success',costSource='provider-reported',logicalRequestId='logical',dispatchCoverage='physical-dispatch',attempt=2");
    db.run("UPDATE usageHistory SET status='error' WHERE id=1");
    db.run("UPDATE usageHistory SET costSource='application-estimate' WHERE id=3");
    const selection={kind:'economics-group',id:JSON.stringify(['provider','claude',null]),groupBy:'provider',provider:'claude'};
    const economics={status:'succeeded',costSource:'provider-reported',attemptKind:'additional',filters:{logicalRequestId:'logical',missing:'clientKeyId'}};
    const row=store.create(saved({definition:definition({schemaVersion:4,lens:'economics',selection,economics})}));
    expect(store.get(row.id).definition.economics.filters).toEqual(economics.filters);
    const exported=readEvidence(db,{operation:'evidence',mode:'selected',definition:row.definition});
    expect(exported.items.map(item=>item.id)).toEqual([5]);
    const displayed=readActivityAnalytics(db,{operation:'activity',view:'economics',provider:'claude',status:'succeeded',costSource:'provider-reported',attemptKind:'additional',...economics.filters});
    expect(exported.items.map(item=>item.id)).toEqual(displayed.items.map(item=>item.id));
    const exact=readEvidence(db,{operation:'evidence',mode:'selected',definition:{...row.definition,selection:{kind:'economics-record',id:'1'}}});
    expect(exact.items.map(item=>item.id)).toEqual([1]);
    expect(()=>store.create(saved({definition:definition({schemaVersion:4,economics:{filters:{clientSessionRef:'private raw session'}}})}))).toThrow(/reference/);
    expect(()=>readEvidence(db,{operation:'evidence',mode:'selected',definition:{...row.definition,economics:{...economics,filters:{missing:'provider'}}}})).toThrow(/conflict/);
  });
  function seed(count=103) {
    db.transaction(()=>{for(let i=1;i<=count;i++) db.run('INSERT INTO usageHistory(id,timestamp,provider,model,promptTokens,completionTokens,tokens,meta,requestId) VALUES(?,?,?,?,?,?,?,?,?)',
      [i,'2026-09-06T12:00:00.000Z',i%2?'claude':'codex','model',100,2,'{"cached_tokens":20,"cache_creation_input_tokens":0,"secret":"PRIVATE"}','PRIVATE',i===1?'exact-request':null]);});
  }
  const query=(patch={})=>({operation:'evidence',mode:'population',definition:definition({lens:'economics'}),...patch});
  it('exports all matching rows beyond page one with a completeness manifest',()=>{
    seed();const result=readEvidence(db,query());
    expect(result.items).toHaveLength(103);expect(result.manifest).toMatchObject({source:'usageHistory',complete:true,totalRecords:103,returnedRecords:103});
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.manifest.timeBounds.firstReturned).toBe('2026-09-06T12:00:00.000Z');
  });
  it('distinguishes exact legacy ledger record IDs from request attribution',()=>{
    seed(); const result=readEvidence(db,query({mode:'selected',definition:definition({lens:'economics',scope:{...INITIAL_SCOPE,provider:'claude'},selection:{kind:'economics-record',id:'2'}})}));
    expect(result.items.map(row=>row.id)).toEqual([2]);expect(result.items[0].requestId).toBeNull();
    expect(readActivityAnalytics(db,{operation:'activity',view:'economics',recordId:'2'}).items.map(row=>row.id)).toEqual([2]);
    expect(readActivityAnalytics(db,{operation:'activity',view:'economics',requestId:'exact-request'}).items.map(row=>row.id)).toEqual([1]);
  });
  it('refuses oversized populations atomically with no partial items',()=>{
    seed(5001);const result=readEvidence(db,query());expect(result).toMatchObject({refused:true,totalRecords:5001});expect(result).not.toHaveProperty('items');
  });
  it('uses shared filters and exclusive UTC bounds for the entire export',()=>{
    seed(); const result=readEvidence(db,query({definition:definition({lens:'economics',scope:{...INITIAL_SCOPE,provider:'codex'}})}));
    expect(result.items).toHaveLength(51);expect(result.items.every(row=>row.provider==='codex')).toBe(true);
    const none=readEvidence(db,query({definition:definition({lens:'economics',scope:{...INITIAL_SCOPE,period:'custom',start:'2026-09-06T11:00:00.000Z',end:'2026-09-06T12:00:00.000Z'}})}));expect(none.items).toEqual([]);
  });
  it('constrains selected cohorts to shared bounds and refuses conflicting dimensions',()=>{
    seed();
    const selection={kind:'economics-group',id:JSON.stringify(['provider','codex',null]),groupBy:'provider',provider:'codex'};
    const none=readEvidence(db,query({mode:'selected',definition:definition({lens:'economics',selection,scope:{...INITIAL_SCOPE,period:'custom',start:'2026-09-06T11:00:00.000Z',end:'2026-09-06T12:00:00.000Z'}})}));
    expect(none.items).toEqual([]);expect(none.manifest.scopeSemantics).toContain('fixed shared scope');
    expect(()=>readEvidence(db,query({definition:definition({lens:'economics',scope:{...INITIAL_SCOPE,provider:'claude'},economics:{cohort:{provider:'codex'}}})}))).toThrow(/conflicts/);
  });
  it('does not guess missing selected identities or accept alternate worker operations',()=>{
    seed(); const result=readEvidence(db,query({mode:'selected',definition:definition({lens:'economics',selection:{kind:'economics-record',id:'999'}})}));
    expect(result.manifest.missingSelection).toBe(true);expect(result.items).toEqual([]);
    expect(()=>validateEvidenceQuery({...query(),sql:'SELECT * FROM settings'})).toThrow();
  });
  it('exports only selected accounts and reports deleted comparison members',()=>{
    db.run('INSERT INTO providerConnections(id,provider,name,data,createdAt,updatedAt,authType) VALUES(?,?,?,?,?,?,?)',['one','claude','Account one','{"apiKey":"PRIVATE"}','2026-01-01','2026-01-01','apikey']);
    const result=readEvidence(db,query({mode:'comparison',definition:definition({comparisonIds:['one','deleted']})}));
    expect(result.items.map(row=>row.id)).toEqual(['one']);expect(result.manifest.coverage.missingAccounts).toEqual(['deleted']);expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
