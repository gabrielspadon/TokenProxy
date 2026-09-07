'use client';
import { useState } from 'react';
import { Alert, Button, Group, NativeSelect, Stack, Text, TextInput } from '@mantine/core';
import { useResource } from '@/shared/workspace/useResource';
import { call } from '@/shared/api';
import styles from './policy.module.css';
const classes = ['simple', 'coding', 'reasoning'];
const show = value => value || 'Use catalog ranking';
export function AutoRouting() {
  const resource = useResource('/api/admin/auto-routing');
  const [draft, setDraft] = useState(null), [review, setReview] = useState(false), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [conflict, setConflict] = useState(false), [feedback, setFeedback] = useState(null), [receipt, setReceipt] = useState(null);
  const values = draft?.rules || resource.data?.rules || {};
  const valid = classes.every(key => !values[key] || typeof values[key] === 'string' && values[key].indexOf('/') > 0 && !values[key].endsWith('/') && !/\s/.test(values[key]) && values[key].length <= 512);
  function discard() { setDraft(null); setReview(false); setBlocked(false); setConflict(false); }
  async function refreshRules() {
    if (busy) return;
    if (!draft || blocked) { resource.refresh(); return; }
    setBusy(true);
    const current = await call('/api/admin/auto-routing');
    if (current.ok && current.body?.currentHash && current.body?.rules) {
      setDraft(previous => previous && ({ ...previous, before: current.body }));
      setReview(false); setConflict(false);
      setFeedback({ error: false, message: 'Latest saved rules loaded. Your intended rules are retained. Review the updated before and after values before saving.' });
    } else {
      setFeedback({ error: true, message: 'Latest rules could not be read. Your draft is retained; refresh successfully before reviewing again.' });
      setReview(false); setConflict(true);
    }
    resource.refresh(); setBusy(false);
  }
  async function save() {
    if (busy || blocked || conflict || !review || !draft || !valid) return;
    setBusy(true); setFeedback(null);
    const result = await call('/api/admin/auto-routing', { method: 'POST', body: { rules: Object.fromEntries(classes.map(key => [key, draft.rules[key] || null])), expectedCurrent: draft.before.currentHash } });
    if (!result.ok) { setFeedback({ error: true, message: result.status === 409 ? 'Rules changed after review. Refresh and review your retained draft again.' : 'Rules were not confirmed. Inspect current state before another mutation.' }); if (result.status === 409) { setConflict(true); setReview(false); } setBlocked(result.status === 0 || result.status >= 500); setBusy(false); return; }
    const current = await call('/api/admin/auto-routing'), retained = result.body.receipt ? await call(`/api/admin/auto-routing/receipts/${result.body.receipt.id}`) : null;
    const confirmed = result.status !== 207 && result.body.persistence === 'confirmed' && current.ok && current.body.currentHash === result.body.currentHash && (!result.body.receipt || retained?.ok && retained.body.afterHash === result.body.currentHash);
    setFeedback({ error: !confirmed, message: confirmed ? 'Automatic routing rules saved and verified.' : 'Rules accepted, but persisted readback is incomplete. Inspect current state before another mutation.' });
    setReceipt(retained?.ok ? retained.body : result.body.receipt || null);
    if (confirmed) discard(); else setBlocked(true);
    resource.refresh(); setBusy(false);
  }
  async function inspect(id) {
    const result = await call(`/api/admin/auto-routing/receipts/${id}`);
    if (result.ok) setReceipt(result.body); else setFeedback({ error: true, message: 'The exact retained receipt could not be read.' });
  }
  return <section className={styles.simulator} aria-labelledby="automatic-routing-title"><Stack gap="md">
    <Group justify="space-between"><h2 id="automatic-routing-title">Automatic routing</h2><Button variant="default" disabled={busy} onClick={refreshRules}>Refresh rules</Button></Group>
    <Text>Clients request <code>auto-router</code>, <code>tokenproxy/auto</code> or <code>tokenproxy/auto-router</code>. The bare model name <code>auto</code> keeps its existing provider meaning.</Text>
    <Text>Tool requests classify as coding. Long prompts and reasoning cues classify as reasoning; short text without those cues classifies as simple. Unconfigured classes use price tiers from the local catalog. A missing published price remains unpriced.</Text>
    <Text>Each explicit provider/model target wins before catalog ranking, then uses normal account admission. A configured target does not establish availability, permission, credentials or provider acceptance. No inference runs here.</Text>
    {resource.error && <Alert color="red" title="Automatic rules unavailable">{resource.error}</Alert>}{feedback && <Alert color={feedback.error ? 'orange' : 'teal'}>{feedback.message}</Alert>}
    {classes.map(key => <TextInput key={key} label={`${key[0].toUpperCase() + key.slice(1)} request target`} description="Exact provider/model, or blank for local catalog ranking." value={values[key] || ''} disabled={!resource.data || review || busy} onChange={event => { const value = event.currentTarget.value; setDraft(previous => ({ before: previous?.before || resource.data, rules: { ...(previous?.rules || resource.data.rules), [key]: value } })); }} />)}
    {!valid && <Alert color="orange">Use provider/model targets without whitespace.</Alert>}
    {draft && !review && <Button disabled={!valid || conflict || busy} onClick={() => setReview(true)}>Review automatic rules</Button>}
    {review && <div><h3>Review automatic routing changes</h3><dl>{classes.map(key => <div key={key}><dt>{key}</dt><dd>{show(draft.before.rules[key])} → {show(draft.rules[key])}</dd></div>)}</dl><p>New requests take these targets. In-flight work retains its target. Restore the previous values here to reverse future behavior; routing-plan rollback excludes these rules.</p><Button loading={busy} disabled={blocked || !valid} onClick={save}>Save automatic rules</Button></div>}
    {draft && <Button variant="subtle" disabled={busy} onClick={discard}>Discard rules draft and use latest read</Button>}
    <NativeSelect label="Recent automatic routing change" value={receipt?.id || ''} data={[{ value: '', label: 'Choose retained change' }, ...(resource.data?.receipts || []).map(row => ({ value: row.id, label: `${row.createdAt} · ${row.id.slice(0,8)}` }))]} onChange={event => event.currentTarget.value ? inspect(event.currentTarget.value) : setReceipt(null)} />
    {receipt && <div><p><code>{receipt.id}</code> · {receipt.createdAt}</p><p>{receipt.scope}</p><dl>{classes.map(key => <div key={key}><dt>{key}</dt><dd>{show(receipt.before[key])} → {show(receipt.after[key])}</dd></div>)}</dl></div>}
    <Text size="sm">The most recent 20 receipts are listed. Exact receipt IDs remain readable after they leave this list.</Text>
  </Stack></section>;
}
