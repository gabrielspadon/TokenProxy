'use client';
import { useState } from 'react';
import { Alert, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { call } from '@/shared/api';
import { bulkReadbackMatches, parseBulkOverrides, reviewBulkOverrides } from './bulkModel';
const show = value => value === null ? 'No saved key' : `${value.toLocaleString('en-US')} tokens`;
export function BulkOverrides({ overrides, disabled, onReadback }) {
  const [open, setOpen] = useState(false), [setText, setSetText] = useState(''), [removeText, setRemoveText] = useState(''), [review, setReview] = useState(null), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [notice, setNotice] = useState(null);
  function prepare() {
    try { setReview(reviewBulkOverrides(parseBulkOverrides(setText, removeText), overrides)); setNotice(null); }
    catch (error) { setNotice({ error: true, text: error.message }); }
  }
  async function save() {
    if (!review || busy || uncertain) return;
    setBusy(true); setNotice(null);
    const result = await call('/api/model-context', { method: 'POST', body: review });
    if (!result.ok || result.body?.success !== true) {
      setNotice({ error: true, text: result.status === 409 ? 'A reviewed key changed. Refresh configuration and review this retained draft again.' : 'The bulk change was not confirmed. Read current settings before another change.' });
      setUncertain(result.status === 0 || result.status >= 500); setBusy(false); return;
    }
    const read = await call('/api/model-context');
    if (read.ok) onReadback(read.body);
    const confirmed = result.status !== 207 && result.body.persistence === 'confirmed' && read.ok && bulkReadbackMatches(review, read.body?.overrides);
    setNotice({ error: !confirmed, text: confirmed ? `${review.set.length} set and ${review.deleteKeys.length} remove operations saved and verified. Unrelated keys were preserved.` : 'The change was accepted, but persisted readback is incomplete. Inspect current settings before another change.' });
    if (confirmed) { setReview(null); setSetText(''); setRemoveText(''); } else setUncertain(true);
    setBusy(false);
  }
  return <section className="model-context-bulk"><Button variant="default" disabled={disabled || busy} aria-expanded={open} aria-controls={open ? "model-context-bulk-editor" : undefined} onClick={() => setOpen(value => !value)}>{open ? 'Hide bulk editor' : 'Edit several overrides'}</Button>{open && <div id="model-context-bulk-editor"><Stack gap="md">
    <h2>Edit several context-window overrides</h2>
    <Text>Exact keys retain their matching order. Provider-scoped, bare and wildcard keys can affect different populations. This changes configured limits for later requests, not provider entitlement or client compaction policy.</Text>
    {notice && <Alert color={notice.error ? 'orange' : 'teal'}>{notice.text}</Alert>}
    <Textarea label="Overrides to set" description="One exact key = token limit per line." minRows={4} value={setText} disabled={disabled || busy || uncertain} onChange={event => { setSetText(event.currentTarget.value); setReview(null); }} placeholder={'openai/example-model = 128000\nexample-* = 64000'} />
    <Textarea label="Override keys to remove" description="One exact saved key per line. Removing exposes the next matching rule or default." minRows={3} value={removeText} disabled={disabled || busy || uncertain} onChange={event => { setRemoveText(event.currentTarget.value); setReview(null); }} />
    {review ? <><h3>Review exact key changes</h3><div className="model-context-bulk-review" role="region" aria-label="Reviewed context override changes" tabIndex={0}><dl>{review.set.map(item => <div key={item.key}><dt><code>{item.key}</code></dt><dd>{show(review.expectedOverrides[item.key])} → {show(item.contextWindow)}</dd></div>)}{review.deleteKeys.map(key => <div key={key}><dt><code>{key}</code></dt><dd>{show(review.expectedOverrides[key])} → Remove saved key</dd></div>)}</dl></div><Text>Only these keys are checked and changed together. Concurrent changes to a reviewed key are refused; concurrent sibling keys remain. Restore these previous values to reverse future behavior. The readback is not a retained change-history service.</Text><Group><Button loading={busy} disabled={disabled || uncertain} onClick={save}>Save reviewed overrides</Button><Button variant="default" disabled={busy} onClick={() => { setReview(null); setUncertain(false); }}>Return to retained draft</Button></Group></> : <Button disabled={disabled || busy || uncertain} onClick={prepare}>Review exact keys</Button>}
  </Stack></div>}</section>;
}
