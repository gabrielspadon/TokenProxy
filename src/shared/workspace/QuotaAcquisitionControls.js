'use client';
import { useState } from 'react';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useResource } from './useResource';
import { useWorkspace } from './WorkspaceProvider';
import { QUOTA_AUTOPING_SETTINGS_KEY_BY_PROVIDER, quotaAutoPingSupportsAuthType, quotaAutoPingTooltip } from '@/shared/constants/config';
import { readJson } from '@/shared/components/workspace/economicsToolsModel';
import styles from './quotaHistoryWorkbench.module.css';

export function QuotaAcquisitionControls({ account }) {
  const {snapshot,observeSnapshot,refresh}=useWorkspace();
  const settings=useResource('/api/settings',{onSnapshot:observeSnapshot});
  const connection=useResource(`/api/providers/${encodeURIComponent(account.connectionId)}`,{onSnapshot:observeSnapshot});
  const [review,setReview]=useState(null), [pending,setPending]=useState(false), [error,setError]=useState(null), [notice,setNotice]=useState(null), [stored,setStored]=useState(null);
  const key=QUOTA_AUTOPING_SETTINGS_KEY_BY_PROVIDER[account.provider];
  const supported=quotaAutoPingSupportsAuthType(account.provider,connection.data?.connection?.authType);
  const enabled=stored ?? settings.data?.[key]?.connections?.[account.connectionId]===true;
  const isolated=snapshot?.isolated===true;
  async function apply() {
    setPending(true);setError(null);setNotice(null);
    try {
      if (review==='read') {
        const result=await readJson(`/api/usage/${encodeURIComponent(account.connectionId)}`);
        if(result.error || result.message) setNotice(`Provider quota read returned. ${result.error || result.message}`);
        else setNotice('Provider quota read completed. Refresh retained observations to inspect the recorded result.');
      } else {
        const desired=!enabled;
        await readJson('/api/settings',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({[key]:{connections:{[account.connectionId]:desired}}})});
        const current=await readJson('/api/settings');
        if ((current[key]?.connections?.[account.connectionId]===true)!==desired) throw new Error('Stored warming state differs from the requested change. Reload before retrying.');
        setStored(desired);setNotice(`Quota warming read back as ${desired?'enabled':'disabled'} for this account.`);
      }
      setReview(null);refresh();
    } catch(failure){setError(failure.message);} finally{setPending(false);}
  }
  return <section className={styles.workbench} aria-label="Quota acquisition"><Stack gap="sm">
    <h3>Acquire quota observations</h3>
    <Text size="sm" c="dimmed">Dashboard refresh reads retained evidence. A provider quota read may contact the upstream service and refresh credentials. Warming sends small inference requests after reset and consumes quota.</Text>
    <Text size="sm">Quota warming · {settings.error || connection.error ? 'State unavailable' : !supported ? 'Unsupported for this account authentication type' : enabled?'Enabled':'Disabled (default)'}</Text>
    {supported && <Text size="sm" c="dimmed">{quotaAutoPingTooltip(account.provider)}</Text>}
    {isolated && <Text size="sm" c="dimmed">Provider actions are unavailable in this isolated fixture. The recorded observations remain available below.</Text>}
    {(settings.error || connection.error) && <Alert color="red">Configuration could not be read. {settings.error || connection.error}</Alert>}
    {error && <Alert color="red" role="alert">{error}</Alert>}{notice && <Alert color="teal" role="status">{notice}</Alert>}
    <Group><Button size="sm" variant="default" disabled={isolated || pending || !connection.data} onClick={()=>setReview('read')}>Read quota from provider</Button><Button size="sm" variant="default" disabled={isolated || pending || !supported || !settings.data || Boolean(settings.error)} onClick={()=>setReview('warming')}>{enabled?'Disable':'Enable'} quota warming</Button></Group>
    {review && <><Text size="sm">{review==='read'?`Contact the provider for account ${account.connectionId} now. This action may refresh its credentials and retain new quota observations.`:`${enabled?'Disable future warming requests':'Enable quota-consuming warming requests after reset'} for account ${account.connectionId}. Other accounts keep their settings. Turning warming off does not cancel a request already sent.`}</Text><Group><Button size="sm" loading={pending} disabled={isolated} onClick={apply}>Confirm {review==='read'?'provider quota read':'warming change'}</Button><Button size="sm" variant="default" disabled={pending} onClick={()=>setReview(null)}>Cancel</Button></Group></>}
  </Stack></section>;
}
