// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { act,useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import Database from 'better-sqlite3';
import { TABLES,buildCreateTableSql } from '@/lib/db/schema';
import { readActivityAnalytics } from '@/lib/db/analytics/activityQueries.mjs';
import { WorkspaceProvider,useWorkspace } from '@/shared/workspace/WorkspaceProvider';
let native,db,host,root,current;
function Probe(){const state=useWorkspace();useEffect(()=>{current=state;});return <div>{state.activity.data?.summary?.records} total attempts</div>;}
beforeEach(()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;window.history.replaceState(null,'','/');
  native=new Database(':memory:');for(const [name,table] of Object.entries(TABLES))native.exec(buildCreateTableSql(name,table));
  db={get:(sql,args=[])=>native.prepare(sql).get(...args),all:(sql,args=[])=>native.prepare(sql).all(...args)};
  const insert=native.prepare('INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens) VALUES(?,?,?,?,?,?,?,?)');
  for(let i=1;i<=103;i++)insert.run(`request-${String(i).padStart(3,'0')}`,'2026-09-07T12:00:00.000Z','fixture','model',`account-${String(i).padStart(3,'0')}`,'success',i,1);
  vi.stubGlobal('fetch',vi.fn(async(url)=>{
    if(url.startsWith('/api/analytics?'))return Response.json(readActivityAnalytics(db,{operation:'activity',...Object.fromEntries(new URL(url,'http://localhost').searchParams)}));
    return Response.json({});
  }));host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();native.close();vi.unstubAllGlobals();});
it('reaches every retained account group while keeping complete totals and exact selection across pages',async()=>{
  await act(async()=>root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>));
  expect(current.inventoryActivity.data.groups).toHaveLength(100);expect(current.activity.data.summary.records).toBe(103);
  const first=current.inventoryActivity.data.groups.map(row=>row.connectionId);
  await act(async()=>{current.setSelectedAccountId('account-103');current.setComparisonIds(['account-001','account-103']);current.setActivityGroupPage(2);});
  expect(current.inventoryActivity.data.groups).toHaveLength(3);
  expect(new Set([...first,...current.inventoryActivity.data.groups.map(row=>row.connectionId)]).size).toBe(103);
  expect(current.inventoryActivity.data.groupPagination).toMatchObject({page:2,totalItems:103,totalPages:2});
  expect(current.activity.data.summary.records).toBe(103);expect(host.textContent).toContain('103 total attempts');
  expect(current.selectedRecord.id).toBe('account-103');expect(current.comparisonIds).toEqual(['account-001','account-103']);
  await act(async()=>current.setActivityGroupPage(1));expect(current.inventoryActivity.data.groups.map(row=>row.connectionId)).toEqual(first);
  expect(current.selectedRecord.id).toBe('account-103');
  await act(async()=>current.setScope({provider:'absent'}));expect(current.activityGroupPage).toBe(1);expect(current.inventoryActivity.data.groups).toEqual([]);
});
