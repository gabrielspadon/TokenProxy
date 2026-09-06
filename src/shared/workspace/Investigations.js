'use client';
import { useState } from 'react';
import { usePathname,useRouter } from 'next/navigation';
import { Alert, Badge, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useWorkspace } from './WorkspaceProvider';
import { useResource } from './useResource';
import { LENS_PATHS,selectionExcluded,selectionLens } from '@/lib/db/analytics/investigationModel.mjs';
import styles from './investigations.module.css';

async function request(url,method,body) {
  const response=await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if (!response.ok) { const error=new Error(result.error || 'The operation failed.');error.code=result.code;throw error; }
  return result;
}
const kindName={'investigation':'Investigation','filter-set':'Named filter set','bookmark':'Record bookmark'};
export function Investigations() {
  const workspace=useWorkspace(), router=useRouter(), pathname=usePathname();
  const lens=Object.entries(LENS_PATHS).find(([,path])=>path===pathname)?.[0] || 'capacity';
  const [open,setOpen]=useState(false),[name,setName]=useState(''),[kind,setKind]=useState('investigation');
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState(null),[notice,setNotice]=useState(null),[deleting,setDeleting]=useState(null);
  const entries=useResource(open ? '/api/admin/investigations' : null);
  const start=()=>{setName(workspace.savedEntry?.name || '');setKind(workspace.savedEntry?.kind || 'investigation');setFailure(null);setNotice(null);setOpen(true);};
  async function save(update=false) {
    setBusy(true);setFailure(null);setNotice(null);
    try {
      const current=workspace.savedEntry;
      const body={name,kind,definition:workspace.captureDefinition(lens),...(update ? {version:current.version} : {})};
      const result=await request(`/api/admin/investigations${update ? `/${current.id}` : ''}`,update ? 'PUT' : 'POST',body);
      workspace.setSavedEntry(result);entries.refresh();setNotice(`${kindName[kind]} saved as version ${result.version}.`);
    } catch(error){setFailure(error);} finally{setBusy(false);}
  }
  function restore(entry) {
    workspace.restoreInvestigation(entry);setName(entry.name);setKind(entry.kind);setOpen(false);
    if(entry.kind!=='filter-set')router.push(LENS_PATHS[entry.definition.lens]);
  }
  async function remove() {
    setBusy(true);setFailure(null);
    try {await request(`/api/admin/investigations/${deleting.id}`,'DELETE',{version:deleting.version});
      if(workspace.savedEntry?.id===deleting.id)workspace.setSavedEntry(null);
      setDeleting(null);entries.refresh();setNotice('Saved entry deleted.');
    } catch(error){setFailure(error);} finally{setBusy(false);}
  }
  async function reloadVersion() {
    setBusy(true);setFailure(null);
    try {const response=await fetch(`/api/admin/investigations/${workspace.savedEntry.id}`);const body=await response.json();if(!response.ok)throw new Error(body.error);workspace.setSavedEntry(body);setName(body.name);setKind(body.kind);entries.refresh();setNotice('Latest saved version loaded. Current filters and selected evidence are unchanged.');}
    catch(error){setFailure(error);} finally{setBusy(false);}
  }
  return <>
    <Button variant="default" size="compact-sm" onClick={start}>Saved investigations</Button>
    <Modal title="Saved investigations" opened={open} onClose={()=>{if(!busy){setOpen(false);setDeleting(null);}}} size="lg" closeButtonProps={{'aria-label':'Close saved investigations'}}>
      <Stack gap="md">
        <Text size="sm" c="#5b6980">Shared by this installation’s authenticated operators. Saved ranges use fixed UTC boundaries. No request content or credentials are stored.</Text>
        {failure && <Alert color="red" title={failure.code==='version_conflict'?'Another view changed this entry':'Save operation failed'}>{failure.message}{failure.code==='version_conflict' && <Button variant="subtle" onClick={reloadVersion} disabled={busy}>Reload saved version</Button>}</Alert>}
        {notice && <Alert color="teal">{notice}</Alert>}
        {deleting ? <Alert title={`Delete “${deleting.name}”?`} color="orange">The stored definition will be removed; evidence records are untouched.<Group mt="sm"><Button color="red" loading={busy} onClick={remove}>Delete saved entry</Button><Button variant="default" disabled={busy} onClick={()=>setDeleting(null)}>Cancel deletion</Button></Group></Alert> : <form onSubmit={(event)=>{event.preventDefault();save(false);}}>
          <Group align="end" grow><TextInput data-autofocus label="Name" maxLength={80} value={name} onChange={(event)=>setName(event.currentTarget.value)} required disabled={busy}/><Select label="Save as" value={kind} onChange={setKind} allowDeselect={false} data={Object.entries(kindName).map(([value,label])=>({value,label}))}/></Group>
          <Text size="sm" c="#5b6980" mt="xs">{kind==='filter-set'?'Filters only. Restoring this set retains your selected evidence.':kind==='bookmark'?'The exact selected identity, its fixed scope and comparison accounts.':'Current lens, filters, selected identity, account comparison and lens controls.'}</Text>
          <Group mt="sm"><Button type="submit" loading={busy} disabled={!name.trim() || (kind==='bookmark'&&!workspace.selectedRecord)}>Save new entry</Button>{workspace.savedEntry && <Button variant="default" disabled={busy||!name.trim()} onClick={()=>save(true)}>Update version {workspace.savedEntry.version}</Button>}</Group>
        </form>}
        <section aria-label="Stored investigations" className={styles.entries}>
          <h3>Stored definitions</h3>
          {entries.loading && <Text role="status">Reading saved entries…</Text>}
          {entries.error && <Alert color="red">{entries.error}<Button variant="subtle" onClick={entries.refresh}>Retry saved entries</Button></Alert>}
          {!entries.loading && entries.data?.items?.length===0 && <Text c="#5b6980">No saved definitions yet.</Text>}
          {entries.data?.items?.map((entry)=><div key={entry.id} className={styles.entry}><div><strong>{entry.name}</strong><Text size="sm" c="#5b6980">{kindName[entry.kind]} · {entry.definition.lens} · version {entry.version}</Text></div><Group gap="xs"><Button size="compact-sm" variant="light" aria-label={`Restore ${entry.name}`} onClick={()=>restore(entry)}>Restore</Button><Button size="compact-sm" variant="subtle" color="red" aria-label={`Delete ${entry.name}`} onClick={()=>{setDeleting(entry);setFailure(null);}}>Delete</Button></Group></div>)}
        </section>
      </Stack>
    </Modal>
  </>;
}
export function SelectionEvidence() {
  const workspace=useWorkspace(), router=useRouter(), pathname=usePathname();
  const [open,setOpen]=useState(false),[mode,setMode]=useState('selected'),[busy,setBusy]=useState(false),[error,setError]=useState(null),[manifest,setManifest]=useState(null);
  const selected=workspace.selectedRecord;
  const canExportPopulation=pathname!==LENS_PATHS.capacity;
  const lens=Object.entries(LENS_PATHS).find(([,path])=>path===pathname)?.[0] || 'capacity';
  async function download() {
    setBusy(true);setError(null);setManifest(null);
    try {
      const result=await request('/api/admin/investigations/export','POST',{mode,definition:workspace.captureDefinition(lens)});
      if(workspace.snapshot)result.manifest.preview={...workspace.snapshot,basis:'Authenticated response headers observed by this workspace; freshness describes the database read transaction.'};
      const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
      const anchor=document.createElement('a');anchor.href=url;anchor.download=`tokenproxy-evidence-${lens}-${new Date().toISOString().replaceAll(':','-')}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setManifest(result.manifest);
    } catch(failure){setError(failure.message);}finally{setBusy(false);}
  }
  return <div className={styles.selectionBar} aria-label="Retained evidence selection">
    <div>{selected ? <><Badge variant="light" c={selectionExcluded(selected,workspace.scope)?'#91430f':undefined} color={selectionExcluded(selected,workspace.scope)?'orange':'indigo'}>{selectionExcluded(selected,workspace.scope)?'Excluded by current scope':'Selection retained'}</Badge><span className={styles.record}>{selected.kind} · {selected.id}</span><Button size="compact-xs" variant="subtle" onClick={()=>router.push(LENS_PATHS[selectionLens(selected)])}>Open record lens</Button><Button size="compact-xs" variant="subtle" color="gray" onClick={()=>workspace.setSelectedRecord(null)}>Clear selection</Button></> : <Text size="sm" c="#5b6980">Select evidence to keep it across lenses.</Text>}</div>
    <Group gap="xs">{workspace.comparisonIds.length>0 && <Text size="sm">{workspace.comparisonIds.length} comparison accounts</Text>}<Button size="compact-sm" variant="subtle" onClick={()=>{setMode(selected?'selected':workspace.comparisonIds.length?'comparison':canExportPopulation?'population':null);setError(null);setManifest(null);setOpen(true);}}>Export evidence</Button></Group>
    <Modal title="Export recorded evidence" opened={open} onClose={()=>{if(!busy)setOpen(false);}} closeButtonProps={{'aria-label':'Close evidence export'}}>
      <Stack><Select label="Evidence scope" value={mode} onChange={setMode} allowDeselect={false} data={[{value:'selected',label:selected?.kind==='economics-group'?'Selected cohort in shared scope':'Exact selected record',disabled:!selected},{value:'population',label:`Complete filtered ${lens} population`,disabled:!canExportPopulation},{value:'comparison',label:'Selected comparison accounts',disabled:!workspace.comparisonIds.length}]}/>{!canExportPopulation && <Text size="sm" c="#5b6980">Capacity exports the chosen account or comparison accounts. Select an account before exporting its current persisted quota evidence.</Text>}<Text size="sm">Exports use one committed read snapshot. Exact record identities ignore current filters. Selected cohorts and population exports apply the fixed shared scope and recorded lens filters. Maximum 5,000 records and 8 MiB; larger exports are refused without a partial file.</Text><Text size="sm" c="#5b6980">The file includes source, UTC boundaries, coverage, completeness and measurement caveats. It excludes credentials, request bodies and private identity hashes.</Text>{error&&<Alert color="red" title="Export not produced">{error}</Alert>}{manifest&&<Alert color="teal" title="Evidence exported">{manifest.returnedRecords} of {manifest.totalRecords} matching records. {manifest.missingSelection?'The exact selected identity was not retained.':'Complete export.'}</Alert>}<Button loading={busy} disabled={!mode} onClick={download}>Download JSON evidence</Button></Stack>
    </Modal>
  </div>;
}
