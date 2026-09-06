// @vitest-environment jsdom
import {act,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {WorkspaceProvider,useWorkspace,INITIAL_SCOPE} from '../../src/shared/workspace/WorkspaceProvider';
let current,root,container;
function Probe(){const state=useWorkspace();useEffect(()=>{current=state;});return <span>{state.selectedRecord?.id||'No selection'}</span>;}
async function render(key='capacity'){await act(async()=>root.render(<WorkspaceProvider><Probe key={key}/></WorkspaceProvider>));}
beforeEach(()=>{globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:200})));container=document.createElement('div');document.body.append(container);root=createRoot(container);});
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
  const definition=current.captureDefinition('context');expect(definition.schemaVersion).toBe(2);
  await render('economics');await act(async()=>current.setScope({provider:'outside'}));expect(current.contextView.baseline).toEqual({id:'baseline',sessionId:7});
  await act(async()=>{current.setContextView({baseline:null});current.restoreInvestigation({kind:'investigation',definition});});
  expect(current.contextView.baseline).toEqual({id:'baseline',sessionId:7});expect(current.selectedRecord.id).toBe('selected');
  const legacy={...definition,schemaVersion:1,context:{sessionId:8,page:1,clientTool:null,projectLabel:null}};
  await act(async()=>current.restoreInvestigation({kind:'investigation',definition:legacy}));expect(current.contextView.baseline).toBeNull();
});
