// @vitest-environment jsdom
import {act,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {WorkspaceProvider,useWorkspace,INITIAL_SCOPE} from '../../src/shared/workspace/WorkspaceProvider';
let current,root,container;
function Probe(){const state=useWorkspace();useEffect(()=>{current=state;});return <span>{state.selectedRecord?.id||'No selection'}</span>;}
async function render(key='capacity'){await act(async()=>root.render(<WorkspaceProvider><Probe key={key}/></WorkspaceProvider>));}
beforeEach(()=>{globalThis.IS_REACT_ACT_ENVIRONMENT=true;window.history.replaceState(null,'','/');vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:200})));container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.unstubAllGlobals();});
it('retains the same typed identity across lens remounts and incompatible scope changes',async()=>{
  await render();expect(current.selectedRecord).toBeNull();
  await act(async()=>{current.setSelectedRecord({kind:'context-attempt',id:'exact-request',sessionId:4,provider:'claude'});current.setContextView({sessionId:4,page:3});});
  await render('economics');expect(current.selectedRecord.id).toBe('exact-request');expect(current.contextView.page).toBe(3);
  await act(async()=>current.setScope({provider:'codex'}));expect(current.selectedRecord.id).toBe('exact-request');expect(current.contextView.page).toBe(1);
});
it('captures and restores fixed bounds, selected record, lens controls and comparison IDs',async()=>{
  await render();await act(async()=>{current.setSelectedAccountId('account-1');current.setComparisonIds(['account-1','account-2']);current.setEconomicsView({groupBy:'model',status:'failed'});});
  const definition=current.captureDefinition('capacity');await act(async()=>{current.setSelectedRecord(null);current.setComparisonIds([]);current.setScope({provider:'absent'});});
  await act(async()=>current.restoreInvestigation({id:'saved',name:'Comparison',kind:'investigation',version:1,definition}));
  expect(current.selectedRecord).toMatchObject({kind:'account',id:'account-1'});expect(current.comparisonIds).toEqual(['account-1','account-2']);expect(current.economicsView).toMatchObject({groupBy:'model',status:'failed'});expect(current.scope).toEqual(INITIAL_SCOPE);
});
it('restores a named filter set without replacing retained selected evidence',async()=>{
  await render();await act(async()=>current.setSelectedRecord({kind:'routing-switch',id:'receipt-1'}));
  const definition={...current.captureDefinition('routing'),selection:null,scope:{...INITIAL_SCOPE,provider:'codex'}};
  await act(async()=>current.restoreInvestigation({kind:'filter-set',definition}));expect(current.scope.provider).toBe('codex');expect(current.selectedRecord.id).toBe('receipt-1');
});

it('recovers exact comparison identities across lens remounts, saves and legacy restores',async()=>{
  await render();await act(async()=>{current.setSelectedRecord({kind:'context-attempt',id:'selected',sessionId:8});current.setContextView({sessionId:8,baseline:{id:'baseline',sessionId:7}});});
  const definition=current.captureDefinition('context');expect(definition.schemaVersion).toBe(3);
  await render('economics');await act(async()=>current.setScope({provider:'outside'}));expect(current.contextView.baseline).toEqual({id:'baseline',sessionId:7});
  await act(async()=>{current.setContextView({baseline:null});current.restoreInvestigation({kind:'investigation',definition});});
  expect(current.contextView.baseline).toEqual({id:'baseline',sessionId:7});expect(current.selectedRecord.id).toBe('selected');
  const {groupSortBy:_g,groupSortDirection:_d,costSource:_c,attemptKind:_a,...legacyEconomics}=definition.economics;
  const legacy={...definition,schemaVersion:1,economics:{...legacyEconomics,cohort:null},context:{sessionId:8,page:1,clientTool:null,projectLabel:null}};
  await act(async()=>current.restoreInvestigation({kind:'investigation',definition:legacy}));expect(current.contextView.baseline).toBeNull();
});

it('serializes the shared scope into the URL and restores it on a hard reload',async()=>{
  await render();
  await act(async()=>current.setScope({period:'custom',start:'2026-09-01T00:00:00.000Z',end:'2026-09-02T00:00:00.000Z',provider:'claude',model:'claude-opus-4',connectionId:'acct-1'}));
  await act(async()=>current.setComparisonIds(['acct-1','acct-2']));
  const search=window.location.search;
  const params=new URLSearchParams(search);
  expect(params.get('period')).toBe('custom');expect(params.get('provider')).toBe('claude');
  expect(params.get('start')).toBe('2026-09-01T00:00:00.000Z');expect(params.get('compare')).toBe('acct-1,acct-2');
  // Hard reload: a fresh provider tree hydrates from the URL alone.
  act(()=>root.unmount());container.remove();container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await render();
  expect(current.scope).toMatchObject({period:'custom',provider:'claude',model:'claude-opus-4',connectionId:'acct-1',start:'2026-09-01T00:00:00.000Z',end:'2026-09-02T00:00:00.000Z'});
  expect(current.comparisonIds).toEqual(['acct-1','acct-2']);
});
it('clears scope params back to defaults and survives a malformed shared link',async()=>{
  await render();
  await act(async()=>current.setScope({provider:'claude'}));
  expect(new URLSearchParams(window.location.search).get('provider')).toBe('claude');
  await act(async()=>current.setScope({provider:null}));
  expect(new URLSearchParams(window.location.search).get('provider')).toBeNull();
  window.history.replaceState(null,'','?period=custom&start=not-a-date');
  act(()=>root.unmount());container.remove();container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await render();
  expect(current.scope).toEqual(INITIAL_SCOPE);
});

it('restores the selected record from the URL, so the retained banner survives a reload',async()=>{
  await render();
  await act(async()=>current.setSelectedRecord({kind:'account',id:'conn-7',provider:'claude'}));
  // The writeback effect puts the selection in the query string.
  expect(new URLSearchParams(window.location.search).get('selected')).toContain('conn-7');
  // A reload is a fresh provider reading that same location.
  act(()=>root.unmount());container.remove();
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await render();
  expect(current.selectedRecord.id).toBe('conn-7');
  expect(current.selectedRecord.kind).toBe('account');
});

it('ignores a hand-edited selection param rather than trusting it',async()=>{
  window.history.replaceState(null,'','/?selected=' + encodeURIComponent('{"kind":"not-a-kind","id":"x"}'));
  await render();
  expect(current.selectedRecord).toBeNull();
});
