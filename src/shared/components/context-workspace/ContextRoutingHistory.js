'use client';
import { useState } from 'react';
import { Alert, Button, Group, SegmentedControl, Table } from '@mantine/core';
import { useResource } from '@/shared/workspace/useResource';
import { quantity, utc } from './contextModel';
import styles from './context.module.css';

export function ContextRoutingHistory({ sessionId, accountName, onSnapshot }) {
  const [kind,setKind] = useState('switches');
  return <section className={styles.routing}>
    <SegmentedControl aria-label="Routing history kind" value={kind} onChange={setKind}
      data={[{value:'switches',label:'Switch receipts'},{value:'pins',label:'Stored pins'}]} />
    <RoutingPage key={`${sessionId}:${kind}`} sessionId={sessionId} kind={kind} accountName={accountName} onSnapshot={onSnapshot} />
  </section>;
}

function RoutingPage({ sessionId, kind, accountName, onSnapshot }) {
  const [cursors,setCursors] = useState([null]), [index,setIndex] = useState(0);
  const query = new URLSearchParams({view:'routing',routingKind:kind,pageSize:'25'});
  if (cursors[index]) query.set('cursor',cursors[index]);
  const resource = useResource(`/api/context/sessions/${sessionId}?${query}`,{onSnapshot,interval:0});
  const data = resource.data, pins = kind==='pins';
  const next = () => { setCursors([...cursors.slice(0,index+1),data.pagination.nextCursor]); setIndex(index+1); };
  return <>
    <p className={styles.footnote}>{data?.scope || 'Routing history for this exact session is independent of the selected attempt interval.'}</p>
    {resource.loading && <p role="status">Reading session routing…</p>}
    {resource.error && <Alert color="orange" title="Routing history unavailable">{resource.error}<Button variant="subtle" onClick={resource.refresh}>Retry routing history</Button></Alert>}
    {data && <>
      <div className={styles.tableScroll} role="region" aria-label="Routing history scrollable table" tabIndex={0}>
        <Table className={styles.table} aria-label={pins ? 'Stored account pins' : 'Account switch receipts'}><Table.Thead><Table.Tr>
          <Table.Th>Model / account</Table.Th><Table.Th>{pins ? 'Pinned · UTC' : 'Switched · UTC'}</Table.Th><Table.Th>{pins ? 'Expiry · UTC' : 'Recorded reason'}</Table.Th>
        </Table.Tr></Table.Thead><Table.Tbody>{data.items.map(item=><Table.Tr key={pins ? item.model : item.id}>
          <Table.Td>{item.model}<small>{pins ? accountName(item.connectionId) : `${accountName(item.fromConnectionId)} → ${accountName(item.toConnectionId)}`}</small></Table.Td>
          <Table.Td>{utc(pins ? item.pinnedAt : item.switchedAt)}</Table.Td><Table.Td>{pins ? utc(item.expiresAt) : <>{item.trigger || 'Unknown'}<small>{item.reason}</small></>}</Table.Td>
        </Table.Tr>)}</Table.Tbody></Table>
      </div>
      {!data.items.length && <p>No retained {pins ? 'pins' : 'switch receipts'} on this page.</p>}
    </>}
      <Group gap={8} mt="sm"><Button variant="default" size="compact-sm" disabled={!index || resource.loading} onClick={()=>setIndex(index-1)}>Previous routing page</Button>
        <span role="status">Page {index+1} · {quantity(data?.pagination.totalItems)} retained {pins ? 'pins' : 'switches'}</span>
        <Button variant="default" size="compact-sm" disabled={!data?.pagination.hasMore || resource.loading} onClick={next}>Next routing page</Button>
        <Button variant="subtle" size="compact-sm" onClick={()=>{setCursors([null]);setIndex(0);resource.refresh();}}>Latest routing history</Button></Group>
  </>;
}
