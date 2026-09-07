'use client';
import { useState } from 'react';
import { Alert, Button, Modal, Select, Stack, Text } from '@mantine/core';
import { useWorkspace } from './WorkspaceProvider';

export function ObservationControls() {
  const { observations, scope, snapshot, setScope, refresh } = useWorkspace();
  const [open,setOpen] = useState(false);
  const [next,setNext] = useState('summary');
  const label = snapshot ? 'Snapshot' : observations.historical ? 'Historical' : observations.mode === 'live' ? 'Live' : observations.mode === 'paused' ? 'Paused' : 'Summary';
  function apply() {
    if (next === 'live' && !snapshot) {
      if (scope.start || scope.end) setScope({period:'all',start:null,end:null});
      observations.setMode('live');
      refresh();
    } else observations.setMode(next);
    setOpen(false);
  }
  return <>
    <Button data-observation-control variant="default" size="compact-sm" aria-label={`Observation mode: ${label}`} onClick={()=>{setNext(observations.mode);setOpen(true);}}>Updates · {label}</Button>
    <Modal opened={open} onClose={()=>setOpen(false)} title="Workspace observations" closeButtonProps={{'aria-label':'Close observation settings'}}>
      <Stack>
        <Select label="Update behavior" value={next} onChange={setNext} allowDeselect={false} data={[{value:'summary',label:'Summary · read on navigation or refresh'},{value:'live',label:'Follow live · refresh visible evidence',disabled:Boolean(snapshot)},{value:'paused',label:'Pause background updates'}]}/>
        <Text size="sm">Summary reads each visible source when it is opened. Live refreshes visible retained evidence on bounded intervals and reconnects supported streams. Pausing closes those streams and stops background reads. Selecting another record or explicitly refreshing still reads its evidence.</Text>
        <Text size="sm">Each source keeps its own observation age. Resuming re-reads current state; events that were not retained during a pause cannot be recovered. Dashboard refresh does not request provider authentication or inference.</Text>
        {snapshot && <Alert color="gray" title="Fixed isolated snapshot">Live updates are unavailable for this captured dataset. Permitted local changes can be verified with an explicit refresh.</Alert>}
        {next==='live' && (scope.start || scope.end) && <Alert color="indigo" title="Return to current evidence">Following live clears the fixed UTC range and includes newly retained records. Provider, account, model and selected evidence remain unchanged.</Alert>}
        {observations.pausedAt && <Text size="sm">Background reads paused at <time dir="ltr" data-i18n-skip dateTime={observations.pausedAt}>{observations.pausedAt}</time>.</Text>}
        <Button onClick={apply}>Apply observation behavior</Button>
      </Stack>
    </Modal>
  </>;
}
