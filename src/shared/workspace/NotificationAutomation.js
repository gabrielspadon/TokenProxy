'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Group, Loader, NumberInput, Switch, Text } from '@mantine/core';
import { useResource } from './useResource';
import { ruleTimestamp } from './notificationRulesModel';
import styles from './notificationRules.module.css';

const ENDPOINT='/api/admin/notification-actions';
async function command(body) {
  const response=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json();
  if (!response.ok || value.persistence==='unconfirmed') throw new Error(value.error || value.receipt?.reasonCode?.replaceAll('_',' ') || 'Action was not confirmed.');
  return value;
}
function PolicyForm({ rule, policy, effect, refresh }) {
  const [draft,setDraft]=useState(()=>({ruleId:rule.id,ruleRevision:rule.revision,expectedRevision:policy?.revision||0,
    action:'drain-account',enabled:policy?.enabled||false,cooldownSeconds:policy?.cooldownSeconds||3600,dailyLimit:policy?.dailyLimit||1,maxEvidenceAgeSeconds:policy?.maxEvidenceAgeSeconds||300}));
  const [busy,setBusy]=useState(false),[feedback,setFeedback]=useState(null),[preview,setPreview]=useState(null);
  const set=patch=>{setDraft(old=>({...old,...patch}));setPreview(null);setFeedback(null);};
  const run=async action=>{
    setBusy(true);setFeedback(null);
    try {
      const receipt=await command({action,policy:draft});
      if (action==='preview-policy') setPreview(receipt);
      else {
        const response=await fetch(`${ENDPOINT}?ruleId=${encodeURIComponent(rule.id)}`,{cache:'no-store'}),stored=await response.json();
        if (!response.ok || stored.policy?.revision!==receipt.policy.revision) throw new Error('The saved revision could not be read back. Refresh before another change.');
        setDraft(old=>({...old,expectedRevision:stored.policy.revision}));
        setFeedback({ok:true,text:`Revision ${stored.policy.revision} saved and read back. ${stored.policy.enabled?'Only later alerts may drain this account.':'Automatic draining is off.'}`});
        refresh();
      }
    } catch(error) {setFeedback({ok:false,text:`${error.message} No automatic retry was sent.`});}
    finally {setBusy(false);}
  };
  return <form className={styles.automationForm} aria-label="Account automation policy" onSubmit={event=>{event.preventDefault();run('save-policy');}}>
    <Group justify="space-between" gap="xs"><h4>Automatic drain</h4><Switch size="xs" label="Allow automatic drain" checked={draft.enabled} disabled={busy||!rule.enabled} onChange={event=>set({enabled:event.currentTarget.checked})}/></Group>
    <p className={styles.note}>{effect}</p>
    <p className={styles.note}>Applies only to <Link href={`/dashboard/connections?account=${encodeURIComponent(rule.scopeId)}`}>{rule.scopeId}</Link>, from rule revision {rule.revision}. Maximum 20 actions across all rules per rolling day.</p>
    {policy?.enabled && policy.ruleRevision!==rule.revision && <Alert color="orange">The rule changed. The saved action is suspended until you save its new authority.</Alert>}
    {!rule.enabled && <Text size="xs">Enable and save this rule before enabling its account action.</Text>}
    <div className={styles.automationFields}>
      <NumberInput size="xs" label="Action cooldown (seconds)" value={draft.cooldownSeconds} min={60} max={86400} step={60} decimalScale={0} onChange={value=>set({cooldownSeconds:value})}/>
      <NumberInput size="xs" label="Maximum actions per day" value={draft.dailyLimit} min={1} max={10} decimalScale={0} onChange={value=>set({dailyLimit:value})}/>
      <NumberInput size="xs" label="Maximum alert age (seconds)" value={draft.maxEvidenceAgeSeconds} min={60} max={3600} step={60} decimalScale={0} onChange={value=>set({maxEvidenceAgeSeconds:value})}/>
    </div>
    <Group gap="xs"><Button type="submit" size="xs" loading={busy}>Save action policy</Button><Button type="button" variant="light" size="xs" disabled={busy} onClick={()=>run('preview-policy')}>Simulate on alert history</Button></Group>
    {feedback && <Text role={feedback.ok?'status':'alert'} size="xs" c={feedback.ok?'dimmed':'orange'}>{feedback.text}</Text>}
    {preview && <section aria-label="Automation simulation"><Text size="xs" fw={600}>{preview.history.filter(row=>row.simulation.outcome==='drain').length} simulated drains · {preview.history.length} retained alerts</Text>
      <ul className={styles.note}>{preview.assumptions.map(text=><li key={text}>{text}</li>)}</ul>
      {preview.coverage.hasMore && <Text size="xs">Only the latest {preview.coverage.limit} alerts are included.</Text>}
      <ol className={styles.audit}>{preview.history.map(row=><li key={row.eventId}>{ruleTimestamp(row.firedAt)} UTC · {row.simulation.reasonCode?.replaceAll('_',' ')||'Would drain in this scenario'}</li>)}</ol>
      <Text size="xs">Simulation only. No historical alert is queued or executed.</Text>
    </section>}
  </form>;
}
function ActionHistory({ ruleId, refreshPolicy }) {
  const [cursor,setCursor]=useState(null),[feedback,setFeedback]=useState(null),[busy,setBusy]=useState(null);
  const resource=useResource(`${ENDPOINT}?ruleId=${encodeURIComponent(ruleId)}&limit=10${cursor?`&before=${encodeURIComponent(cursor)}`:''}`,{interval:0});
  async function rollback(action) {
    setBusy(action.id);setFeedback(null);
    try {
      const result=await command({action:'rollback',actionId:action.id,expectedAfterState:action.afterState});
      const response=await fetch(`${ENDPOINT}?actionId=${encodeURIComponent(action.id)}`,{cache:'no-store'}),stored=await response.json();
      if (!response.ok || stored.action?.state!==result.state) throw new Error('Rollback could not be read back.');
      setFeedback({ok:true,text:'Account restored. The rollback receipt is retained; running responses were not moved.'});
    } catch(error){setFeedback({ok:false,text:`${error.message} Newer account changes are preserved. Refresh before retrying.`});}
    finally {setBusy(null);resource.refresh();refreshPolicy();}
  }
  return <section className={styles.automationHistory} aria-label="Account action history">
    <Group justify="space-between"><h4>Action history</h4><Button size="xs" variant="subtle" onClick={resource.refresh}>Refresh actions</Button></Group>
    {resource.error && <Alert color="orange">{resource.error}</Alert>}
    {resource.loading && <Loader size="sm"/>}
    {resource.data?.items.length===0 && <p className={styles.note}>No actions recorded for this rule. Existing alerts are never replayed when an action is enabled.</p>}
    <ol className={styles.audit}>{resource.data?.items.map(action=><li key={action.id}>
      <Group justify="space-between" gap="xs"><span>{ruleTimestamp(action.createdAt)} UTC · {action.state}</span>{action.state==='applied'&&<Button size="xs" variant="light" loading={busy===action.id} disabled={Boolean(busy)} onClick={()=>rollback(action)}>Undo this drain</Button>}</Group>
      {action.reasonCode && <Text size="xs">{action.reasonCode.replaceAll('_',' ')}</Text>}
      <Link href={`/dashboard/notifications?event=${encodeURIComponent(action.eventId)}`}>Triggering alert</Link>
      <details><summary>Policy and action receipt</summary><ActionReceipt id={action.id} revision={action.updatedAt}/></details>
    </li>)}</ol>
    {feedback&&<Text size="xs" role={feedback.ok?'status':'alert'}>{feedback.text}</Text>}
    <Group gap="xs">{cursor&&<Button size="xs" variant="subtle" onClick={()=>setCursor(null)}>Latest actions</Button>}{resource.data?.next&&<Button size="xs" variant="subtle" onClick={()=>setCursor(resource.data.next)}>Older actions</Button>}</Group>
  </section>;
}
function ActionReceipt({ id, revision }) {
  const resource=useResource(`${ENDPOINT}?actionId=${encodeURIComponent(id)}`,{interval:0});
  return <div data-revision={revision}>{resource.error?<Text role="alert" size="xs">{resource.error}</Text>:resource.loading?<Loader size="xs"/>:<ol className={styles.audit}>{resource.data?.action.receipts.map(row=><li key={row.id}>{ruleTimestamp(row.createdAt)} UTC · {row.operation} · {row.outcome}{row.reasonCode?` · ${row.reasonCode.replaceAll('_',' ')}`:''}</li>)}</ol>}</div>;
}
export function NotificationAutomation({ rule }) {
  const resource=useResource(`${ENDPOINT}?ruleId=${encodeURIComponent(rule.id)}&limit=1`,{interval:0});
  if (rule.scopeKind!=='connection') return <p className={styles.note}>Automatic drain requires a rule scoped to one account.</p>;
  return <section className={styles.automation} aria-label="Bounded account automation">
    {resource.error&&<Alert color="orange">{resource.error}</Alert>}
    {resource.loading&&<Loader size="sm"/>}
    {resource.data&&(resource.data.conditions.includes(rule.conditionKind)?<>
      <PolicyForm key={rule.id+':'+rule.revision} rule={rule} policy={resource.data.policy} effect={resource.data.effect} refresh={resource.refresh}/>
      <ActionHistory key={rule.id} ruleId={rule.id} refreshPolicy={resource.refresh}/>
    </>:<Text size="xs">This condition has no supported account action.</Text>)}
  </section>;
}
