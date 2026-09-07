'use client';
import { useState } from 'react';
import { Alert, Button, Group, Modal, Table, Text, TextInput } from '@mantine/core';
import { useResource } from '@/shared/workspace/useResource';
import { policyRequest, shortHash, utcTime } from './policyModel';
import styles from './policy.module.css';

const ENDPOINT = '/api/routing-cascade';
export function CascadePolicy() {
  const resource = useResource(ENDPOINT);
  const [draft, setDraft] = useState(null), [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(null);
  const [receipt, setReceipt] = useState(null), [uncertain, setUncertain] = useState(false);
  const pairs = draft?.pairs ?? resource.data?.pairs ?? [];
  const edit = value => setDraft({ pairs: value, revision: draft?.revision ?? resource.data.revision });
  async function refresh() {
    setBusy(true); setFailure(null);
    try {
      const state = await policyRequest(ENDPOINT);
      setDraft({ pairs: state.pairs, revision: state.revision });
      setReceipt(state.receipts?.[0] ?? null); setUncertain(false); setReview(null); resource.refresh();
    } catch (error) { setFailure(error.message); } finally { setBusy(false); }
  }
  async function apply() {
    if (!review) return;
    setBusy(true); setFailure(null); setUncertain(true);
    try {
      const result = await policyRequest(ENDPOINT, 'PUT', { pairs: review.pairs, expectedRevision: review.revision });
      setReceipt(result.receipt); setReview(null);
      const current = await policyRequest(ENDPOINT);
      if (current.revision !== result.revision) throw new Error('The active cascade differs from the recorded result. Read current policy and receipts before another change.');
      setDraft(null); setUncertain(false); resource.refresh();
    } catch (error) {
      setReview(null);
      setFailure(`${error.message} Read current policy and receipts before another change. This operation is not replayed.`);
    } finally { setBusy(false); }
  }
  const changed = draft && JSON.stringify(draft.pairs) !== JSON.stringify(resource.data?.pairs);
  return <section className={styles.surface} aria-label="Solo chat cascade policy"><div className={styles.panelBody}>
    <div className={styles.sectionHead}><h2>Solo chat cascade</h2><span className={styles.mono}>Active {shortHash(resource.data?.revision)}</span></div>
    <Text size="sm">An exact requested strong model can use its paired model for exploration steps. Empty pairs keep this feature off. This global policy is separate from plan activation and restoration.</Text>
    {resource.error && <Alert color="red" title="Cascade unavailable">{resource.error}</Alert>}
    {failure && <Alert color="red" title="Cascade change not verified" mt="sm">{failure}</Alert>}
    {resource.loading && !resource.data && <Text role="status">Reading cascade policy…</Text>}
    <dl className={styles.cascadeFacts}>
      <div><dt>Applies to</dt><dd>Solo chat at the original requested model. Combo members, virtual auto routing and capability-adapter substitutes bypass cascade planning.</dd></div>
      <div><dt>Exploration threshold</dt><dd>Serialized request estimate strictly below {resource.data?.limits?.promptEstimateExclusive?.toLocaleString('en') ?? 'Unknown'} tokens, at {resource.data?.limits?.charactersPerEstimatedToken ?? 'Unknown'} UTF-16 code units per estimated token. No recent tool error and no edit/write call or Bash heredoc in the latest assistant turn.</dd></div>
      <div><dt>Escalation</dt><dd>HTTP 408, 429 or 5xx from the paired dispatch retries the same body on the strong model. Other 4xx responses do not escalate. This can create an additional physical attempt.</dd></div>
      <div><dt>Strong-model continuity</dt><dd>{resource.data?.limits ? resource.data.limits.escalationPinMs / 60000 : 'Unknown'} minutes from escalation, in this process, when a session identity exists. It is separate from account affinity. Changing pairs does not clear these pins.</dd></div>
      <div><dt>Identity and eligibility</dt><dd>Pairs match request spelling after colon/slash normalization, before catalog alias resolution. Configure the caller’s exact model spelling. The usual account, access, limits and reasoning policies still apply. Configuration does not verify model support or entitlement.</dd></div>
    </dl>
    {resource.data?.ignoredOrMergedEntries > 0 && <Alert color="orange" title="Stored entries need attention">{resource.data.ignoredOrMergedEntries} stored entries are ignored or merged by the engine. The table shows its effective pairs. Saving replaces that pair list.</Alert>}
    <Table.ScrollContainer minWidth={620}><Table aria-label="Cascade pair mapping"><Table.Thead><Table.Tr><Table.Th>Requested strong model</Table.Th><Table.Th>Exploration model</Table.Th><Table.Th>Action</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {pairs.map((pair,index)=><Table.Tr key={index}><Table.Td><TextInput aria-label={`Strong model ${index+1}`} value={pair.strong} disabled={busy || uncertain} onChange={event=>edit(pairs.map((item,i)=>i===index ? {...item,strong:event.currentTarget.value} : item))} /></Table.Td><Table.Td><TextInput aria-label={`Exploration model ${index+1}`} value={pair.cheap} disabled={busy || uncertain} onChange={event=>edit(pairs.map((item,i)=>i===index ? {...item,cheap:event.currentTarget.value} : item))} /></Table.Td><Table.Td><Button variant="subtle" disabled={busy || uncertain} onClick={()=>edit(pairs.filter((_,i)=>i!==index))}>Remove pair {index+1}</Button></Table.Td></Table.Tr>)}
    </Table.Tbody></Table></Table.ScrollContainer>
    {!pairs.length && <Text py="md">No configured pairs. Cascade is off.</Text>}
    <Group mt="md"><Button variant="default" disabled={!resource.data || busy || uncertain || pairs.length >= 64} onClick={()=>edit([...pairs,{strong:'',cheap:''}])}>Add cascade pair</Button><Button disabled={!changed || busy || uncertain} onClick={()=>setReview(structuredClone(draft))}>Review cascade change</Button><Button variant="subtle" disabled={busy} onClick={refresh}>Read current policy and receipts</Button></Group>
    <Text size="sm" mt="xs">Editing is local until reviewed and saved. Reading current policy replaces local edits. The server rejects stale revisions. Restore a previous mapping by editing these pairs; plan rollback excludes cascade.</Text>
    {receipt && <div className={styles.notice} role="status"><strong>{uncertain ? 'Receipt retained; current state unverified' : 'Cascade policy read back and verified'}</strong><span>{receipt.id} · {receipt.outcome} · {utcTime(receipt.recordedAt)}</span><span>Subsequent requests use the mapping. In-flight work and existing escalation pins remain on their current path.</span></div>}
    {resource.data?.receipts?.length > 0 && <details className={styles.receiptDetails}><summary>Recent cascade receipts and mappings</summary><pre tabIndex={0}>{JSON.stringify(resource.data.receipts,null,2)}</pre></details>}
    <Modal opened={Boolean(review)} onClose={()=>!busy && setReview(null)} title="Review cascade mapping" size="lg">
      {review && <><Text>Only the global cascade pair list changes. Later solo requests may use another physical model and create additional attempts. Account affinity, in-flight requests and routing-plan versions remain unchanged.</Text><pre className={styles.cascadeDiff} tabIndex={0}>{JSON.stringify({before:resource.data?.pairs,after:review.pairs},null,2)}</pre><Text size="sm">Expected revision {shortHash(review.revision)}. Operator authentication and a loopback origin are required.</Text><Group justify="end" mt="md"><Button variant="default" disabled={busy} onClick={()=>setReview(null)}>Cancel</Button><Button loading={busy} disabled={uncertain} onClick={apply}>Save cascade mapping</Button></Group></>}
    </Modal>
  </div></section>;
}
