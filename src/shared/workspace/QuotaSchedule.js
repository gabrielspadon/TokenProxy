'use client';
import { useState } from 'react';
import { Alert, Button, Group, Loader, Table, Text } from '@mantine/core';
import { useResource } from './useResource';
import { quotaTimestamp } from './quotaWorkbenchModel';

const reasons = { 'poll-not-before':'Periodic check', 'reset-not-before':'Near recorded reset',
  'probe-not-before':'Waiting for probe cooldown', 'verify-not-before':'Verify prior warming',
  'retry-not-before':'Failure cooldown' };

export function QuotaSchedule({ connectionId }) {
  return <AccountSchedule key={connectionId} connectionId={connectionId} />;
}

function AccountSchedule({ connectionId }) {
  const [history, setHistory] = useState(null);
  const resource = useResource(`/api/admin/quota/schedule?${new URLSearchParams({connectionId})}`);
  const rows = Array.isArray(resource.data?.items) ? resource.data.items : null;
  return <section aria-label="Current quota check schedule">
    <Group justify="space-between"><h4>Next account check</h4>
      <Button size="compact-sm" variant="subtle" onClick={resource.refresh}>Refresh schedule</Button></Group>
    <Text size="sm" c="dimmed">Current scheduling state, separate from the historical time range. Times are earliest eligibility, not guaranteed execution. Checks read metadata; warming requires its existing account opt-in.</Text>
    {resource.loading && <Loader size="sm" />}
    {resource.error && <Alert color="orange" title="Schedule unavailable">{resource.error}{rows && ' The table retains the last successful read and may be stale.'}</Alert>}
    {resource.data && !rows && <Alert color="orange" title="Schedule unavailable">The server returned an incomplete schedule response.</Alert>}
    {rows?.length === 0 && <Text size="sm">No retained schedule for this account.</Text>}
    {rows?.length > 0 && <Table.ScrollContainer minWidth={540} scrollAreaProps={{viewportProps:{tabIndex:0,role:"region","aria-label":"Scroll account quota schedule"}}}><Table aria-label="Account quota schedule">
      <Table.Thead><Table.Tr><Table.Th>State</Table.Th><Table.Th>Check after (UTC)</Table.Th><Table.Th>Reason</Table.Th><Table.Th>Last outcome</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{rows.map(row => <Table.Tr key={row.id}>
        <Table.Td>{row.status}{row.status === 'running' && <Text size="xs">Lease until {quotaTimestamp(row.leaseExpiresAt)} UTC</Text>}</Table.Td><Table.Td>{row.status === 'cancelled' ? 'Not scheduled' : quotaTimestamp(row.nextCheckAt)}</Table.Td>
        <Table.Td style={{whiteSpace:'normal',maxWidth:220,minWidth:160}}>{row.cancelReason || reasons[row.reason] || row.reason}{row.targets?.map((target,index)=><Text size="xs" style={{whiteSpace:'normal',overflowWrap:'anywhere'}} key={`${target.observationId || target.scope}:${index}`}>{target.scope || 'Unknown window'} · {target.unit || 'unknown unit'} · reset {quotaTimestamp(target.resetAt)} UTC{target.observationId && <> · observation {target.observationId}</>}</Text>)}</Table.Td><Table.Td style={{whiteSpace:'normal',minWidth:120}}>{row.lastOutcome || 'Not observed'}{row.finishedAt && <Text size="xs">{quotaTimestamp(row.finishedAt)} UTC</Text>}<Button size="compact-xs" variant="subtle" aria-label="View check history" onClick={()=>setHistory({id:row.id,provider:row.provider,asOf:resource.data.asOf})}>View history</Button></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    {resource.data?.asOf && <Text size="xs" c="dimmed">Schedule read {quotaTimestamp(resource.data.asOf)} UTC.</Text>}
    {history && <ScheduleHistory key={`${history.id}:${history.asOf}`} connectionId={connectionId} history={history} onClose={()=>setHistory(null)} />}
  </section>;
}

function ScheduleHistory({ connectionId, history, onClose }) {
  const [page,setPage] = useState(1);
  const query = new URLSearchParams({kind:'checks',connectionId,provider:history.provider,jobId:history.id,start:'1970-01-01T00:00:00.000Z',end:history.asOf,page:String(page),pageSize:'10'});
  const resource = useResource(`/api/admin/quota/history?${query}`,{interval:0});
  return <section aria-label="Scheduled check history">
    <Group justify="space-between"><h4>Retained scheduled check receipts</h4><Button variant="subtle" size="compact-sm" onClick={onClose}>Close check history</Button></Group>
    <Text size="sm">This exact account and schedule, through {quotaTimestamp(history.asOf)} UTC. The shared historical scope is unchanged.</Text>
    {resource.loading && <Text role="status">Reading scheduled check receipts…</Text>}
    {resource.error && <Alert color="orange" title="Check receipts unavailable">{resource.error}<Button variant="subtle" onClick={resource.refresh}>Retry check receipts</Button></Alert>}
    {resource.data && <>
      {!resource.data.items.length ? <Text>No retained check receipts for this schedule.</Text> : <Table.ScrollContainer minWidth={520} scrollAreaProps={{viewportProps:{tabIndex:0,role:"region","aria-label":"Scroll scheduled check receipts"}}}><Table aria-label="Scheduled check receipts"><Table.Thead><Table.Tr><Table.Th>Recorded · UTC</Table.Th><Table.Th>Event</Table.Th><Table.Th>Outcome / evidence</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{resource.data.items.map(event=><Table.Tr key={event.id}><Table.Td>{quotaTimestamp(event.capturedAt)}</Table.Td><Table.Td>{event.eventType}</Table.Td><Table.Td>{event.outcome || 'Unknown'}<Text size="xs">{event.code || 'No recorded reason'}</Text><Text size="xs" style={{overflowWrap:'anywhere'}}>Check {event.checkId}</Text>{event.observationId && <Text size="xs" style={{overflowWrap:'anywhere'}}>Observation {event.observationId}</Text>}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}
      <Group gap="sm"><Button variant="default" size="compact-sm" disabled={page===1 || resource.loading} onClick={()=>setPage(page-1)}>Previous check receipts</Button><Text size="sm" role="status">Page {page} · {resource.data.total} retained receipts</Text><Button variant="default" size="compact-sm" disabled={!resource.data.hasMore || resource.loading} onClick={()=>setPage(page+1)}>Next check receipts</Button></Group>
    </>}
  </section>;
}
